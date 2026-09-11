/**
 * Mindwing API  (Cloudflare Worker + D1)
 *
 * A small, defensive backend for the Mindwing educational game:
 *   - global leaderboard with arcade-style 3-letter initials
 *   - anonymous learning analytics (level funnel, hits, lesson reading time, quiz answers)
 *
 * Endpoints (JSON in, JSON out; bodies may be sent as text/plain so sendBeacon works):
 *   GET  /v1/health
 *   POST /v1/session      { clientId?, startLevel?, input? }               -> { sid, sig }
 *   POST /v1/events       { sid, sig, events: [{ type, level?, n?, v?, w?, t? }] }
 *   POST /v1/score        { sid, sig, initials, score, level }             -> { rank }
 *   GET  /v1/leaderboard?limit=10
 *   GET  /v1/stats
 *   GET  /v1/export?key=ADMIN_KEY&after=0&limit=5000&format=json|csv
 *
 * Privacy: no accounts, no names, no IP storage. clientId is a random id the browser
 * makes up; IPs are only hashed with a daily salt to rate-limit abuse.
 */

const VERSION = "1.0.0";   // not exported: the Workers runtime only allows handler exports

const LEVEL_NAMES = ["Token Thicket", "Pattern Canopy", "Retention Ridge", "The Engine's Roost"];
const LESSON_NAMES = ["Tokens", "Neural Networks", "Retention Models", "Offloading & Drift"];

/** Allowed event types and the integer fields each one carries (with clamp ranges). */
const EVENT_TYPES = {
  lesson_view: { level: true,  n: [0, 600000] },                       // n = ms spent reading the lesson
  level_start: { level: true },
  level_clear: { level: true,  n: [0, 3600000], v: [0, 10000000] },    // n = ms in level, v = score after
  hit:         { level: true,  n: [0, 99] },                           // n = index of the fact shown
  game_over:   { level: true,  v: [0, 10000000] },                     // v = score at death
  win:         { level: false, n: [0, 36000000], v: [0, 10000000] },   // n = total ms, v = final score
  quiz:        { level: true,  n: [0, 99], v: [0, 1], w: [0, 9] },     // n = question, v = correct, w = choice
  burst:       { level: true }
};

const LIMITS = {                 // requests per minute per (hashed) IP; sized so a whole classroom behind one address is fine
  session: 40, events: 240, score: 20, read: 300
};
const MAX_BODY_BYTES = 32 * 1024;
const MAX_EVENTS_PER_REQUEST = 50;
const MAX_EVENTS_PER_SESSION = 500;
const MAX_SCORE = 10000000;
/** Score plausibility: the game cannot award more than about 200 points per second of play,
 *  plus fixed bonuses (4 x 500 untouched, 1500 boss, 8 x 100 quiz). */
const SCORE_PER_SECOND = 220;
const SCORE_FIXED_BONUS = 4500;
const MIN_SESSION_SECONDS = 5;

const INITIALS_BLOCKLIST = new Set([
  "ASS","FUK","FUC","FCK","FUX","SEX","CUM","DIK","DIC","COK","COC","TIT","VAG","PUS","NIG","NGR","FAG","KKK",
  "DIE","KIL","RAP","POO","PEE","WTF","STF","SHT","SHI","HOE","HOR","SLT","CNT","CUN","NAZ","JIZ","WAN","BUM"
]);

class HttpError extends Error {
  constructor(status, message){ super(message); this.status = status; }
}

