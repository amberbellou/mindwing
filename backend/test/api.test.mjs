import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { makeD1 } from "./d1-shim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(here, "..", "migrations", "0001_init.sql"), "utf8");
const ORIGIN = "https://amberbellou.github.io";
const ctx = { waitUntil(p){ return p; }, passThroughOnException(){} };

function makeEnv(overrides = {}){
  const DB = makeD1();
  DB._raw.exec(SCHEMA);
  return { DB, SESSION_SECRET: "test-secret-that-is-long-enough", ADMIN_KEY: "admin-key-123", ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8765`, ...overrides };
}
let ipSerial = 0;   // a fresh IP per call by default, so rate limits only bite where a test asks for them
async function call(env, method, p, body, headers = {}, ip){
  ip = ip || `10.${(ipSerial >> 16) & 255}.${(ipSerial >> 8) & 255}.${ipSerial++ & 255}`;
  const init = { method, headers: { "cf-connecting-ip": ip, origin: ORIGIN, ...headers } };
  if (body !== undefined){ init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["content-type"] = init.headers["content-type"] || "text/plain"; }
  const res = await worker.fetch(new Request("https://api.test" + p, init), env, ctx);
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, text, headers: res.headers };
}
async function newSession(env, extra = {}, ip){
  const r = await call(env, "POST", "/v1/session", { clientId: "client-abcdef-123", startLevel: 1, input: "keyboard", ...extra }, {}, ip);
  assert.equal(r.status, 200, r.text);
  return r.data;
}
function ageSession(env, sid, seconds){
  env.DB._raw.prepare("UPDATE sessions SET created_at = created_at - ? WHERE id = ?").run(seconds * 1000, sid);
}
async function playThrough(env, s, opts = {}){
  const events = [
    { type: "lesson_view", level: 1, n: 12000, t: 0 },
    { type: "quiz", level: 1, n: 0, v: 1, w: 1, t: 15000 },
    { type: "quiz", level: 1, n: 1, v: 0, w: 2, t: 20000 },
    { type: "level_start", level: 1, t: 21000 },
    { type: "hit", level: 1, n: 3, t: 30000 },
    { type: "burst", level: 1, t: 31000 },
    { type: "level_clear", level: 1, n: 40000, v: 1300, t: 61000 },
    { type: "lesson_view", level: 2, n: 9000, t: 62000 },
    { type: "level_start", level: 2, t: 71000 }
  ];
  if (opts.win) events.push({ type: "level_clear", level: 2, n: 50000, v: 2600, t: 120000 }, { type: "level_start", level: 3 }, { type: "level_clear", level: 3, n: 50000, v: 4000 }, { type: "level_start", level: 4 }, { type: "win", n: 300000, v: 6100 });
  else events.push({ type: "game_over", level: 2, v: 1700, t: 90000 });
  const r = await call(env, "POST", "/v1/events", { sid: s.sid, sig: s.sig, events });
  assert.equal(r.status, 200, r.text);
  return r.data;
}

test("health reports db and configuration", async () => {
  const env = makeEnv();
  const r = await call(env, "GET", "/v1/health");
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.ok, r.data.db, r.data.configured], [true, true, true]);
  const bad = await call(makeEnv({ SESSION_SECRET: "short" }), "GET", "/v1/health");
  assert.equal(bad.data.configured, false);
});

test("CORS: allowed origin gets headers, unknown origin does not, preflight is 204", async () => {
  const env = makeEnv();
  const ok = await call(env, "GET", "/v1/health");
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  const other = await call(env, "GET", "/v1/health", undefined, { origin: "https://evil.example" });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  const pre = await call(env, "OPTIONS", "/v1/events");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  const err = await call(env, "GET", "/v1/nope");
  assert.equal(err.status, 404);
  assert.equal(err.headers.get("access-control-allow-origin"), ORIGIN, "error responses carry CORS too");
  const star = await call(makeEnv({ ALLOWED_ORIGINS: "*" }), "GET", "/v1/health", undefined, { origin: "https://anything.example" });
  assert.equal(star.headers.get("access-control-allow-origin"), "https://anything.example");
});

test("routing: 404, 405 with Allow header, index lists endpoints", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "GET", "/v1/session")).status, 405);
  assert.equal((await call(env, "GET", "/v1/session")).headers.get("allow"), "POST");
  assert.equal((await call(env, "POST", "/v1/leaderboard", {})).status, 405);
  assert.equal((await call(env, "DELETE", "/v1/events")).status, 405);
  assert.equal((await call(env, "GET", "/")).data.service, "mindwing-api");
});

test("bad bodies: malformed JSON, non-object, empty, oversized", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "POST", "/v1/session", "{not json")).status, 400);
  assert.equal((await call(env, "POST", "/v1/session", "[1,2]")).status, 400);
  assert.equal((await call(env, "POST", "/v1/session", "   ")).status, 400);
  const big = await call(env, "POST", "/v1/session", JSON.stringify({ pad: "x".repeat(40000) }));
  assert.equal(big.status, 413);
  const jsonCT = await call(env, "POST", "/v1/session", { startLevel: 2 }, { "content-type": "application/json" });
  assert.equal(jsonCT.status, 200, "application/json bodies work as well as text/plain");
});

test("session: creates signed ids, validates inputs, refuses when unconfigured", async () => {
  const env = makeEnv();
  const s = await newSession(env);
  assert.match(s.sid, /^[0-9a-f-]{36}$/);
  assert.match(s.sig, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await call(env, "POST", "/v1/session", { startLevel: 9 })).status, 400);
  assert.equal((await call(env, "POST", "/v1/session", { clientId: "x" })).status, 400);
  assert.equal((await call(env, "POST", "/v1/session", { clientId: "bad id with spaces!" })).status, 400);
  const anon = await call(env, "POST", "/v1/session", {});
  assert.equal(anon.status, 200, "clientId is optional");
  const unconfigured = await call(makeEnv({ SESSION_SECRET: undefined }), "POST", "/v1/session", {});
  assert.equal(unconfigured.status, 503);
});

test("events: signature is enforced, invalid events dropped, limits applied", async () => {
  const env = makeEnv();
  const s = await newSession(env);
  const forged = await call(env, "POST", "/v1/events", { sid: s.sid, sig: "A".repeat(32), events: [{ type: "level_start", level: 1 }] });
  assert.equal(forged.status, 401);
  const badShape = await call(env, "POST", "/v1/events", { sid: "nope", sig: s.sig, events: [] });
  assert.equal(badShape.status, 401);
  const unknown = await call(env, "POST", "/v1/events", { sid: "12345678-1234-1234-1234-123456789abc", sig: s.sig, events: [] });
  assert.equal(unknown.status, 401, "wrong sid for that signature");
  const notArray = await call(env, "POST", "/v1/events", { sid: s.sid, sig: s.sig, events: "x" });
  assert.equal(notArray.status, 400);
  const mixed = await call(env, "POST", "/v1/events", { sid: s.sid, sig: s.sig, events: [
    { type: "level_start", level: 1 },
    { type: "level_start", level: 7 },            // bad level
    { type: "teleport", level: 1 },               // unknown type
    { type: "lesson_view", level: 2, n: 99999999 }, // clamped, still accepted
    { type: "quiz", level: 1, n: 0, v: 5, w: 1 },  // v clamped to 1
    "garbage", null, 42
  ]});
  assert.equal(mixed.status, 200, mixed.text);
  assert.deepEqual([mixed.data.accepted, mixed.data.rejected], [3, 5]);
  const rows = env.DB._raw.prepare("SELECT type, level, n, v FROM events ORDER BY id").all();
  assert.equal(rows.find(r => r.type === "lesson_view").n, 600000, "reading time clamped to 10 minutes");
  assert.equal(rows.find(r => r.type === "quiz").v, 1);
  const session = env.DB._raw.prepare("SELECT event_count, max_level FROM sessions WHERE id = ?").get(s.sid);
  assert.deepEqual([session.event_count, session.max_level], [3, 2]);
  const allBad = await call(env, "POST", "/v1/events", { sid: s.sid, sig: s.sig, events: [{ type: "nope" }] });
  assert.equal(allBad.status, 400);
  const tooMany = await call(env, "POST", "/v1/events", { sid: s.sid, sig: s.sig, events: Array(51).fill({ type: "burst", level: 1 }) });
  assert.equal(tooMany.status, 400);
  const empty = await call(env, "POST", "/v1/events", { sid: s.sid, sig: s.sig, events: [] });
  assert.equal(empty.data.accepted, 0);
});

test("events: per-session cap stops runaway clients", async () => {
  const env = makeEnv();
  const s = await newSession(env);
  const batch = Array(50).fill({ type: "burst", level: 1 });
  for (let i = 0; i < 10; i++){
    const r = await call(env, "POST", "/v1/events", { sid: s.sid, sig: s.sig, events: batch }, {}, "198.51.100." + i);
    assert.equal(r.status, 200);
  }
  const over = await call(env, "POST", "/v1/events", { sid: s.sid, sig: s.sig, events: batch }, {}, "198.51.100.99");
  assert.equal(over.status, 429);
  assert.equal(env.DB._raw.prepare("SELECT COUNT(*) AS c FROM events").get().c, 500);
});

test("score: forgeries rejected, plausible scores ranked, max kept per session", async () => {
  const env = makeEnv();
  const s = await newSession(env);
  const noPlay = await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: "AMB", score: 100, level: 1 });
  assert.equal(noPlay.status, 422, "no events yet");
  await playThrough(env, s);
  const tooSoon = await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: "AMB", score: 100, level: 1 });
  assert.equal(tooSoon.status, 422, "session younger than 5 seconds");
  ageSession(env, s.sid, 90);
  const forged = await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: "AMB", score: 9999999, level: 2 });
  assert.equal(forged.status, 422, "impossible score for 90 seconds of play");
  const wrongLevel = await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: "AMB", score: 1000, level: 4 });
  assert.equal(wrongLevel.status, 422, "level 4 never reached");
  for (const bad of ["ab", "A1B", "ABCD", "", 12, "F*K"]){
    const r = await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: bad, score: 1000, level: 2 });
    assert.equal(r.status, 400, "initials " + JSON.stringify(bad));
  }
  assert.equal((await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: "ass", score: 1000, level: 2 })).status, 400, "blocklist, case-insensitive");
  assert.equal((await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: "AMB", score: -5, level: 2 })).status, 400);
  assert.equal((await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: "AMB", score: 12.5, level: 2 })).status, 400);
  const ok = await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: "amb", score: 1700, level: 2 });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.data.initials, ok.data.score, ok.data.rank], ["AMB", 1700, 1]);
  const lower = await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: "AMB", score: 900, level: 2 });
  assert.equal(lower.data.score, 1700, "a later lower score does not overwrite the best");
  assert.equal(env.DB._raw.prepare("SELECT COUNT(*) AS c FROM scores").get().c, 1, "one row per session");

  const s2 = await newSession(env, {}, "203.0.113.50");
  await playThrough(env, s2, { win: true });
  ageSession(env, s2.sid, 400);
  const win = await call(env, "POST", "/v1/score", { sid: s2.sid, sig: s2.sig, initials: "LUM", score: 6100, level: 4 }, {}, "203.0.113.50");
  assert.equal(win.status, 200, win.text);
  assert.equal(win.data.rank, 1);
  const again = await call(env, "POST", "/v1/score", { sid: s.sid, sig: s.sig, initials: "AMB", score: 1700, level: 2 });
  assert.equal(again.data.rank, 2);

  const lb = await call(env, "GET", "/v1/leaderboard?limit=1");
  assert.equal(lb.status, 200);
  assert.equal(lb.data.total, 2);
  assert.equal(lb.data.top.length, 1);
  assert.deepEqual([lb.data.top[0].initials, lb.data.top[0].score, lb.data.top[0].won, lb.data.top[0].rank], ["LUM", 6100, true, 1]);
  assert.equal((await call(env, "GET", "/v1/leaderboard?limit=999")).data.top.length, 2, "limit is clamped, not rejected");
  assert.match(lb.headers.get("cache-control"), /max-age=20/);
});

test("stats: aggregates the learning analytics correctly", async () => {
  const env = makeEnv();
  const a = await newSession(env, { clientId: "client-aaaaaaaa" }, "203.0.113.1");
  const b = await newSession(env, { clientId: "client-bbbbbbbb" }, "203.0.113.2");
  const c = await newSession(env, { clientId: "client-aaaaaaaa" }, "203.0.113.3");   // same player again
  await playThrough(env, a);
  await playThrough(env, b, { win: true });
  await call(env, "POST", "/v1/events", { sid: c.sid, sig: c.sig, events: [{ type: "level_start", level: 1 }, { type: "hit", level: 1, n: 3 }, { type: "hit", level: 1, n: 5 }, { type: "game_over", level: 1, v: 200 }, { type: "level_start", level: 1 }] }, {}, "203.0.113.3");
  const r = await call(env, "GET", "/v1/stats");
  assert.equal(r.status, 200, r.text);
  const d = r.data;
  assert.deepEqual([d.runs, d.players, d.wins, d.win_rate], [3, 2, 1, 0.333]);
  const l1 = d.levels[0], l2 = d.levels[1], l4 = d.levels[3];
  assert.deepEqual([l1.started, l1.cleared, l1.game_overs, l1.attempts, l1.hits, l1.lesson_views], [3, 2, 1, 4, 4, 2]);
  assert.equal(l1.avg_lesson_seconds, 12);
  assert.equal(l1.hits_per_attempt, 1);
  assert.deepEqual([l2.started, l2.cleared, l2.game_overs, l2.reach_rate], [2, 1, 1, 0.667]);
  assert.deepEqual([l4.started, l4.cleared], [1, 0]);
  assert.equal(d.quiz.length, 2);
  assert.deepEqual(d.quiz[0], { q: 0, lesson: "Tokens", answers: 2, correct_rate: 1 });
  assert.deepEqual(d.quiz[1], { q: 1, lesson: "Tokens", answers: 2, correct_rate: 0 });
  assert.deepEqual(d.hit_facts[0], { fact: 3, shown: 3 });
  const empty = await call(makeEnv(), "GET", "/v1/stats");
  assert.equal(empty.status, 200, "stats work on an empty database");
  assert.deepEqual([empty.data.runs, empty.data.win_rate, empty.data.levels[0].avg_lesson_seconds], [0, 0, null]);
});

test("export: admin key required, json and csv formats, pagination", async () => {
  const env = makeEnv();
  const s = await newSession(env);
  await playThrough(env, s);
  assert.equal((await call(env, "GET", "/v1/export")).status, 401);
  assert.equal((await call(env, "GET", "/v1/export?key=wrong")).status, 401);
  assert.equal((await call(makeEnv({ ADMIN_KEY: undefined }), "GET", "/v1/export?key=")).status, 401, "no key configured means no export");
  const j = await call(env, "GET", "/v1/export?key=admin-key-123&limit=4");
  assert.equal(j.status, 200);
  assert.equal(j.data.count, 4);
  const page2 = await call(env, "GET", `/v1/export?key=admin-key-123&after=${j.data.next_after}`);
  assert.equal(page2.data.count, 6);
  assert.equal(page2.data.rows[0].client_id, "client-abcdef-123");
  const csv = await call(env, "GET", "/v1/export?key=admin-key-123&format=csv");
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const lines = csv.text.trim().split("\n");
  assert.equal(lines[0], "id,session_id,client_id,start_level,input,session_won,type,level,n,v,w,client_t,server_at");
  assert.equal(lines.length, 11);
});

test("rate limiting: per-IP buckets return 429, other IPs unaffected, prune works", async () => {
  const env = makeEnv();
  for (let i = 0; i < 10; i++) assert.equal((await call(env, "POST", "/v1/session", {}, {}, "192.0.2.7")).status, 200);
  assert.equal((await call(env, "POST", "/v1/session", {}, {}, "192.0.2.7")).status, 429);
  assert.equal((await call(env, "POST", "/v1/session", {}, {}, "192.0.2.8")).status, 200);
  env.DB._raw.prepare("UPDATE rate_limits SET bucket = bucket - 100").run();
  await worker.scheduled({ cron: "17 * * * *" }, env, ctx);
  assert.equal(env.DB._raw.prepare("SELECT COUNT(*) AS c FROM rate_limits").get().c, 0);
  assert.equal((await call(env, "POST", "/v1/session", {}, {}, "192.0.2.7")).status, 200, "limit resets after prune");
});

test("internal errors are reported as 500 without leaking details", async () => {
  const env = makeEnv();
  env.DB.prepare = () => { throw new Error("db exploded: secret detail"); };
  const origError = console.error; console.error = () => {};
  try {
    const r = await call(env, "GET", "/v1/leaderboard");
    assert.equal(r.status, 500);
    assert.equal(r.data.error, "internal error");
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  } finally { console.error = origError; }
});
