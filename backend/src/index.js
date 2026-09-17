/**
 * Mindwing API  (Cloudflare Worker + D1)
 *
 * A small, defensive backend for the Mindwing educational game:
 *   - global leaderboard with arcade-style 3-letter initials
 *   - anonymous learning analytics (level funnel, hits, lesson reading time, quiz answers)
 *
 * Endpoints (JSON in, JSON out; bodies may be sent as text/plain so sendBeacon works):
 *   GET  /v1/health
 *   POST /v1/session      { clientId?, startLevel?, input?, build?, difficulty?, classCode? } -> { sid, sig, class }
 *   POST /v1/events       { sid, sig, events: [{ type, level?, n?, v?, w?, t? }] }
 *   POST /v1/score        { sid, sig, initials, score, level }             -> { rank }
 *   GET  /v1/leaderboard?limit=10
 *   GET  /v1/stats
 *   GET  /v1/export?key=ADMIN_KEY&after=0&limit=5000&format=json|csv
 *   POST /v1/classes      { label? }                                       -> { code, teacher_key }
 *   GET  /v1/classes/:code                                                 -> { code, label }
 *   GET  /v1/classes/:code/report   (Authorization: Bearer <teacher_key>)  -> class totals + one row per run
 *
 * Privacy: no accounts, no names, no IP storage. Teacher keys are stored only as SHA-256 hashes. clientId is a random id the browser
 * makes up; IPs are only hashed with a daily salt to rate-limit abuse.
 */

const VERSION = "1.2.0";   // not exported: the Workers runtime only allows handler exports

/* The 5-level game. Runs from the original 4-level game (build NULL) keep their data in the export but are
   left out of the aggregate stats, because their level 4 was the boss. */
const LEVEL_COUNT = 5;
const LEVEL_NAMES = ["Token Thicket", "Pattern Canopy", "Retention Ridge", "Mirage Marsh", "The Engine's Roost"];
const LESSON_NAMES = ["Tokens", "Neural Networks", "Retention Models", "Hallucination", "Offloading & Drift"];
/** Quiz question index -> lesson index. Questions are appended, never reordered, so old answers keep their meaning:
 *  0-5 are lessons 1-3, 6-7 are offloading & drift, 8-9 are hallucination. */
const QUIZ_LESSON = [0, 0, 1, 1, 2, 2, 4, 4, 3, 3];
const DIFFICULTIES = ["easy", "normal", "hard"];
const CLASS_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L: codes are read aloud and copied off boards
const CLASS_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const MAX_REPORT_RUNS = 300;

/** Allowed event types and the integer fields each one carries (with clamp ranges). */
const EVENT_TYPES = {
  lesson_view: { level: true,  n: [0, 600000] },                       // n = ms spent reading the lesson
  level_start: { level: true },
  level_clear: { level: true,  n: [0, 3600000], v: [0, 10000000] },    // n = ms in level, v = score after
  hit:         { level: true,  n: [0, 99] },                           // n = index of the fact shown
  game_over:   { level: true,  v: [0, 10000000] },                     // v = score at death
  win:         { level: false, n: [0, 36000000], v: [0, 10000000] },   // n = total ms, v = final score
  quiz:        { level: true,  n: [0, 99], v: [0, 1], w: [0, 9] },     // n = question, v = correct, w = choice
  orb:         { level: true,  v: [0, 1] },                            // answer orb collected: v = 1 real insight, 0 hallucination
  pre:         { level: false, n: [0, 9], v: [0, 1], w: [0, 9] },       // before-you-fly check: n = question, v = correct, w = choice
  post:        { level: false, n: [0, 9], v: [0, 1], w: [0, 9] },       // the same check after the Engine falls
  burst:       { level: true },                                        // Clarity Burst, levels 1-2
  still:       { level: true }                                         // Still Point, levels 3-5
};

const LIMITS = {                 // requests per minute per (hashed) IP; sized so a whole classroom behind one address is fine
  session: 40, events: 240, score: 20, read: 300, classes: 10
};
const MAX_BODY_BYTES = 32 * 1024;
const MAX_EVENTS_PER_REQUEST = 50;
const MAX_EVENTS_PER_SESSION = 500;
const MAX_SCORE = 10000000;
/** Score plausibility: the game cannot award more than about 300 points per second of play on Hard (1.3x),
 *  plus fixed bonuses (4 x 500 untouched and 1500 boss, both x1.3 on Hard, and 10 x 100 quiz). */
