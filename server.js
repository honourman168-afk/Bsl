const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

// DB_PATH lets you point at a mounted persistent disk/volume in production
// (Render Disks, Railway Volumes, etc.) so data survives redeploys.
// Example: DB_PATH=/data/bsl.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "bsl.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  match_time TEXT NOT NULL,
  deadline TEXT NOT NULL,
  home_points INTEGER NOT NULL DEFAULT 0,
  draw_points INTEGER NOT NULL DEFAULT 0,
  away_points INTEGER NOT NULL DEFAULT 0,
  home_score INTEGER,
  away_score INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  matchday INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_matchday INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  match_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, match_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(match_id) REFERENCES matches(id)
);
`);

// Migration: older databases created before the matchday feature won't have
// this column yet — add it if missing so existing data keeps working.
const matchesCols = db.prepare("PRAGMA table_info(matches)").all().map(c => c.name);
if (!matchesCols.includes("matchday")) {
  db.exec("ALTER TABLE matches ADD COLUMN matchday INTEGER NOT NULL DEFAULT 1");
}
db.prepare("INSERT OR IGNORE INTO app_state (id, current_matchday) VALUES (1, 1)").run();

function getCurrentMatchday() {
  return db.prepare("SELECT current_matchday FROM app_state WHERE id = 1").get().current_matchday;
}

const adminUser = process.env.ADMIN_USERNAME || "admin";
const adminPass = process.env.ADMIN_PASSWORD || "bsladmin123";

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.warn(
    "[WARNING] Using default admin credentials. Set ADMIN_USERNAME and ADMIN_PASSWORD " +
    "environment variables before going live."
  );
}

// Session secret used to sign short-lived admin tokens. If not set explicitly,
// a random one is generated at boot (fine for a single instance, but means
// existing admin sessions are invalidated on every restart/redeploy — set
// SESSION_SECRET in production to avoid that).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function signAdminToken() {
  const payload = Buffer.from(JSON.stringify({ u: adminUser, exp: Date.now() + ADMIN_SESSION_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (sig !== expected || sig.length !== expected.length) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.u === adminUser && typeof data.exp === "number" && Date.now() < data.exp;
  } catch {
    return false;
  }
}

// Trust the platform's reverse proxy (Render/Railway) so rate limiting and
// logging see the real client IP instead of the proxy's.
app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in a few minutes." },
});

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!verifyAdminToken(token)) {
    return res.status(401).json({ error: "Admin authentication required." });
  }
  next();
}

function isBeforeDeadline(match) {
  return new Date() < new Date(match.deadline) && match.status === "open";
}

function settleMatch(matchId) {
  const match = db.prepare("SELECT * FROM matches WHERE id=?").get(matchId);
  if (!match || match.home_score === null || match.away_score === null) return;

  const result =
    match.home_score > match.away_score ? "home" :
    match.home_score < match.away_score ? "away" : "draw";

  const predictions = db.prepare("SELECT * FROM predictions WHERE match_id=?").all(matchId);
  const updatePrediction = db.prepare("UPDATE predictions SET points_awarded=? WHERE id=?");
  const addPoints = db.prepare("UPDATE users SET points = points + ? WHERE id=?");

  const tx = db.transaction(() => {
    for (const p of predictions) {
      let earned = p.outcome === result
        ? (result === "home" ? match.home_points : result === "draw" ? match.draw_points : match.away_points)
        : 0;

      if (
        p.home_score !== null && p.away_score !== null &&
        p.home_score === match.home_score &&
        p.away_score === match.away_score
      ) earned += 6;

      updatePrediction.run(earned, p.id);
      if (earned) addPoints.run(earned, p.user_id);
    }
    db.prepare("UPDATE matches SET status='settled' WHERE id=?").run(matchId);
  });
  tx();
}

app.post("/api/register", authLimiter, (req, res) => {
  const { name, username, password } = req.body || {};
  if (!name || !username || !password || password.length < 4) {
    return res.status(400).json({ error: "Enter a name, username and password (4+ characters)." });
  }
  if (name.length > 60 || username.length > 40 || password.length > 200) {
    return res.status(400).json({ error: "One of the fields is too long." });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare("INSERT INTO users (name, username, password) VALUES (?,?,?)")
      .run(name.trim(), username.trim().toLowerCase(), hash);
    res.json({ id: info.lastInsertRowid, name: name.trim(), username: username.trim().toLowerCase() });
  } catch {
    res.status(409).json({ error: "That username is already in use." });
  }
});

app.post("/api/login", authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare("SELECT id,name,username,password,points FROM users WHERE username=?")
    .get(String(username || "").trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ""), user.password)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  res.json({ id: user.id, name: user.name, username: user.username, points: user.points
});

app.get("/api/matches", (req, res) => {
  const matches = db.prepare("SELECT * FROM matches ORDER BY match_time ASC").all();
  res.json(matches.map(m => ({...m, canPredict: isBeforeDeadline(m)})));
});

app.get("/api/leaderboard", (req, res) => {
  const currentMatchday = getCurrentMatchday();
  const rows = db.prepare(`
    SELECT id, name, username, points,
      RANK() OVER (ORDER BY points DESC, id ASC) AS rank
    FROM (
      SELECT u.id AS id, u.name AS name, u.username AS username,
        COALESCE(SUM(CASE WHEN m.matchday = ? THEN p.points_awarded ELSE 0 END), 0) AS points
      FROM users u
      LEFT JOIN predictions p ON p.user_id = u.id
      LEFT JOIN matches m ON m.id = p.match_id
      GROUP BY u.id
    ) sub
    ORDER BY points DESC, id ASC
  `).all(currentMatchday);
  res.json(rows);
});

app.get("/api/matchday", (req, res) => {
  res.json({ currentMatchday: getCurrentMatchday() });
});

app.post("/api/admin/matchday/advance", auth, (req, res) => {
  const next = getCurrentMatchday() + 1;
  db.prepare("UPDATE app_state SET current_matchday = ? WHERE id = 1").run(next);
  res.json({ currentMatchday: next });
});

app.get("/api/user/:id/predictions", (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: "Invalid user id." });
  const rows = db.prepare(`
    SELECT p.*, m.home_team,m.away_team,m.match_time,m.deadline,m.status,
           m.home_score AS result_home_score,m.away_score AS result_away_score
    FROM predictions p JOIN matches m ON m.id=p.match_id
    WHERE p.user_id=? ORDER BY m.match_time DESC
  `).all(userId);
  res.json(rows);
});

app.post("/api/predictions", (req, res) => {
  const { userId, matchId, outcome, homeScore, awayScore } = req.body || {};
  const user = db.prepare("SELECT id FROM users WHERE id=?").get(userId);
  const match = db.prepare("SELECT * FROM matches WHERE id=?").get(matchId);
  if (!user || !match) return res.status(404).json({ error: "User or match not found." });
  if (!isBeforeDeadline(match)) return res.status(400).json({ error: "The prediction deadline has passed." });
  if (!["home","draw","away"].includes(outcome)) return res.status(400).json({ error: "Choose a valid outcome." });
  if (!Number.isInteger(Number(homeScore)) || !Number.isInteger(Number(awayScore)) || Number(homeScore) < 0 || Number(awayScore) < 0) {
    return res.status(400).json({ error: "Enter valid score numbers." });
  }

  try {
    db.prepare(`
      INSERT INTO predictions (user_id,match_id,outcome,home_score,away_score)
      VALUES (?,?,?,?,?)
      ON CONFLICT(user_id,match_id) DO UPDATE SET
        outcome=excluded.outcome, home_score=excluded.home_score, away_score=excluded.away_score
    `).run(userId, matchId, outcome, Number(homeScore), Number(awayScore));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Could not save prediction." });
  }
});

// Admin endpoints
app.get("/api/admin/matches", auth, (req,res) => {
  res.json(db.prepare("SELECT * FROM matches ORDER BY match_time ASC").all());
});

app.get("/api/admin/users", auth, (req,res) => {
  res.json(db.prepare("SELECT id,name,username,points,created_at FROM users ORDER BY points DESC").all());
});

app.post("/api/admin/matches", auth, (req,res) => {
  const { homeTeam, awayTeam, matchTime, deadline, homePoints, drawPoints, awayPoints } = req.body || {};
  if (!homeTeam || !awayTeam || !matchTime || !deadline) return res.status(400).json({error:"Complete all match fields."});
  const matchday = getCurrentMatchday();
  const info = db.prepare(`
    INSERT INTO matches(home_team,away_team,match_time,deadline,home_points,draw_points,away_points,matchday)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(homeTeam.trim(), awayTeam.trim(), matchTime, deadline, Number(homePoints)||0, Number(drawPoints)||0, Number(awayPoints)||0, matchday);
  res.json({id:info.lastInsertRowid, matchday});
});

