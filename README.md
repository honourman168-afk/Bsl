# BSL Tournaments Predictor

A mobile-friendly football prediction website with:
- User registration/login (passwords hashed with bcrypt)
- Admin-created matches
- Admin-controlled Home/Draw/Away points per match
- Prediction deadlines
- Fixed +6 exact-score bonus
- Automatic result settlement
- Automatic leaderboard
- User prediction history
- No money, deposits, withdrawals or gambling

## Scoring rule

If a user's predicted outcome is correct, they receive the admin-set outcome points.
If their predicted home and away score exactly matches the final score, they also get a
**+6 exact-score bonus**.

Example: Liverpool win = 3 pts, user predicts 2-1, final is 2-1 → 3 + 6 = **9 points**.

## Tech stack

Plain Node.js + Express backend, SQLite (via `better-sqlite3`) for storage, and a
static HTML/CSS/JS frontend in `public/` — no build step, no framework.

## Environment variables

| Variable          | Required | Description                                                                 |
|-------------------|----------|-------------------------------------------------------------------------------|
| `ADMIN_USERNAME`  | Yes (prod) | Username for the admin panel. Defaults to `admin` if unset.                 |
| `ADMIN_PASSWORD`  | Yes (prod) | Password for the admin panel. Defaults to `bsladmin123` if unset.           |
| `SESSION_SECRET`  | Recommended | Secret used to sign admin session tokens. If unset, a random one is generated at boot, which means every restart/redeploy logs admins out. Set a fixed value in production. |
| `DB_PATH`         | Recommended | Full path to the SQLite file. Point this at a mounted persistent disk/volume in production (see below), e.g. `/data/bsl.db`. Defaults to `./bsl.db` next to the server. |
| `PORT`            | No       | Set automatically by most hosts.                                            |

**Always set `ADMIN_USERNAME` and `ADMIN_PASSWORD` before going live** — the server logs a warning on startup if you don't, and the defaults are public (they're in this README).

## Why the database path matters

SQLite stores everything in a single file. Most hosting platforms give your app an
**ephemeral filesystem** by default — anything written to disk (like `bsl.db`) can be
wiped on redeploy or when the instance restarts. To keep your users, matches and
leaderboard permanently, mount a persistent disk/volume and point `DB_PATH` at a file
inside it.

---

## Deploy on Render

1. Push this project to a GitHub repo.
2. In Render, click **New > Blueprint** and point it at the repo — it will pick up
   `render.yaml` automatically and create the service with a 1 GB persistent disk
   mounted at `/data`.
   - Note: persistent disks on Render require a **paid** instance plan (not the free
     tier). If you want to stay on the free tier, remove the `disk:` block from
     `render.yaml` and the `DB_PATH` env var — the app will still run, but the
     database resets on each redeploy.
3. When prompted, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to real values (these are
   marked `sync: false` so Render will ask for them rather than committing them to
   the repo). `SESSION_SECRET` is generated for you automatically.
4. Deploy. Render will run `npm install` then `npm start`.

If you'd rather set it up manually instead of via the Blueprint: create a new **Web
Service**, connect the repo, set Build Command `npm install`, Start Command
`npm start`, add the environment variables above, and add a Disk mounted at `/data`
with `DB_PATH=/data/bsl.db`.

## Deploy on Railway

1. Push this project to a GitHub repo.
2. In Railway, click **New Project > Deploy from GitHub repo** and select it. Railway
   auto-detects Node.js and runs `npm install` / `npm start`.
3. Go to the service's **Variables** tab and add:
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET` (any long random string)
   - `DB_PATH` = `/data/bsl.db`
4. Add a **Volume** (service settings > Volumes), mount it at `/data`. This keeps
   `bsl.db` across redeploys — Railway volumes are available even on the Hobby plan.
5. Railway will assign a public URL under the service's Settings > Networking tab.

## Running locally

```bash
npm install
ADMIN_USERNAME=admin ADMIN_PASSWORD=changeme npm start
```

Then open http://localhost:3000

## Admin login

Go to the **Admin** tab on the site and log in with whatever you set
`ADMIN_USERNAME` / `ADMIN_PASSWORD` to. From there you can publish matches, set
per-outcome points, and enter final scores to settle matches and award points.

## Security notes

- Passwords are hashed with bcrypt before storage.
- Admin sessions are short-lived (12h), signed tokens — not the raw admin password
  sent on every request.
- Login/register/admin-login endpoints are rate-limited (20 attempts / 15 min per IP)
  to slow down brute-forcing.
- This is a casual prediction game with no money involved, but you should still treat
  `ADMIN_PASSWORD` and `SESSION_SECRET` as real secrets — set them via your host's
  environment variable UI, never commit them to the repo.
