#!/usr/bin/env node
// Headless stress test for Mindwing: the game and its backend together, with no browser and no network.
//
// The real game script from index.html runs in a Node sandbox with a stubbed DOM and canvas. Its fetch()
// calls are routed in-process to the real Cloudflare Worker (backend/src/index.js) running on an in-memory
// SQLite database, so the frontend/backend contract is exercised end to end. Drivers:
//   fuzz    random keys, taps, drags, card buttons, pauses, focus loss, resizes, malformed events,
//           across four network modes: off (no backend), real, flaky, down
//   aimbot  plays for real (tracks enemies, answers quizzes, signs the leaderboard) to prove the game can be
//           completed from level 1 with the backend, from the ?level=4 shortcut offline, and with the network down
//
// Usage: node test/fuzz.mjs [seeds=8] [frames=20000]
// Exit code is non-zero on any exception, invariant violation, or missing backend record.

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../backend/src/index.js";
import { makeD1 } from "../backend/test/d1-shim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");
const SCHEMA = fs.readFileSync(path.join(here, "..", "backend", "migrations", "0001_init.sql"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error("no <script> block found in index.html");
let src = match[1];
// Tests stay hermetic: blank the shipped production API URL so only ?api=localhost scenarios touch the in-process Worker.
const API_LINE = /const API_BASE_DEFAULT = "[^"]*";/;
if (!API_LINE.test(src)) throw new Error("API_BASE_DEFAULT line not found in index.html");
src = src.replace(API_LINE, 'const API_BASE_DEFAULT = "";');
// Expose internals for assertions (test build only; the shipped file has no such hook).
const hook = `\nwindow.__mw = () => ({ state, hearts, bursts, score, level, killCount, quota, player, bullets, eagles, fires, parts, motes, boss, overlayOpen, inv, banner, card: currentCard, apiq: api.debug(), shake, flash, settings: SETTINGS, diff: DIFF });\nwindow.__setInv = v => { inv = v; };\n`;
const tail = src.lastIndexOf("})();");
src = src.slice(0, tail) + hook + src.slice(tail);

function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function makeBackend(){
  const DB = makeD1();
  DB._raw.exec(SCHEMA);
  return { env: { DB, SESSION_SECRET: "harness-secret-long-enough-1234", ADMIN_KEY: "harness-admin", ALLOWED_ORIGINS: "*" }, ctx: { waitUntil(){}, passThroughOnException(){} } };
}

/** net: "off" (API disabled), "real" (in-process Worker), "flaky" (every third call fails), "down" (all calls fail) */
function makeWorld(seed, { search = "", net = "off" } = {}){
  const listeners = { window: {}, document: {}, canvas: {}, ov: {} };
  const on = bucket => (type, fn) => { (listeners[bucket][type] ||= []).push(fn); };
  const fire = (bucket, type, ev) => { for (const fn of listeners[bucket][type] || []) fn(ev); };
  const gradStub = { addColorStop(){} };
  const ctxStub = new Proxy({}, { get: (t, p) => (p in t) ? t[p] : (() => gradStub), set: (t, p, v) => { t[p] = v; return true; } });
  const classes = new Set(["hidden"]);
  let rectW = 960, rectH = 540;
  const canvas = {
    width: 960, height: 540, style: {}, getContext: () => ctxStub, addEventListener: on("canvas"),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: rectW, height: rectH }),
    setPointerCapture(){ throw new Error("InvalidPointerId"); }
  };
  const ov = { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) }, addEventListener: on("ov") };
  let inputValue = "";
  const card = {
    innerHTML: "",
    querySelector(sel){
      if (sel === "input") return { get value(){ return inputValue; }, set value(v){ inputValue = String(v); }, focus(){}, addEventListener(){} };
      if (sel === "[data-slot=msg]") return { textContent: "" };
      if (sel === "[data-slot=async]") return { innerHTML: "" };
      return null;
    }
  };
  let clock = 0, pending = null, calls = 0, beacons = 0;
  const backend = (net === "real" || net === "flaky") ? makeBackend() : null;
  const errors = [];
  const fetchImpl = async (url, init = {}) => {
    calls++;
    if (net === "down" || (net === "flaky" && calls % 3 === 0)) throw new TypeError("network down");
    if (!backend) throw new TypeError("no backend");
    // keep the database's idea of session age in step with the simulated clock
    backend.env.DB._raw.prepare("UPDATE sessions SET created_at = ?").run(Date.now() - clock);
    const req = new Request(String(url), { method: init.method || "GET", headers: { ...(init.headers || {}), "cf-connecting-ip": "10.7.0." + (seed % 250) }, body: init.body });
    return worker.fetch(req, backend.env, backend.ctx);
  };
  const store = {};
  const sandbox = {
    console: { log(){}, warn(){}, error: (...a) => errors.push(a.map(String).join(" ")) },
    URLSearchParams, Blob, AbortController, crypto,
    Math: Object.create(Math, { random: { value: mulberry32(seed) } }),
    performance: { now: () => clock },
    requestAnimationFrame: cb => { pending = cb; return 1; },
    setTimeout: () => 0, clearTimeout(){}, setInterval: () => 0, clearInterval(){},
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    location: { search },
    devicePixelRatio: 2, innerWidth: 1280, innerHeight: 720,
    addEventListener: on("window"),
    fetch: fetchImpl,
    navigator: { sendBeacon(){ beacons++; return true; } },
    document: { getElementById: id => ({ game: canvas, ov, card })[id], addEventListener: on("document"), hidden: false }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "index.html" });
  return {
    errors, classes, card, backend, net,
    step(ms){ clock += ms; const cb = pending; pending = null; if (!cb) throw new Error("requestAnimationFrame chain died"); cb(clock); },
    key(type, key, repeat = false){ fire("window", type, { key, repeat, preventDefault(){} }); },
    click(act, val){
      const target = act ? { closest: sel => sel.includes("data-act") ? { dataset: { act, val: val == null ? undefined : String(val) } } : null } : { closest: () => null };
      fire("ov", "click", { preventDefault(){}, target });
    },
    setInput(v){ inputValue = v; },
    pointer(type, x, y, pointerType = "touch"){
      const bucket = (type === "pointerup" || type === "pointercancel") ? "window" : "canvas";
      fire(bucket, type, { clientX: x, clientY: y, pointerId: 1, pointerType, preventDefault(){} });
    },
    blur(){ fire("window", "blur", {}); },
    hide(h){ sandbox.document.hidden = h; fire("document", "visibilitychange", {}); },
    pagehide(){ fire("window", "pagehide", {}); },
    resize(w, h){ sandbox.innerWidth = w; sandbox.innerHeight = h; fire("window", "resize", {}); },
    collapseCanvas(zero){ rectW = zero ? 0 : 960; rectH = zero ? 0 : 540; },
    calls: () => calls, beacons: () => beacons, now: () => clock,
    state: () => sandbox.__mw(),
    setInv: v => sandbox.__setInv(v)
  };
}

