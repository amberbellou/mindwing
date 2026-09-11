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
// Expose internals for assertions (test build only; the shipped file has no such hook).
const hook = `\nwindow.__mw = () => ({ state, hearts, bursts, score, level, killCount, quota, player, bullets, eagles, fires, parts, motes, boss, overlayOpen, inv, banner, card: currentCard, apiq: api.debug() });\n`;
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
    state: () => sandbox.__mw()
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
    const count = (sql, ...a) => raw.prepare(sql).get(...a).c;
    out.db = {
      sessions: count("SELECT COUNT(*) AS c FROM sessions"),
      won: count("SELECT COUNT(*) AS c FROM sessions WHERE won = 1 AND max_level = 4"),
      lesson_views: count("SELECT COUNT(*) AS c FROM events WHERE type = 'lesson_view' AND n > 0"),
      quiz_correct: count("SELECT COUNT(*) AS c FROM events WHERE type = 'quiz' AND v = 1"),
      level_clears: count("SELECT COUNT(DISTINCT level) AS c FROM events WHERE type = 'level_clear'"),
      wins: count("SELECT COUNT(*) AS c FROM events WHERE type = 'win'"),
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

console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
