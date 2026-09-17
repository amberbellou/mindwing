# Mindwing API

Backend for the [Mindwing](../README.md) game: a Cloudflare Worker with a D1 (SQLite) database. It stores a global leaderboard and anonymous learning analytics, and nothing personal.

- No accounts, no names, no emails. Leaderboard entries are three letters.
- The browser generates a random `clientId` so returning players can be counted. It is not linked to a person.
- IP addresses are never stored. They are hashed with a daily salt and used only to rate-limit abuse.
- Game sessions are signed by the server (HMAC), and scores are checked for plausibility against the recorded session (duration, level reached, gameplay events), so a casual "edit the request" cheat is rejected. A determined attacker who replays realistic events can still fake a score; the leaderboard is for fun, not for prizes.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/health` | Liveness, database and configuration check |
| POST | `/v1/session` | Start a run. Body `{ clientId?, startLevel? (1-5), input?, build?, difficulty?, classCode? }`. Returns `{ sid, sig, class }` (`class` is the joined code, or null when the code is missing or unknown) |
| POST | `/v1/events` | Record gameplay events for a run. Body `{ sid, sig, events: [...] }` (max 50 per request, 500 per run) |
| POST | `/v1/score` | Submit a score. Body `{ sid, sig, initials, score, level }`. Returns `{ rank }` |
| GET | `/v1/leaderboard?limit=10` | Top scores (limit 1 to 50) |
| GET | `/v1/stats` | Aggregated learning analytics: level funnel, hits per attempt, average lesson reading time, quiz correct rates, most-shown facts, answer-orb accuracy, and the before/after check with its gain and per-question breakdown |
| GET | `/v1/export?key=ADMIN_KEY&after=0&limit=5000&format=json\|csv` | Raw event export for research (admin only). Each row carries the run's `build`, `difficulty` and `class_code` |
| POST | `/v1/classes` | Create a class. Body `{ label? }` (up to 40 characters, markup and control characters stripped). Returns `{ code, teacher_key, label }`. The key is returned once; only its SHA-256 hash is stored. 10 per minute per IP |
| GET | `/v1/classes/:code` | Public lookup used by the game: `{ code, label }`, or 404 |
| GET | `/v1/classes/:code/report` | Teacher dashboard data. Header `Authorization: Bearer <teacher_key>`. Class aggregates (same shape as `/v1/stats`) plus `students`: one row per run (newest 300) with initials if signed, difficulty, furthest level, result, score, hits, quick checks and answer orbs. Never returns session or client ids |

Event types: `lesson_view` (n = ms reading), `level_start`, `level_clear` (n = ms, v = score), `hit` (n = fact index), `game_over` (v = score), `win` (n = ms, v = score), `quiz` (n = question, v = correct 0/1, w = choice), `burst` (Clarity Burst, levels 1-2), `still` (Still Point, levels 3-5), `orb` (answer orb grabbed in the Mirage Marsh: v = 1 real insight, 0 hallucination), `pre` and `post` (the same five-question check before playing and after winning: n = question 0-4, v = correct, w = choice; never scored in the game). Everything is validated and clamped server-side. Bodies may be `text/plain` so the browser's `sendBeacon` can flush the last events when a tab closes.

Rate limits per IP per minute: 40 new sessions, 240 event batches, 20 score submissions, 300 reads. That is enough for a whole classroom sharing one network address; change `LIMITS` at the top of `src/index.js` if you need more.

### Levels and game builds

The game has five levels: Token Thicket, Pattern Canopy, Retention Ridge, Mirage Marsh (hallucination) and The Engine's Roost (boss). Runs from the original four-level game, where the boss was level 4, have no `build`; they stay in the export but are left out of `/v1/stats` and class reports, so level numbers always mean the same thing in aggregates. Quiz questions are numbered by the order they were added and never renumbered: 0-5 are lessons 1-3, 6-7 are offloading and drift, 8-9 are hallucination.

### Migrations

`migrations/` is applied in order. `deploy.sh` runs `wrangler d1 migrations apply --remote` before every deploy; migrations that already ran are skipped.

## Run the tests (no account needed)

The Worker runs unchanged in Node against an in-memory SQLite database (`test/d1-shim.mjs`), so the whole API is tested without Cloudflare:

```bash
cd backend
npm test
```

## Run locally

```bash
cd backend
npm install
cp .dev.vars.example .dev.vars
npm run migrate:local
npm run dev            # http://localhost:8787
```

Then open the game with the API override: `http://localhost:8765/?api=http://localhost:8787` (only `localhost` URLs are accepted by the override).

## Deploy (one time, about five minutes)

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up if you do not have one.
2. From the `backend` folder:

```bash
npm install
npx wrangler login
npx wrangler d1 create mindwing
```

3. Copy the `database_id` that the last command prints into `wrangler.toml`.
4. Apply the schema and set the two secrets (paste a long random string for each; `openssl rand -base64 48` makes a good one):

```bash
npm run migrate
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

5. `wrangler deploy` prints the API URL, something like `https://mindwing-api.yourname.workers.dev`. Put it in `index.html` at the top of the script (`API_BASE_DEFAULT`) and push. If the game is ever served from another domain, add that origin to `ALLOWED_ORIGINS` in `wrangler.toml` and redeploy.

Check it is alive: `curl https://mindwing-api.yourname.workers.dev/v1/health`

## Reading the data

- Leaderboard and statistics are public JSON and are also shown inside the game (title screen, "Grove records").
- For research, download every event as CSV: `https://<api>/v1/export?key=<ADMIN_KEY>&format=csv` (5000 rows per page; use `after=<last id>` for the next page).
- `npx wrangler d1 execute mindwing --remote --command "SELECT COUNT(*) FROM sessions"` runs SQL directly.

## Cost

Everything fits comfortably in Cloudflare's free tier (100k Worker requests per day, 5 million D1 reads per day).