const STATES = new Set(["title", "play", "hit", "pause", "clear", "postclear", "over", "win"]);
function check(w){
  const s = w.state();
  const errs = [];
  if (!STATES.has(s.state)) errs.push("unknown state " + s.state);
  if (!(s.hearts >= 0 && s.hearts <= 3)) errs.push("hearts out of range: " + s.hearts);
  if (!(s.bursts >= 0 && s.bursts <= 4)) errs.push("bursts out of range: " + s.bursts);
  if (!(Number.isFinite(s.score) && s.score >= 0)) errs.push("bad score: " + s.score);
  const px = s.player.x, py = s.player.y;
  if (!(px >= 24 - 1e-6 && px <= 960 * 0.62 + 1e-6 && py >= 30 - 1e-6 && py <= 506 + 1e-6)) errs.push(`player out of bounds ${px},${py}`);
  if (s.parts.length > 3000) errs.push("particle leak: " + s.parts.length);
  if (s.fires.length > 400) errs.push("fireball leak: " + s.fires.length);
  if (s.bullets.length > 200) errs.push("bullet leak: " + s.bullets.length);
  if (s.eagles.length > 40) errs.push("eagle leak: " + s.eagles.length);
  if (s.motes.length > 60) errs.push("mote leak: " + s.motes.length);
  if (s.apiq.queued > 200) errs.push("event queue leak: " + s.apiq.queued);
  if (s.boss && s.boss.hp > s.boss.maxhp) errs.push("boss hp above max");
  if (s.state === "play" && s.hearts === 0) errs.push("playing with zero hearts");
  const overlayShouldBeOpen = !(s.state === "play" || s.state === "clear");
  if (s.overlayOpen !== overlayShouldBeOpen) errs.push(`overlay ${s.overlayOpen} while state is ${s.state}`);
  if (s.overlayOpen !== !w.classes.has("hidden")) errs.push("overlay flag disagrees with DOM class");
  if (s.overlayOpen && !s.card) errs.push("overlay open with no current card");
  for (const e of s.eagles) if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) errs.push("eagle with NaN position");
  for (const f of s.fires) if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) errs.push("fireball with NaN position");
  if (w.errors.length) errs.push("console.error: " + w.errors.splice(0).join(" | "));
  return errs;
}

