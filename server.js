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
