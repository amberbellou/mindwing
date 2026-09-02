#!/usr/bin/env node
// Headless stress test for Mindwing.
//
// Runs the real game script from index.html inside a Node sandbox with a stubbed
// DOM and canvas, drives it for thousands of frames, and checks invariants every
// frame. Two drivers:
//   fuzz    random keys, taps, drags, pauses, blur, resize, malformed events
//   aimbot  plays for real (tracks enemies, bursts when threatened) to prove the
//           game can be completed from level 1 and from the ?level=4 shortcut
//
// Usage: node test/fuzz.mjs [seeds=6] [frames=20000]
// Exit code is non-zero if any exception or invariant violation occurs.

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error("no <script> block found in index.html");
let src = match[1];
// Expose internals for assertions (test build only; the shipped file has no such hook).
const hook = `\nwindow.__mw = () => ({ state, hearts, bursts, score, level, killCount, quota, player, bullets, eagles, fires, parts, motes, boss, overlayOpen, inv, banner });\n`;
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

function makeWorld(seed, search){
  const listeners = { window: {}, document: {}, canvas: {}, ov: {} };
  const on = bucket => (type, fn) => { (listeners[bucket][type] ||= []).push(fn); };
  const fire = (bucket, type, ev) => { for (const fn of listeners[bucket][type] || []) fn(ev); };
  const gradStub = { addColorStop(){} };
  const ctxStub = new Proxy({}, {
    get: (t, p) => (p in t) ? t[p] : (() => gradStub),
    set: (t, p, v) => { t[p] = v; return true; }
  });
  const classes = new Set(["hidden"]);
  const canvas = {
    width: 960, height: 540, style: {},
    getContext: () => ctxStub,
    addEventListener: on("canvas"),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: rectW, height: rectH }),
    setPointerCapture(){ throw new Error("InvalidPointerId"); }   // like a browser given a stale id
  };
  let rectW = 960, rectH = 540;
  const ov = {
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    addEventListener: on("ov")
  };
  const card = { innerHTML: "" };
  let clock = 0, pending = null;
  const store = {};
  const gameRng = mulberry32(seed);
  const errors = [];
  const sandbox = {
    console: { log(){}, warn(){}, error: (...a) => errors.push(a.map(String).join(" ")) },
    URLSearchParams,
    Math: Object.create(Math, { random: { value: gameRng } }),
    performance: { now: () => clock },
    requestAnimationFrame: cb => { pending = cb; return 1; },
    setTimeout: () => 0,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    location: { search },
    devicePixelRatio: 2, innerWidth: 1280, innerHeight: 720,
    addEventListener: on("window"),
    document: { getElementById: id => ({ game: canvas, ov, card })[id], addEventListener: on("document"), hidden: false }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "index.html" });
  return {
    errors, classes, card,
    step(ms){ clock += ms; const cb = pending; pending = null; if (!cb) throw new Error("requestAnimationFrame chain died"); cb(clock); },
    key(type, key, repeat = false){ fire("window", type, { key, repeat, preventDefault(){} }); },
    click(){ fire("ov", "click", { preventDefault(){} }); },
    pointer(type, x, y, pointerType = "touch"){
      const bucket = (type === "pointerup" || type === "pointercancel") ? "window" : "canvas";
      fire(bucket, type, { clientX: x, clientY: y, pointerId: 1, pointerType, preventDefault(){} });
    },
    blur(){ fire("window", "blur", {}); },
    hide(h){ sandbox.document.hidden = h; fire("document", "visibilitychange", {}); },
    resize(w, h){ sandbox.innerWidth = w; sandbox.innerHeight = h; fire("window", "resize", {}); },
    collapseCanvas(zero){ rectW = zero ? 0 : 960; rectH = zero ? 0 : 540; },
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
  if (s.boss && s.boss.hp > s.boss.maxhp) errs.push("boss hp above max");
  if (s.state === "play" && s.hearts === 0) errs.push("playing with zero hearts");
  const overlayShouldBeOpen = !(s.state === "play" || s.state === "clear");
  if (s.overlayOpen !== overlayShouldBeOpen) errs.push(`overlay ${s.overlayOpen} while state is ${s.state}`);
  if (s.overlayOpen !== !w.classes.has("hidden")) errs.push("overlay flag disagrees with DOM class");
  for (const e of s.eagles) if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) errs.push("eagle with NaN position");
  for (const f of s.fires) if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) errs.push("fireball with NaN position");
  if (w.errors.length) errs.push("console.error: " + w.errors.splice(0).join(" | "));
  return errs;
}