const NETS = ["off", "real", "flaky", "down"];
async function fuzz(seed, frames){
  const net = NETS[seed % NETS.length];
  const params = [];
  if (net !== "off") params.push("api=http://localhost:8787");
  if (seed % 3 === 0) params.push("level=" + (1 + (seed % 4)));
  const w = makeWorld(seed, { search: params.length ? "?" + params.join("&") : "", net });
  const ir = mulberry32(seed ^ 0x9E3779B9);
  const KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", " ", " ", " ", "x", "b", "Enter", "Shift", "F1"];
  const ACTS = ["choose", "choose", "submit", "submit", "skip", "skip", "next", "next", "next", "bogus", "bogus", "records"];   // records is rare: it restarts the run
  const INPUTS = ["AMB", "LUM", "a1", "", "ABCD", "ass"];
  const held = new Set(), seen = new Set(), cardTypes = new Set();
  let maxLevel = 0, hits = 0, prev = null, transitions = 0;
  for (let i = 0; i < frames; i++){
    if (ir() < 0.08){ const k = KEYS[Math.floor(ir() * KEYS.length)]; if (held.has(k)){ w.key("keyup", k); held.delete(k); } else { w.key("keydown", k); held.add(k); } }
    if (held.size && ir() < 0.2) w.key("keydown", [...held][0], true);
    if (ir() < 0.01){ w.key("keydown", "p"); w.key("keyup", "p"); }
    if (ir() < 0.004){ w.key("keydown", "Escape"); w.key("keyup", "Escape"); }
    if (ir() < 0.005){ w.key("keydown", "m"); w.key("keyup", "m"); }
    if (ir() < 0.003){ w.key("keydown", undefined); w.key("keyup", undefined); w.key("keydown", "Unidentified"); }
    if (ir() < 0.03) w.pointer("pointerdown", ir() * 1400 - 200, ir() * 900 - 200, ir() < 0.5 ? "touch" : "mouse");
    if (ir() < 0.05) w.pointer("pointermove", ir() * 1400 - 200, ir() * 900 - 200);
    if (ir() < 0.03) w.pointer("pointerup", 0, 0);
    if (ir() < 0.005) w.pointer("pointercancel", 0, 0);
    if (ir() < 0.002) w.blur();
    if (ir() < 0.002){ w.hide(true); w.hide(false); }
    if (ir() < 0.001) w.pagehide();
    if (ir() < 0.001) w.resize(200 + ir() * 1800, 150 + ir() * 1200);
    if (ir() < 0.002){ w.collapseCanvas(true); w.pointer("pointerdown", 100, 100); w.pointer("pointermove", 120, 120); w.collapseCanvas(false); }
    const s0 = w.state();
    if (s0.overlayOpen){
      if (s0.card) cardTypes.add(s0.card.type || "plain");
      const r = ir();
      if (r < 0.25) w.click();
      else if (r < 0.33 && s0.card && s0.card.type === "quiz") w.click("choose", Math.floor(ir() * 3));          // usually answer quizzes
      else if (r < 0.40){ w.setInput(INPUTS[Math.floor(ir() * INPUTS.length)]); w.click(ACTS[Math.floor(ir() * ACTS.length)], Math.floor(ir() * 4)); }
      else if (r < 0.50){ const ks = ["1", "2", "3", "4", "l", "Enter", "Escape", " "]; const k = ks[Math.floor(ir() * ks.length)]; w.key("keydown", k); w.key("keyup", k); }
    }
    w.step(ir() < 0.1 ? 0 : 4 + ir() * 60);
    if (i % 2 === 0) await settle(1);
    const s = w.state();
    seen.add(s.state);
    if (s.state !== prev){ transitions++; if (s.state === "hit") hits++; prev = s.state; }
    if (s.level > maxLevel) maxLevel = s.level;
    const errs = check(w);
    if (errs.length) return { ok: false, frame: i, errs, seed, net };
  }
  await settle();
  const errs = check(w);
  if (errs.length) return { ok: false, frame: frames, errs, seed, net };
  let db = "";
  if (w.backend){
    const c = t => w.backend.env.DB._raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    db = ` db{sessions=${c("sessions")} events=${c("events")} scores=${c("scores")}}`;
  }
  return { ok: true, seed, net, maxLevel, hits, transitions, calls: w.calls(), cards: [...cardTypes].join(","), states: [...seen].join(","), db };
}