const SCORE_PER_SECOND = 300;
const SCORE_FIXED_BONUS = 6500;
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
const sha256hex = async text => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
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
    "access-control-allow-headers": "content-type, authorization",
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
    startLevel = intIn(body.startLevel, 1, LEVEL_COUNT);
    if (startLevel === null) throw new HttpError(400, `startLevel must be an integer 1-${LEVEL_COUNT}`);
  }
  const input = ["touch", "keyboard"].includes(body.input) ? body.input : "unknown";
  const build = typeof body.build === "string" && /^[0-9A-Za-z.-]{1,24}$/.test(body.build) ? body.build : null;
  const difficulty = DIFFICULTIES.includes(body.difficulty) ? body.difficulty : null;
  // An unknown or malformed class code never blocks play: the run is simply not attached to a class.
  let classRow = null;
  if (typeof body.classCode === "string" && CLASS_CODE_RE.test(body.classCode.toUpperCase())){
    classRow = await env.DB.prepare("SELECT id, code FROM classes WHERE code = ?").bind(body.classCode.toUpperCase()).first();
  }
  const sid = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, client_id, created_at, last_seen, start_level, input, max_level, build, difficulty, class_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(sid, clientId, now, now, startLevel, input, startLevel, build, difficulty, classRow ? classRow.id : null).run();
  return json({ ok: true, sid, sig: await hmac(secret, sid), class: classRow ? classRow.code : null });
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
    out.level = intIn(raw.level, 1, LEVEL_COUNT);
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
    if (e.type === "win"){ won = 1; maxLevel = session.build ? LEVEL_COUNT : 4; }
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
  const level = intIn(body.level, 1, LEVEL_COUNT);
  if (level === null) throw new HttpError(400, `level must be an integer 1-${LEVEL_COUNT}`);

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
/** Aggregates for a set of runs. `where` selects sessions (alias s); `args` are its bound values. */
async function buildAnalytics(env, where, args){
  const q = sql => env.DB.prepare(sql).bind(...args);
  const ev = (select, type, tail = "") => q(`SELECT ${select} FROM events e JOIN sessions s ON s.id = e.session_id WHERE ${where} AND e.type = '${type}' ${tail}`);
  const [totals, started, cleared, overs, hits, lessons, quiz, facts, retries, orbs, pre, post, preQ, postQ] = await env.DB.batch([
    q(`SELECT COUNT(*) AS runs, COUNT(DISTINCT s.client_id) AS players, COALESCE(SUM(s.won), 0) AS wins FROM sessions s WHERE ${where}`),
    ev("e.level, COUNT(DISTINCT e.session_id) AS c", "level_start", "GROUP BY e.level"),
    ev("e.level, COUNT(DISTINCT e.session_id) AS c", "level_clear", "GROUP BY e.level"),
    ev("e.level, COUNT(*) AS c", "game_over", "GROUP BY e.level"),
    ev("e.level, COUNT(*) AS c", "hit", "GROUP BY e.level"),
    ev("e.level, COUNT(*) AS c, AVG(e.n) AS avg_ms", "lesson_view", "GROUP BY e.level"),
    ev("e.n AS q, COUNT(*) AS answers, AVG(e.v) AS correct_rate", "quiz", "GROUP BY e.n ORDER BY e.n"),
    ev("e.n AS fact, COUNT(*) AS shown", "hit", "GROUP BY e.n ORDER BY shown DESC, e.n ASC LIMIT 5"),
    ev("e.level, COUNT(*) AS c", "level_start", "GROUP BY e.level"),
    ev("COUNT(*) AS picked, COALESCE(SUM(e.v), 0) AS real_n", "orb"),
    ev("COUNT(*) AS answers, COALESCE(SUM(e.v), 0) AS correct, COUNT(DISTINCT e.session_id) AS takers", "pre"),
    ev("COUNT(*) AS answers, COALESCE(SUM(e.v), 0) AS correct, COUNT(DISTINCT e.session_id) AS takers", "post"),
    ev("e.n AS q, COUNT(*) AS answers, COALESCE(SUM(e.v), 0) AS correct", "pre", "GROUP BY e.n ORDER BY e.n"),
    ev("e.n AS q, COUNT(*) AS answers, COALESCE(SUM(e.v), 0) AS correct", "post", "GROUP BY e.n ORDER BY e.n")
  ]);
  const byLevel = res => { const m = {}; for (const r of res.results) m[Number(r.level)] = r; return m; };
  const S = byLevel(started), C = byLevel(cleared), O = byLevel(overs), H = byLevel(hits), L = byLevel(lessons), R = byLevel(retries);
  const t = totals.results[0];
  const runs = Number(t.runs);
  const levels = LEVEL_NAMES.map((name, i) => {
    const lv = i + 1;
    const startedN = S[lv] ? Number(S[lv].c) : 0;
    return {
      level: lv, name, lesson: LESSON_NAMES[i],
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
  const o = orbs.results[0] || { picked: 0, real_n: 0 };
  const picked = Number(o.picked);
  /* The same five questions before playing and after winning. Only runs that answered both sides can show a
     gain, so the pair is reported alongside the raw rates rather than instead of them. */
  const side = res => {
    const r = res.results[0] || {};
    const answers = Number(r.answers || 0);
    return { answers, correct: Number(r.correct || 0), takers: Number(r.takers || 0), rate: answers ? +(Number(r.correct) / answers).toFixed(3) : null };
  };
  const byQ = res => res.results.map(r => ({ q: Number(r.q), answers: Number(r.answers), correct: Number(r.correct), rate: Number(r.answers) ? +(Number(r.correct) / Number(r.answers)).toFixed(3) : null }));
  const before = side(pre), after = side(post);
  return {
    runs, players: Number(t.players), wins: Number(t.wins),
    win_rate: runs ? +(Number(t.wins) / runs).toFixed(3) : 0,
    levels,
    quiz: quiz.results.map(r => {
      const qi = Number(r.q);
      return { q: qi, lesson: QUIZ_LESSON[qi] != null ? LESSON_NAMES[QUIZ_LESSON[qi]] : null, answers: Number(r.answers), correct_rate: +Number(r.correct_rate).toFixed(3) };
    }),
    hit_facts: facts.results.map(r => ({ fact: Number(r.fact), shown: Number(r.shown) })),
    orbs: { picked, real: Number(o.real_n), fake: picked - Number(o.real_n), real_rate: picked ? +(Number(o.real_n) / picked).toFixed(3) : null },
    check: {
      before, after,
      gain: (before.rate != null && after.rate != null) ? +(after.rate - before.rate).toFixed(3) : null,
      questions: { before: byQ(preQ), after: byQ(postQ) }
    }
  };
}

async function getStats(req, env){
  await checkRate(env, req, "read");
  const data = await buildAnalytics(env, "s.build IS NOT NULL", []);
  return json({ ok: true, generated_at: Date.now(), ...data }, 200, { "cache-control": "public, max-age=60" });
}

/* ---------- classrooms ---------- */
function randomCode(){
  const out = [];
  while (out.length < 6){
    // rejection sampling keeps every symbol equally likely
    for (const b of crypto.getRandomValues(new Uint8Array(12))){
      if (b < 248 && out.length < 6) out.push(CLASS_CODE_ALPHABET[b % CLASS_CODE_ALPHABET.length]);
    }
  }
  return out.join("");
}
function cleanLabel(raw){
  if (raw == null) return null;
  if (typeof raw !== "string") throw new HttpError(400, "label must be text");
  const label = raw.replace(/[\x00-\x1f\x7f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return label || null;
}
async function createClass(req, env){
  await checkRate(env, req, "classes");
  const body = await readJson(req);
  const label = cleanLabel(body.label);
  const key = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const keyHash = await sha256hex(key);
  const now = Date.now();
  for (let attempt = 0; attempt < 6; attempt++){
    const code = randomCode();
    try {
      await env.DB.prepare("INSERT INTO classes (code, key_hash, label, created_at) VALUES (?, ?, ?, ?)").bind(code, keyHash, label, now).run();
      return json({ ok: true, code, teacher_key: key, label });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;   // collision: try another code
    }
  }
  throw new HttpError(503, "could not allocate a class code, try again");
}
async function findClass(env, rawCode){
  const code = String(rawCode || "").toUpperCase();
  if (!CLASS_CODE_RE.test(code)) throw new HttpError(404, "no such class");
  const row = await env.DB.prepare("SELECT id, code, key_hash, label, created_at FROM classes WHERE code = ?").bind(code).first();
  if (!row) throw new HttpError(404, "no such class");
  return row;
}
async function getClass(req, env, code){
  await checkRate(env, req, "read");
  const c = await findClass(env, code);
  return json({ ok: true, code: c.code, label: c.label });
}
async function getClassReport(req, env, code){
  await checkRate(env, req, "read");
  const c = await findClass(env, code);
  const auth = req.headers.get("authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key || !timingSafeEqual(await sha256hex(key), c.key_hash)) throw new HttpError(401, "teacher key required");
  const data = await buildAnalytics(env, "s.class_id = ?", [c.id]);
  const runs = (await env.DB.prepare(`SELECT s.created_at, s.last_seen, s.difficulty, s.start_level, s.max_level, s.won, s.input,
      sc.initials, sc.score,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'hit') AS hits,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'quiz') AS quiz_answers,
      (SELECT COALESCE(SUM(e.v), 0) FROM events e WHERE e.session_id = s.id AND e.type = 'quiz') AS quiz_correct,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'orb' AND e.v = 1) AS orbs_real,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'orb' AND e.v = 0) AS orbs_fake,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'pre') AS pre_answers,
      (SELECT COALESCE(SUM(e.v), 0) FROM events e WHERE e.session_id = s.id AND e.type = 'pre') AS pre_correct,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'post') AS post_answers,
      (SELECT COALESCE(SUM(e.v), 0) FROM events e WHERE e.session_id = s.id AND e.type = 'post') AS post_correct
    FROM sessions s LEFT JOIN scores sc ON sc.session_id = s.id
    WHERE s.class_id = ? ORDER BY s.created_at DESC LIMIT ?`).bind(c.id, MAX_REPORT_RUNS).all()).results;
  return json({
    ok: true, generated_at: Date.now(),
    class: { code: c.code, label: c.label, created_at: Number(c.created_at) },
    ...data,
    students: runs.map(r => ({
      initials: r.initials || null,
      started_at: Number(r.created_at),
      minutes: +((Number(r.last_seen) - Number(r.created_at)) / 60000).toFixed(1),
      difficulty: r.difficulty || null,
      start_level: Number(r.start_level),
      reached: Number(r.max_level),
      won: !!r.won,
      score: r.score == null ? null : Number(r.score),
      hits: Number(r.hits),
      quiz_correct: Number(r.quiz_correct), quiz_answers: Number(r.quiz_answers),
      orbs_real: Number(r.orbs_real), orbs_fake: Number(r.orbs_fake),
      pre_correct: Number(r.pre_correct), pre_answers: Number(r.pre_answers),
      post_correct: Number(r.post_correct), post_answers: Number(r.post_answers)
    })),
    truncated: runs.length >= MAX_REPORT_RUNS
  }, 200, { "cache-control": "no-store" });
}

/* ---------- admin export (raw events for research) ---------- */
async function getExport(req, env, url){
  const key = url.searchParams.get("key") || "";
  if (!env.ADMIN_KEY || !timingSafeEqual(key, env.ADMIN_KEY)) throw new HttpError(401, "admin key required");
  const after = intIn(url.searchParams.get("after") ?? 0, 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const limit = intIn(url.searchParams.get("limit") ?? 5000, 1, 5000) ?? 5000;
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const rows = (await env.DB.prepare(`SELECT e.id, e.session_id, s.client_id, s.start_level, s.input, s.won AS session_won, s.build, s.difficulty, c.code AS class_code, e.type, e.level, e.n, e.v, e.w, e.client_t, e.server_at
      FROM events e JOIN sessions s ON s.id = e.session_id LEFT JOIN classes c ON c.id = s.class_id WHERE e.id > ? ORDER BY e.id LIMIT ?`).bind(after, limit).all()).results;
  if (format === "json") return json({ ok: true, count: rows.length, next_after: rows.length ? rows[rows.length - 1].id : after, rows });
  const cols = ["id", "session_id", "client_id", "start_level", "input", "session_won", "build", "difficulty", "class_code", "type", "level", "n", "v", "w", "client_t", "server_at"];
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
  if (path === "/" || path === "/v1") return json({ ok: true, service: "mindwing-api", version: VERSION, endpoints: ["GET /v1/health", "POST /v1/session", "POST /v1/events", "POST /v1/score", "GET /v1/leaderboard", "GET /v1/stats", "POST /v1/classes", "GET /v1/classes/:code", "GET /v1/classes/:code/report"] });
  if (path === "/v1/health")      return m === "GET"  ? health(env)                    : methodNotAllowed(["GET"]);
  if (path === "/v1/session")     return m === "POST" ? createSession(req, env)        : methodNotAllowed(["POST"]);
  if (path === "/v1/events")      return m === "POST" ? postEvents(req, env)           : methodNotAllowed(["POST"]);
  if (path === "/v1/score")       return m === "POST" ? postScore(req, env)            : methodNotAllowed(["POST"]);
  if (path === "/v1/leaderboard") return m === "GET"  ? getLeaderboard(req, env, url)  : methodNotAllowed(["GET"]);
  if (path === "/v1/stats")       return m === "GET"  ? getStats(req, env)             : methodNotAllowed(["GET"]);
  if (path === "/v1/export")      return m === "GET"  ? getExport(req, env, url)       : methodNotAllowed(["GET"]);
  if (path === "/v1/classes")     return m === "POST" ? createClass(req, env)          : methodNotAllowed(["POST"]);
  let cm = path.match(/^\/v1\/classes\/([A-Za-z0-9]{1,12})$/);
  if (cm) return m === "GET" ? getClass(req, env, cm[1]) : methodNotAllowed(["GET"]);
  cm = path.match(/^\/v1\/classes\/([A-Za-z0-9]{1,12})\/report$/);
  if (cm) return m === "GET" ? getClassReport(req, env, cm[1]) : methodNotAllowed(["GET"]);
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