app.post("/api/admin/matches/:id/result", auth, (req,res) => {
  const { homeScore, awayScore } = req.body || {};
  if (!Number.isInteger(Number(homeScore)) || !Number.isInteger(Number(awayScore)) || Number(homeScore)<0 || Number(awayScore)<0)
    return res.status(400).json({error:"Enter valid final scores."});
  const match = db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id);
  if (!match) return res.status(404).json({error:"Match not found."});
  if (match.status === "settled") return res.status(400).json({error:"Match is already settled."});
  db.prepare("UPDATE matches SET home_score=?,away_score=? WHERE id=?").run(Number(homeScore),Number(awayScore),req.params.id);
  settleMatch(req.params.id);
  res.json({ok:true});
});

app.post("/api/admin/matches/:id/close", auth, (req,res) => {
  const match = db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id);
  if (!match) return res.status(404).json({error:"Match not found."});
  db.prepare("UPDATE matches SET status='closed' WHERE id=?").run(req.params.id);
  res.json({ok:true});
});

app.post("/api/admin/login", authLimiter, (req,res) => {
  const {username,password}=req.body||{};
  if (username===adminUser && password===adminPass) res.json({token: signAdminToken()});
  else res.status(401).json({error:"Invalid admin credentials."});
});

app.listen(PORT, () => console.log(`BSL Tournaments Predictor running on port ${PORT}`));