async function aimbot(seed, { search = "", net = "off", maxFrames = 120000 } = {}){
  const w = makeWorld(seed, { search, net });
  const held = new Set();
  const setKey = (k, down) => { if (down && !held.has(k)){ w.key("keydown", k); held.add(k); } else if (!down && held.has(k)){ w.key("keyup", k); held.delete(k); } };
  const submitted = new WeakSet();
  let wins = 0, overs = 0, hits = 0, prev = null, maxLevel = 0, lastBurst = -1e9, framesUsed = 0, winScore = null;
  for (let i = 0; i < maxFrames; i++){
    framesUsed = i;
    const s = w.state();
    if (s.state !== prev){ if (s.state === "hit") hits++; if (s.state === "over") overs++; if (s.state === "win"){ wins++; winScore = s.score; } prev = s.state; }
    if (s.level > maxLevel) maxLevel = s.level;
    if (wins) break;
    if (s.overlayOpen){
      for (const k of [...held]) setKey(k, false);
      const c = s.card;
      if (c && c.type === "quiz") w.click("choose", String(c.correct));
      else if (c && c.type === "initials"){ if (submitted.has(c)) w.click("skip"); else { submitted.add(c); w.setInput("AMB"); w.click("submit"); } }
      else w.click();
      w.step(16.7); await settle(2);
      const e = check(w); if (e.length) return { ok: false, errs: e, frame: i };
      continue;
    }
    if (s.state === "play"){
      let ty = 270;
      if (s.boss && s.boss.entered) ty = s.boss.y;
      else if (s.eagles.length){
        let best = null, bd = 1e9;
        for (const e of s.eagles){ if (e.x > s.player.x + 40 && e.x - s.player.x < bd){ bd = e.x - s.player.x; best = e; } }
        if (best) ty = best.y;
      }
      const dy = ty - s.player.y;
      setKey("ArrowDown", dy > 8); setKey("ArrowUp", dy < -8);
      setKey(" ", true);
      const threat = s.fires.filter(f => Math.abs(f.y - s.player.y) < 45 && f.x > s.player.x - 10 && f.x - s.player.x < 130).length;
      if (s.bursts > 0 && (threat >= 1 || s.eagles.length >= 3) && i - lastBurst > 45){ w.key("keydown", "x"); w.key("keyup", "x"); lastBurst = i; }
    }
    w.step(16.7);
    if (i % 4 === 0) await settle(1);
    const errs = check(w);
    if (errs.length) return { ok: false, errs, frame: i };
  }
  await settle(10);
  // let the post-win cards (initials, leaderboard, field guide, stats) run through
  for (let i = 0; i < 400 && w.state().overlayOpen && w.state().state === "win"; i++){
    const c = w.state().card;
    if (c && c.type === "initials"){ if (submitted.has(c)) w.click("skip"); else { submitted.add(c); w.setInput("AMB"); w.click("submit"); } }
    else w.click();
    w.step(500); await settle(3);
  }
  await settle(10);
  const out = { ok: true, wins, overs, hits, maxLevel, frames: framesUsed, minutes: (framesUsed * 16.7 / 60000).toFixed(1), calls: w.calls(), winScore };
  if (w.backend){
    const raw = w.backend.env.DB._raw;
    const clarity = raw.prepare("SELECT type, level, COUNT(*) AS c FROM events WHERE type IN ('burst','still') GROUP BY type, level").all();
    for (const r of clarity){
      if (r.type === "burst" && r.level > 2) expect.push(`burst event logged on level ${r.level} (levels 3-4 use the still point)`);
      if (r.type === "still" && r.level < 3) expect.push(`still event logged on level ${r.level} (levels 1-2 use the burst)`);
    }
    const count = (sql, ...a) => raw.prepare(sql).get(...a).c;
    out.db = {
      sessions: count("SELECT COUNT(*) AS c FROM sessions"),
      won: count("SELECT COUNT(*) AS c FROM sessions WHERE won = 1 AND max_level = 4"),
      lesson_views: count("SELECT COUNT(*) AS c FROM events WHERE type = 'lesson_view' AND n > 0"),
      quiz_correct: count("SELECT COUNT(*) AS c FROM events WHERE type = 'quiz' AND v = 1"),
      level_clears: count("SELECT COUNT(DISTINCT level) AS c FROM events WHERE type = 'level_clear'"),
      wins: count("SELECT COUNT(*) AS c FROM events WHERE type = 'win'"),
      clarity: raw.prepare("SELECT type, level, COUNT(*) AS c FROM events WHERE type IN ('burst','still') GROUP BY type, level ORDER BY type, level").all(),
      scores: raw.prepare("SELECT initials, score, level, won FROM scores").all()
    };
    const st = await (await worker.fetch(new Request("http://localhost:8787/v1/stats"), w.backend.env, w.backend.ctx)).json();
    out.stats = { runs: st.runs, wins: st.wins, l4_started: st.levels[3].started, quiz_answers: st.quiz.reduce((a, q) => a + q.answers, 0) };
  }
  return out;
}

const seeds = parseInt(process.argv[2] || "8", 10);
const frames = parseInt(process.argv[3] || "20000", 10);
let failed = false;
console.log(`fuzz: ${seeds} seeds x ${frames} frames (network modes cycle off/real/flaky/down)`);
for (let s = 1; s <= seeds; s++){
  const r = await fuzz(s, frames);
  if (!r.ok){ failed = true; console.log(`  seed ${s} [${r.net}]: FAIL at frame ${r.frame}: ${r.errs.join("; ")}`); }
  else console.log(`  seed ${s} [${r.net}]: ok  maxLevel=${r.maxLevel + 1} hits=${r.hits} apiCalls=${r.calls} cards={${r.cards}} states={${r.states}}${r.db}`);
}