/* ---------- small helpers ---------- */
const enc = new TextEncoder();
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function json(data, status = 200, headers = {}){
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
const methodNotAllowed = allowed => json({ ok: false, error: "method not allowed" }, 405, { allow: allowed.join(", ") });

function intIn(value, min, max){
  if (typeof value === "string" && /^-?\d+$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value) || Math.floor(value) !== value) return null;
  if (value < min || value > max) return null;
  return value;
}
function clampInt(value, min, max){
  if (typeof value === "string" && /^-?\d+$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function timingSafeEqual(a, b){
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret, message){
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return b64url(new Uint8Array(sig)).slice(0, 32);
}

function requireSecret(env){
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) throw new HttpError(503, "server not configured: SESSION_SECRET missing or too short");
  return env.SESSION_SECRET;
}

async function readJson(req){
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  if (!text.trim()) throw new HttpError(400, "empty body");
  let data;
  try { data = JSON.parse(text); } catch { throw new HttpError(400, "invalid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "body must be a JSON object");
  return data;
}

/* ---------- CORS ---------- */
function corsHeaders(req, env){
  const origin = req.headers.get("origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "origin"
  };
  if (origin && (allowed.includes("*") || allowed.includes(origin))) headers["access-control-allow-origin"] = origin;
  return headers;
}

/* ---------- rate limiting (salted daily IP hash, one-minute buckets in D1) ---------- */
async function ipKey(env, req){
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`${ip}|${day}|${env.SESSION_SECRET || ""}`));
  return hex(new Uint8Array(digest)).slice(0, 24);
}
async function checkRate(env, req, kind){
  const limit = LIMITS[kind];
  const k = kind + ":" + (await ipKey(env, req));
  const bucket = Math.floor(Date.now() / 60000);
  const [, sel] = await env.DB.batch([
    env.DB.prepare("INSERT INTO rate_limits (k, bucket, count) VALUES (?, ?, 1) ON CONFLICT(k, bucket) DO UPDATE SET count = count + 1").bind(k, bucket),
    env.DB.prepare("SELECT count FROM rate_limits WHERE k = ? AND bucket = ?").bind(k, bucket)
  ]);
  const count = sel && sel.results && sel.results[0] ? Number(sel.results[0].count) : 1;
  if (count > limit) throw new HttpError(429, "too many requests, please slow down");
}

/* ---------- sessions ---------- */
async function createSession(req, env){
  const secret = requireSecret(env);
  await checkRate(env, req, "session");
  const body = await readJson(req);
  let clientId = null;
  if (body.clientId !== undefined && body.clientId !== null){
    if (typeof body.clientId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.clientId)) throw new HttpError(400, "clientId must be 8-64 chars of [A-Za-z0-9_-]");
    clientId = body.clientId;
  }
  let startLevel = 1;
  if (body.startLevel !== undefined){
    startLevel = intIn(body.startLevel, 1, 4);
    if (startLevel === null) throw new HttpError(400, "startLevel must be an integer 1-4");
  }
  const input = ["touch", "keyboard"].includes(body.input) ? body.input : "unknown";
  const sid = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, client_id, created_at, last_seen, start_level, input, max_level) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(sid, clientId, now, now, startLevel, input, startLevel).run();
  return json({ ok: true, sid, sig: await hmac(secret, sid) });
}

async function authSession(env, body){
  const secret = requireSecret(env);
  const sid = typeof body.sid === "string" ? body.sid : "";
  const sig = typeof body.sig === "string" ? body.sig : "";
  if (!/^[0-9a-f-]{36}$/.test(sid) || !/^[A-Za-z0-9_-]{32}$/.test(sig)) throw new HttpError(401, "missing or malformed session");
  if (!timingSafeEqual(await hmac(secret, sid), sig)) throw new HttpError(401, "bad session signature");
  const session = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(sid).first();
  if (!session) throw new HttpError(404, "unknown session");
  return session;
}

/* ---------- events ---------- */
function validateEvent(raw){
  if (!raw || typeof raw !== "object") return null;
  const spec = EVENT_TYPES[raw.type];
  if (!spec) return null;
  const out = { type: raw.type, level: null, n: null, v: null, w: null, t: clampInt(raw.t, 0, 1e9) ?? 0 };
  if (spec.level){
    out.level = intIn(raw.level, 1, 4);
    if (out.level === null) return null;
  }
  for (const f of ["n", "v", "w"]){
    if (!spec[f]) continue;
    const val = clampInt(raw[f], spec[f][0], spec[f][1]);
    if (val === null) return null;
    out[f] = val;
  }
  return out;
}