function fuzz(seed, frames){
  const w = makeWorld(seed, seed % 3 === 0 ? "?level=" + (1 + (seed % 4)) : "");
  const ir = mulberry32(seed ^ 0x9E3779B9);
  const KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", " ", " ", " ", "x", "b", "Enter", "Shift", "F1"];
  const held = new Set();
  const seen = new Set();
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
    if (ir() < 0.001) w.resize(200 + ir() * 1800, 150 + ir() * 1200);
    if (ir() < 0.002){ w.collapseCanvas(true); w.pointer("pointerdown", 100, 100); w.pointer("pointermove", 120, 120); w.collapseCanvas(false); }
    if (w.state().overlayOpen && ir() < 0.3) w.click();
    w.step(ir() < 0.1 ? 0 : 4 + ir() * 60);
    const s = w.state();
    seen.add(s.state);
    if (s.state !== prev){ transitions++; if (s.state === "hit") hits++; prev = s.state; }
    if (s.level > maxLevel) maxLevel = s.level;
    const errs = check(w);
    if (errs.length) return { ok: false, frame: i, errs, seed };
  }
  return { ok: true, seed, maxLevel, hits, transitions, states: [...seen].join(",") };
}

function aimbot(seed, search, maxFrames){
  const w = makeWorld(seed, search);
  const held = new Set();
  const setKey = (k, down) => { if (down && !held.has(k)){ w.key("keydown", k); held.add(k); } else if (!down && held.has(k)){ w.key("keyup", k); held.delete(k); } };
  let wins = 0, overs = 0, hits = 0, prev = null, maxLevel = 0, lastBurst = -1e9, framesUsed = 0;
  for (let i = 0; i < maxFrames; i++){
    framesUsed = i;
    const s = w.state();
    if (s.state !== prev){ if (s.state === "hit") hits++; if (s.state === "over") overs++; if (s.state === "win") wins++; prev = s.state; }
    if (s.level > maxLevel) maxLevel = s.level;
    if (wins) break;
    if (s.overlayOpen){ for (const k of [...held]) setKey(k, false); w.click(); w.step(16.7); const e = check(w); if (e.length) return { ok: false, errs: e, frame: i }; continue; }
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
    const errs = check(w);
    if (errs.length) return { ok: false, errs, frame: i };
  }
  return { ok: true, wins, overs, hits, maxLevel, frames: framesUsed, minutes: (framesUsed * 16.7 / 60000).toFixed(1) };
}

const seeds = parseInt(process.argv[2] || "6", 10);
const frames = parseInt(process.argv[3] || "20000", 10);
let failed = false;
console.log(`fuzz: ${seeds} seeds x ${frames} frames`);
for (let s = 1; s <= seeds; s++){
  const r = fuzz(s, frames);
  if (!r.ok){ failed = true; console.log(`  seed ${s}: FAIL at frame ${r.frame}: ${r.errs.join("; ")}`); }
  else console.log(`  seed ${s}: ok  maxLevel=${r.maxLevel + 1} hits=${r.hits} stateChanges=${r.transitions} states={${r.states}}`);
}
console.log("aimbot: full run from level 1");
const a = aimbot(42, "", 120000);
if (!a.ok){ failed = true; console.log(`  FAIL at frame ${a.frame}: ${a.errs.join("; ")}`); }
else { console.log(`  wins=${a.wins} gameOvers=${a.overs} hits=${a.hits} maxLevel=${a.maxLevel + 1} frames=${a.frames} (~${a.minutes} game-minutes)`); if (!a.wins){ failed = true; console.log("  FAIL: aimbot could not finish the game"); } }
console.log("aimbot: ?level=4 shortcut");
const b = aimbot(7, "?level=4", 60000);
if (!b.ok){ failed = true; console.log(`  FAIL at frame ${b.frame}: ${b.errs.join("; ")}`); }
else { console.log(`  wins=${b.wins} gameOvers=${b.overs} hits=${b.hits} startedAtLevel=${b.maxLevel + 1} frames=${b.frames}`); if (!b.wins){ failed = true; console.log("  FAIL: aimbot could not beat the boss from the shortcut"); } }
console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