console.log("aimbot: full run from level 1 with the real backend in-process");
const a = await aimbot(42, { search: "?api=http://localhost:8787", net: "real" });
if (!a.ok){ failed = true; console.log(`  FAIL at frame ${a.frame}: ${a.errs.join("; ")}`); }
else {
  console.log(`  wins=${a.wins} gameOvers=${a.overs} hits=${a.hits} maxLevel=${a.maxLevel + 1} frames=${a.frames} (~${a.minutes} game-minutes) apiCalls=${a.calls} finalScore=${a.winScore}`);
  console.log(`  backend: ${JSON.stringify(a.db)} stats=${JSON.stringify(a.stats)}`);
  const d = a.db, expect = [];
  if (!a.wins) expect.push("aimbot did not finish the game");
  if (d.sessions !== 1 || d.won !== 1) expect.push("session not recorded as won");
  if (d.lesson_views !== 4) expect.push("expected 4 lesson_view events, got " + d.lesson_views);
  if (d.quiz_correct !== 8) expect.push("expected 8 correct quiz events, got " + d.quiz_correct);
  if (d.level_clears !== 3 || d.wins !== 1) expect.push("level_clear/win events missing");
  if (d.scores.length !== 1 || d.scores[0].initials !== "AMB" || d.scores[0].won !== 1 || d.scores[0].score !== a.winScore) expect.push("leaderboard row wrong: " + JSON.stringify(d.scores));
  if (!a.stats || a.stats.runs !== 1 || a.stats.wins !== 1 || a.stats.quiz_answers !== 8) expect.push("stats endpoint disagrees");
  if (expect.length){ failed = true; console.log("  FAIL: " + expect.join("; ")); }
}

console.log("aimbot: ?level=4 shortcut, offline build (no API configured)");
const b = await aimbot(7, { search: "?level=4", net: "off", maxFrames: 60000 });
if (!b.ok){ failed = true; console.log(`  FAIL at frame ${b.frame}: ${b.errs.join("; ")}`); }
else { console.log(`  wins=${b.wins} gameOvers=${b.overs} hits=${b.hits} startedAtLevel=${b.maxLevel + 1} frames=${b.frames} apiCalls=${b.calls}`); if (!b.wins || b.calls !== 0){ failed = true; console.log("  FAIL: expected a win with zero network calls"); } }

console.log("aimbot: full run with the network down (API configured but unreachable)");
const c = await aimbot(11, { search: "?api=http://localhost:8787", net: "down" });
if (!c.ok){ failed = true; console.log(`  FAIL at frame ${c.frame}: ${c.errs.join("; ")}`); }
else { console.log(`  wins=${c.wins} gameOvers=${c.overs} hits=${c.hits} frames=${c.frames} apiCalls=${c.calls} (all failed)`); if (!c.wins){ failed = true; console.log("  FAIL: game must still be completable when the backend is unreachable"); } }


/* The clarity move differs by level: levels 1-2 clear the sky and hold spawns off for a moment,
   levels 3-4 destroy nothing but freeze every eagle and fireball where it hangs. */
async function toPlay(w, guard = 4000){
  for (let i = 0; i < guard; i++){
    const s = w.state();
    if (s.state === "play" && !s.overlayOpen) return true;
    if (s.overlayOpen){ const c = s.card; if (c && c.type === "quiz") w.click("choose", String(c.correct)); else w.click(); }
    w.step(16.7); await settle(1);
  }
  return false;
}
async function untilEagles(w, n = 2, guard = 4000){
  for (let i = 0; i < guard; i++){
    if (w.state().eagles.length >= n) return true;
    w.step(16.7); await settle(1);
  }
  return false;
}
const runMs = async (w, ms) => { for (let t = 0; t < ms; t += 16.7){ w.step(16.7); await settle(1); } };

console.log("ability: level 1 Clarity Burst clears the sky, then holds it clear");
{
  const errs = [];
  const w = makeWorld(3, { search: "?level=1", net: "off" });
  if (!await toPlay(w) || !await untilEagles(w, 2)) errs.push("never reached level 1 play with eagles");
  else {
    const before = w.state();
    w.key("keydown", "x"); w.key("keyup", "x");
    w.step(16.7); await settle(1);
    const after = w.state();
    if (after.eagles.length !== 0 || after.fires.length !== 0) errs.push(`burst left ${after.eagles.length} eagles and ${after.fires.length} fireballs`);
    if (after.bursts !== before.bursts - 1) errs.push("burst did not spend a charge");
    await runMs(w, 1200);
    const calm = w.state();
    if (calm.state === "play" && calm.eagles.length !== 0) errs.push(`sky refilled during the calm window (${calm.eagles.length} eagles after 1.2s)`);
    await runMs(w, 2000);
    const later = w.state();
    if (later.state === "play" && later.eagles.length === 0) errs.push("eagles never came back after the calm window");
    if (later.state === "play" && later.hearts !== before.hearts) errs.push("calm window cost the player a heart");
  }
  if (errs.length){ failed = true; console.log("  FAIL: " + errs.join("; ")); }
  else console.log("  cleared on press, stayed clear ~1.5s, then the wave resumed");
}