async function postEvents(req, env){
  await checkRate(env, req, "events");
  const body = await readJson(req);
  const session = await authSession(env, body);
  if (!Array.isArray(body.events)) throw new HttpError(400, "events must be an array");
  if (body.events.length === 0) return json({ ok: true, accepted: 0, rejected: 0 });
  if (body.events.length > MAX_EVENTS_PER_REQUEST) throw new HttpError(400, `at most ${MAX_EVENTS_PER_REQUEST} events per request`);
  if (session.event_count >= MAX_EVENTS_PER_SESSION) throw new HttpError(429, "session event limit reached");

  const now = Date.now();
  const valid = [], stmts = [];
  let maxLevel = session.max_level, won = session.won;
  for (const raw of body.events){
    const e = validateEvent(raw);
    if (!e) continue;
    if (valid.length + session.event_count >= MAX_EVENTS_PER_SESSION) break;
    valid.push(e);
    if (e.level && e.level > maxLevel) maxLevel = e.level;
    if (e.type === "win"){ won = 1; maxLevel = 4; }
    stmts.push(env.DB.prepare("INSERT INTO events (session_id, type, level, n, v, w, client_t, server_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(session.id, e.type, e.level, e.n, e.v, e.w, e.t, now));
  }
  const rejected = body.events.length - valid.length;
  if (valid.length === 0) throw new HttpError(400, "no valid events");
  stmts.push(env.DB.prepare("UPDATE sessions SET last_seen = ?, event_count = event_count + ?, max_level = ?, won = ? WHERE id = ?")
    .bind(now, valid.length, maxLevel, won, session.id));
  await env.DB.batch(stmts);
  return json({ ok: true, accepted: valid.length, rejected });
}

/* ---------- scores ---------- */
async function postScore(req, env){
  await checkRate(env, req, "score");
  const body = await readJson(req);
  const session = await authSession(env, body);
  const initials = typeof body.initials === "string" ? body.initials.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(initials)) throw new HttpError(400, "initials must be exactly three letters A-Z");
  if (INITIALS_BLOCKLIST.has(initials)) throw new HttpError(400, "those initials are not allowed");
  const score = intIn(body.score, 0, MAX_SCORE);
  if (score === null) throw new HttpError(400, "score must be an integer 0-" + MAX_SCORE);
  const level = intIn(body.level, 1, 4);
  if (level === null) throw new HttpError(400, "level must be an integer 1-4");

  const now = Date.now();
  const elapsedS = Math.max(0, (now - session.created_at) / 1000);
  if (elapsedS < MIN_SESSION_SECONDS) throw new HttpError(422, "session too short to have earned a score");
  if (session.event_count < 1) throw new HttpError(422, "no gameplay recorded for this session");
  if (level > session.max_level) throw new HttpError(422, "level not reached in this session");
  const bound = Math.floor(SCORE_PER_SECOND * elapsedS) + SCORE_FIXED_BONUS;
  if (score > bound) throw new HttpError(422, "score not plausible for the session duration");

  await env.DB.prepare(`INSERT INTO scores (session_id, initials, score, level, won, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      score = MAX(scores.score, excluded.score),
      initials = excluded.initials,
      level = MAX(scores.level, excluded.level),
      won = MAX(scores.won, excluded.won),
      updated_at = excluded.updated_at`)
    .bind(session.id, initials, score, level, session.won ? 1 : 0, now, now).run();
  const row = await env.DB.prepare("SELECT score FROM scores WHERE session_id = ?").bind(session.id).first();
  const kept = row ? Number(row.score) : score;
  const rank = await env.DB.prepare("SELECT COUNT(*) + 1 AS rank FROM scores WHERE score > ?").bind(kept).first("rank");
  return json({ ok: true, initials, score: kept, rank: Number(rank) });
}

async function getLeaderboard(req, env, url){
  await checkRate(env, req, "read");
  const limit = intIn(url.searchParams.get("limit") ?? 10, 1, 50) ?? 10;
  const [top, total] = await env.DB.batch([
    env.DB.prepare("SELECT initials, score, level, won, updated_at FROM scores ORDER BY score DESC, updated_at ASC LIMIT ?").bind(limit),
    env.DB.prepare("SELECT COUNT(*) AS c FROM scores")
  ]);
  return json({
    ok: true,
    total: Number(total.results[0].c),
    top: top.results.map((r, i) => ({ rank: i + 1, initials: r.initials, score: Number(r.score), level: Number(r.level), won: !!r.won, at: Number(r.updated_at) }))
  }, 200, { "cache-control": "public, max-age=20" });
}

/* ---------- learning analytics ---------- */
async function getStats(req, env){
  await checkRate(env, req, "read");
  const q = sql => env.DB.prepare(sql);
  const [totals, started, cleared, overs, hits, lessons, quiz, facts, retries] = await env.DB.batch([
    q("SELECT COUNT(*) AS runs, COUNT(DISTINCT client_id) AS players, COALESCE(SUM(won), 0) AS wins FROM sessions"),
    q("SELECT level, COUNT(DISTINCT session_id) AS c FROM events WHERE type = 'level_start' GROUP BY level"),
    q("SELECT level, COUNT(DISTINCT session_id) AS c FROM events WHERE type = 'level_clear' GROUP BY level"),
    q("SELECT level, COUNT(*) AS c FROM events WHERE type = 'game_over' GROUP BY level"),
    q("SELECT level, COUNT(*) AS c FROM events WHERE type = 'hit' GROUP BY level"),
    q("SELECT level, COUNT(*) AS c, AVG(n) AS avg_ms FROM events WHERE type = 'lesson_view' GROUP BY level"),
    q("SELECT n AS q, COUNT(*) AS answers, AVG(v) AS correct_rate FROM events WHERE type = 'quiz' GROUP BY n ORDER BY n"),
    q("SELECT n AS fact, COUNT(*) AS shown FROM events WHERE type = 'hit' GROUP BY n ORDER BY shown DESC, n ASC LIMIT 5"),
    q("SELECT level, COUNT(*) AS c FROM events WHERE type = 'level_start' GROUP BY level")
  ]);
  const byLevel = res => { const m = {}; for (const r of res.results) m[Number(r.level)] = r; return m; };
  const S = byLevel(started), C = byLevel(cleared), O = byLevel(overs), H = byLevel(hits), L = byLevel(lessons), R = byLevel(retries);
  const t = totals.results[0];
  const runs = Number(t.runs);
  const levels = [1, 2, 3, 4].map(lv => {
    const startedN = S[lv] ? Number(S[lv].c) : 0;
    return {
      level: lv, name: LEVEL_NAMES[lv - 1], lesson: LESSON_NAMES[lv - 1],
      started: startedN,
      cleared: C[lv] ? Number(C[lv].c) : 0,
      game_overs: O[lv] ? Number(O[lv].c) : 0,
      attempts: R[lv] ? Number(R[lv].c) : 0,
      hits: H[lv] ? Number(H[lv].c) : 0,
      hits_per_attempt: R[lv] && Number(R[lv].c) ? +(Number(H[lv] ? H[lv].c : 0) / Number(R[lv].c)).toFixed(2) : 0,
      lesson_views: L[lv] ? Number(L[lv].c) : 0,
      avg_lesson_seconds: L[lv] && L[lv].avg_ms != null ? +(Number(L[lv].avg_ms) / 1000).toFixed(1) : null,
      reach_rate: runs ? +(startedN / runs).toFixed(3) : 0
    };
  });
  return json({
    ok: true,
    generated_at: Date.now(),
    runs, players: Number(t.players), wins: Number(t.wins),
    win_rate: runs ? +(Number(t.wins) / runs).toFixed(3) : 0,
    levels,
    quiz: quiz.results.map(r => ({ q: Number(r.q), lesson: LESSON_NAMES[Math.floor(Number(r.q) / 2)] || null, answers: Number(r.answers), correct_rate: +Number(r.correct_rate).toFixed(3) })),
    hit_facts: facts.results.map(r => ({ fact: Number(r.fact), shown: Number(r.shown) }))
  }, 200, { "cache-control": "public, max-age=60" });
}

/* ---------- admin export (raw events for research) ---------- */
async function getExport(req, env, url){
  const key = url.searchParams.get("key") || "";
  if (!env.ADMIN_KEY || !timingSafeEqual(key, env.ADMIN_KEY)) throw new HttpError(401, "admin key required");
  const after = intIn(url.searchParams.get("after") ?? 0, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const limit = intIn(url.searchParams.get("limit") ?? 5000, 1, 5000) ?? 5000;
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const rows = (await env.DB.prepare(`SELECT e.id, e.session_id, s.client_id, s.start_level, s.input, s.won AS session_won, e.type, e.level, e.n, e.v, e.w, e.client_t, e.server_at
      FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.id > ? ORDER BY e.id LIMIT ?`).bind(after, limit).all()).results;
  if (format === "json") return json({ ok: true, count: rows.length, next_after: rows.length ? rows[rows.length - 1].id : after, rows });
  const cols = ["id", "session_id", "client_id", "start_level", "input", "session_won", "type", "level", "n", "v", "w", "client_t", "server_at"];
  const esc = v => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const csv = [cols.join(",")].concat(rows.map(r => cols.map(c => esc(r[c])).join(","))).join("\n") + "\n";
  return new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": "attachment; filename=mindwing-events.csv" } });
}

/* ---------- health & routing ---------- */
async function health(env){
  let db = false;
  try { db = (await env.DB.prepare("SELECT 1 AS one").first("one")) == 1; } catch { db = false; }
  return json({ ok: db, service: "mindwing-api", version: VERSION, time: Date.now(), db, configured: !!(env.SESSION_SECRET && env.SESSION_SECRET.length >= 16) }, db ? 200 : 503);
}

async function route(req, env, ctx){
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;
  if (path === "/" || path === "/v1") return json({ ok: true, service: "mindwing-api", version: VERSION, endpoints: ["GET /v1/health", "POST /v1/session", "POST /v1/events", "POST /v1/score", "GET /v1/leaderboard", "GET /v1/stats"] });
  if (path === "/v1/health")      return m === "GET"  ? health(env)                    : methodNotAllowed(["GET"]);
  if (path === "/v1/session")     return m === "POST" ? createSession(req, env)        : methodNotAllowed(["POST"]);
  if (path === "/v1/events")      return m === "POST" ? postEvents(req, env)           : methodNotAllowed(["POST"]);
  if (path === "/v1/score")       return m === "POST" ? postScore(req, env)            : methodNotAllowed(["POST"]);
  if (path === "/v1/leaderboard") return m === "GET"  ? getLeaderboard(req, env, url)  : methodNotAllowed(["GET"]);
  if (path === "/v1/stats")       return m === "GET"  ? getStats(req, env)             : methodNotAllowed(["GET"]);
  if (path === "/v1/export")      return m === "GET"  ? getExport(req, env, url)       : methodNotAllowed(["GET"]);
  throw new HttpError(404, "not found");
}

async function pruneRateLimits(env){
  const cutoff = Math.floor(Date.now() / 60000) - 15;
  await env.DB.prepare("DELETE FROM rate_limits WHERE bucket < ?").bind(cutoff).run();
}

export default {
  async fetch(req, env, ctx){
    const cors = corsHeaders(req, env);
    let res;
    try {
      if (req.method === "OPTIONS") res = new Response(null, { status: 204 });
      else res = await route(req, env, ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error("mindwing-api error:", e && e.stack || e);
      res = json({ ok: false, error: status === 500 ? "internal error" : e.message }, status);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
  async scheduled(event, env, ctx){
    ctx.waitUntil(pruneRateLimits(env));
  }
};