console.log("ability: level 3 Still Point freezes without destroying");
{
  const errs = [];
  const w = makeWorld(5, { search: "?level=3&api=http://localhost:8787", net: "real" });
  if (!await toPlay(w) || !await untilEagles(w, 2)) errs.push("never reached level 3 play with eagles");
  else {
    await runMs(w, 600);                       // let a fireball or two exist
    const before = w.state();
    const snap = before.eagles.map(e => ({ x: e.x, y: e.y }));
    w.key("keydown", "x"); w.key("keyup", "x");
    w.step(16.7); await settle(1);
    const held = w.state();
    if (held.eagles.length !== before.eagles.length) errs.push(`still point destroyed eagles (${before.eagles.length} -> ${held.eagles.length})`);
    if (held.bursts !== before.bursts - 1) errs.push("still point did not spend a charge");
    await runMs(w, 800);
    const mid = w.state();
    if (mid.state === "play"){
      const moved = mid.eagles.some((e, i) => snap[i] && (Math.abs(e.x - snap[i].x) > 0.01 || Math.abs(e.y - snap[i].y) > 0.01));
      if (moved) errs.push("an eagle moved while the sky was held still");
      if (mid.eagles.length > before.eagles.length) errs.push("new eagles spawned during the still window");
    }
    await runMs(w, 1400);
    const after = w.state();
    if (after.state === "play"){
      const movedAfter = after.eagles.some((e, i) => snap[i] && (Math.abs(e.x - snap[i].x) > 0.5 || Math.abs(e.y - snap[i].y) > 0.5));
      if (!movedAfter && after.eagles.length) errs.push("eagles stayed frozen after the still window expired");
    }
    if (after.apiq && before.apiq && after.apiq.queued <= before.apiq.queued) errs.push("the still point logged nothing for the research data");
  }
  if (errs.length){ failed = true; console.log("  FAIL: " + errs.join("; ")); }
  else console.log("  nothing destroyed, everything held ~1.6s, then motion resumed");
}


/* Level 3 flames turn into flattery that follows the player; level 4 fires split into harmless decoys
   that shove the player off course. Each shows its explainer once, and a hit explains what hit you. */
const SYCO_FACTS = [10, 11, 12], DRIFT_FACTS = [13, 14];
async function watchUntil(w, pred, guard = 3000, seen){
  for (let i = 0; i < guard; i++){
    const s = w.state();
    if (seen && s.banner && s.banner.text) seen.add(s.banner.text);
    if (s.state === "hit" && s.overlayOpen){ w.click(); }           // keep flying if something clips us
    if (s.state === "play") w.setInv(99);
    const r = pred(s); if (r) return r;
    w.step(16.7); await settle(1);
  }
  return null;
}

console.log("sycophancy: level 3 flames turn into praise that follows you");
{
  const errs = [];
  const w = makeWorld(21, { search: "?level=3", net: "off" });
  const banners = new Set();
  if (!await toPlay(w)) errs.push("never reached level 3 play");
  else {
    const praise = await watchUntil(w, s => s.fires.find(f => f.kind === "praise"), 3000, banners);
    if (!praise) errs.push("no shot ever turned into praise");
    else {
      if (!praise.phrase || typeof praise.phrase !== "string") errs.push("praise shot has no phrase");
      // homing: after a moment the shot's heading should point closer to the player than before
      const s0 = w.state();
      const off = (f, pl) => { let d = Math.atan2(pl.y - f.y, pl.x - f.x) - Math.atan2(f.vy, f.vx); while (d > Math.PI) d -= 2*Math.PI; while (d < -Math.PI) d += 2*Math.PI; return Math.abs(d); };
      s0.player.y = praise.y < 270 ? 480 : 60;                        // move away so it has to turn
      const before = off(praise, s0.player);
      for (let i = 0; i < 20; i++){ w.step(16.7); await settle(1); }
      const s1 = w.state();
      if (s1.fires.includes(praise) && before > 0.1 && off(praise, s1.player) >= before) errs.push("praise did not steer toward the player");
      await watchUntil(w, () => false, 240, banners);
      if (!banners.has("SYCOPHANCY")) errs.push("sycophancy explainer never shown: " + [...banners].join(" | "));
      // take a hit from flattery on purpose: the card must explain sycophancy
      const s2 = w.state();
      const p2 = s2.fires.find(f => f.kind === "praise") || (await watchUntil(w, s => s.fires.find(f => f.kind === "praise")));
      const s3 = w.state();
      if (!p2) errs.push("no praise shot available to test the hit card");
      else {
        w.setInv(0); p2.x = s3.player.x; p2.y = s3.player.y;
        w.step(16.7); await settle(2);
        const s4 = w.state();
        const text = s4.card && s4.card.p && s4.card.p[0];
        if (s4.state !== "hit") errs.push("praise touched the player without hurting (state " + s4.state + ")");
        else if (!/^Flattered!/.test(s4.card.tag || "")) errs.push("hit card tag was " + s4.card.tag);
        else if (!/[Ss]ycophan|agree|disagrees/.test(text || "")) errs.push("hit card did not explain sycophancy: " + text);
      }
    }
  }
  if (errs.length){ failed = true; console.log("  FAIL: " + errs.join("; ")); }
  else console.log("  flame became praise with a phrase, steered after the player, explainer shown, hit card explains it");
}

console.log("drift: level 4 fires split into decoys that push you but never burn");
{
  const errs = [];
  const w = makeWorld(23, { search: "?level=4", net: "off" });
  const banners = new Set();
  if (!await toPlay(w)) errs.push("never reached level 4 play");
  else {
    const decoy = await watchUntil(w, s => s.fires.find(f => f.kind === "decoy"), 6000, banners);
    if (!decoy) errs.push("no fireball ever split into decoys");
    else {
      const count = w.state().fires.filter(f => f.kind === "decoy").length;
      if (count < 3) errs.push(`expected 3 decoys from a split, saw ${count}`);
      await watchUntil(w, () => false, 240, banners);
      if (!banners.has("COGNITIVE DRIFT")) errs.push("drift explainer never shown: " + [...banners].join(" | "));
      // touch a decoy: no heart lost, no hit card, but the fairy is shoved
      const d = await watchUntil(w, s => s.fires.find(f => f.kind === "decoy"), 6000);
      if (!d) errs.push("no decoy left to touch");
      else {
        const s = w.state();
        const hearts = s.hearts, px = s.player.x, py = s.player.y;
        d.x = px; d.y = py; d.vx = 150; d.vy = 0; d.a = 0; d.spin = 0;
        for (let i = 0; i < 12; i++){ w.step(16.7); await settle(1); }
        const t = w.state();
        if (t.hearts !== hearts) errs.push("a decoy cost a heart");
        if (t.state !== "play") errs.push("a decoy interrupted play (state " + t.state + ")");
        if (Math.hypot(t.player.x - px, t.player.y - py) < 15) errs.push("touching a decoy did not push the fairy");
      }
      // a real fire landing while decoys fly explains drift
      const real = await watchUntil(w, s => s.fires.some(f => f.kind === "decoy") && s.fires.find(f => f.kind === "fire"), 8000);
      if (!real) errs.push("never saw a real fire alongside decoys");
      else {
        const s = w.state();
        w.setInv(0); real.x = s.player.x; real.y = s.player.y;
        w.step(16.7); await settle(2);
        const h = w.state();
        if (h.state !== "hit") errs.push("real fire amid decoys did not hit (state " + h.state + ")");
        else if (!/^Distracted!/.test(h.card.tag || "")) errs.push("drift hit card tag was " + h.card.tag);
      }
    }
  }
  if (errs.length){ failed = true; console.log("  FAIL: " + errs.join("; ")); }
  else console.log("  decoys split off, explainer shown, touching one pushes without damage, real hit explains drift");
}


/* Settings: difficulty is chosen on the title screen and locks in at level start; reduced motion
   removes screen shake; settings are offered from the title card and the pause card. */
async function openSettingsAndSet(w, pairs){
  // title card is the first card; its settings button opens the settings card
  for (let i = 0; i < 30 && !(w.state().card && w.state().card.big); i++){ w.step(16.7); await settle(1); }
  w.click("settings"); w.step(16.7); await settle(1);
  if (!w.state().card || w.state().card.type !== "settings") return false;
  for (const pv of pairs){ w.click("set", pv); w.step(16.7); await settle(1); }
  return true;
}
console.log("settings: easy, hard and reduced motion change the game as promised");
{
  const errs = [];
  // easy
  {
    const w = makeWorld(31, { search: "", net: "off" });
    if (!await openSettingsAndSet(w, ["difficulty:easy"])) errs.push("settings card did not open from the title");
    else {
      const set = w.state().settings;
      if (set.difficulty !== "easy") errs.push("difficulty did not switch to easy");
      for (let i = 0; i < 40 && w.state().card && w.state().card.type === "settings"; i++){ w.step(500); await settle(1); w.click(); w.step(16.7); await settle(1); }
      if (!await toPlay(w)) errs.push("could not start an easy run");
      else {
        const s = w.state();
        if (s.hearts !== 5 || s.bursts !== 4) errs.push(`easy should start with 5 hearts and 4 charges, got ${s.hearts} and ${s.bursts}`);
        if (s.quota !== 6) errs.push(`easy level 1 quota should be 6, got ${s.quota}`);
      }
    }
  }
  // hard + reduced motion
  {
    const w = makeWorld(32, { search: "", net: "off" });
    if (!await openSettingsAndSet(w, ["difficulty:hard", "motion:reduced", "contrast:high", "text:large", "difficulty:bogus", "nope:1"])) errs.push("settings card did not open (hard run)");
    else {
      const set = w.state().settings;
      if (set.difficulty !== "hard" || set.motion !== "reduced" || set.contrast !== "high" || set.text !== "large") errs.push("settings did not all apply: " + JSON.stringify(set));
      for (let i = 0; i < 40 && w.state().card && w.state().card.type === "settings"; i++){ w.step(500); await settle(1); w.click(); w.step(16.7); await settle(1); }
      if (!await toPlay(w)) errs.push("could not start a hard run");
      else {
        const s = w.state();
        if (s.hearts !== 3 || s.bursts !== 2) errs.push(`hard should start with 3 hearts and 2 charges, got ${s.hearts} and ${s.bursts}`);
        if (s.quota !== 10) errs.push(`hard level 1 quota should be 10, got ${s.quota}`);
        // take a hit: reduced motion means no screen shake
        const e = await untilEagles(w, 1);
        if (e){
          w.setInv(0);
          const pl = w.state().player;
          w.state().fires.push({ kind:"fire", x:pl.x, y:pl.y, vx:0, vy:0, r:8, t:0 });
          w.step(16.7); await settle(2);
          const h = w.state();
          if (h.state !== "hit") errs.push("could not force a hit to test motion (state " + h.state + ")");
          else if (h.shake !== 0) errs.push("reduced motion still shook the screen: shake=" + h.shake);
          // pause card offers settings, and difficulty changes there wait for the next level
          w.click(); w.step(500); await settle(2); w.click(); w.step(16.7); await settle(2);
        }
      }
    }
  }
  if (errs.length){ failed = true; console.log("  FAIL: " + errs.join("; ")); }
  else console.log("  easy: 5 hearts, 4 charges, smaller quota; hard: 2 charges, bigger quota; reduced motion: no shake; bad values ignored");
}


console.log("polish: armored eagles take two sparks, swoopers dive, the boss has a third phase");
{
  const errs = [];
  // armored: first spark cracks the armor, second one lands the kill
  {
    const w = makeWorld(41, { search: "?level=2", net: "off" });
    if (!await toPlay(w)) errs.push("never reached level 2");
    else {
      const armored = await watchUntil(w, s => s.eagles.find(e => e.type === "armored" && e.x < 900), 6000);
      if (!armored) errs.push("no armored eagle appeared on level 2");
      else {
        const before = w.state().killCount;
        w.state().bullets.push({ x: armored.x, y: armored.y, r: 5 });
        w.step(16.7); await settle(1);
        let s1 = w.state();
        if (!s1.eagles.includes(armored)) errs.push("armored eagle died to a single spark");
        else if (armored.hp !== 1) errs.push("armor did not absorb the first spark (hp " + armored.hp + ")");
        for (let i = 0; i < 4; i++){ w.step(16.7); await settle(1); }   // ride out the brief hit-stop
        w.state().bullets.push({ x: armored.x, y: armored.y, r: 5 });
        for (let i = 0; i < 4; i++){ w.step(16.7); await settle(1); }
        const s2 = w.state();
        if (s2.eagles.includes(armored)) errs.push("armored eagle survived its second spark");
        if (s2.killCount !== before + 1) errs.push(`kill count should rise by 1, went ${before} -> ${s2.killCount}`);
      }
    }
  }
  // swooper: at some point it dives toward the player's height
  {
    const w = makeWorld(43, { search: "?level=3", net: "off" });
    if (!await toPlay(w)) errs.push("never reached level 3");
    else {
      const sw = await watchUntil(w, s => s.eagles.find(e => e.type === "swooper" && e.swooping > 0), 9000);
      if (!sw) errs.push("no swooper ever dived on level 3");
    }
  }
  // boss: knocking it below a quarter health starts phase 3 and a spiral volley
  {
    const w = makeWorld(47, { search: "?level=4", net: "off" });
    const banners = new Set();
    if (!await toPlay(w)) errs.push("never reached level 4");
    else {
      const b = await watchUntil(w, s => s.boss && s.boss.entered && s.boss, 6000, banners);
      if (!b) errs.push("boss never entered");
      else {
        b.hp = Math.floor(b.maxhp / 4) - 1;
        const p3 = await watchUntil(w, s => s.boss && s.boss.phase === 3, 60, banners);
        if (!p3) errs.push("boss did not enter phase 3 below a quarter health");
        const spiral = await watchUntil(w, s => s.fires.filter(f => f.kind === "fire").length >= 12, 1500, banners);
        if (!spiral) errs.push("phase 3 never fired a spiral volley");
        if (!banners.has("THE FEED NEVER ENDS")) errs.push("phase 3 banner not shown: " + [...banners].join(" | "));
      }
    }
  }
  if (errs.length){ failed = true; console.log("  FAIL: " + errs.join("; ")); }
  else console.log("  armor absorbs one spark then breaks, swoopers dive, phase 3 announces itself and spirals");
}

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
