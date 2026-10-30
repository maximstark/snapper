// The preload runs in Electron's isolated world; here it runs in a node:vm sandbox with fakes, to test
// the pure logic: gamepad wall lines, the pad mark combo, pacing-drop detection, key recording.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../../packages/host/preload/preload.cjs", import.meta.url)), "utf8");

function boot(opts = {}) {
  const sent = [];
  const raf = [];
  const timers = [];
  const listeners = {};
  let pads = [];
  let now = 0;
  const electron = {
    contextBridge: { exposeInMainWorld(name, api) { sandbox.exposed = { name, api }; } },
    ipcRenderer: { send: (ch, ...a) => sent.push({ ch, a }), on: (ch, f) => { sandbox.onMain = f; } },
  };
  const sandbox = {
    require: id => { assert.equal(id, "electron"); return electron; },
    process: { argv: ["x", `--snapper-opts=${encodeURIComponent(JSON.stringify({ expectedMs: 16.667, fpsDropMs: 250, fpsDropRun: 10, padMark: [8, 9], padMarkHoldMs: 400, ...opts }))}`] },
    document: { readyState: "loading", addEventListener() {}, documentElement: null, visibilityState: "visible", activeElement: null },
    window: { addEventListener: (t, f) => { (listeners[t] ||= []).push(f); } },
    navigator: { getGamepads: () => pads },
    performance: { now: () => now },
    requestAnimationFrame: f => { raf.push(f); return raf.length; },
    setInterval: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    setTimeout: () => 0, clearTimeout() {},
    innerWidth: 100, innerHeight: 100, location: { href: "http://x/" }, getComputedStyle: () => ({ display: "none" }),
    Float64Array, Int32Array, Math, JSON, Array, Set, Map, Promise, Object, Number, String, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return {
    sent, listeners,
    setPads: p => { pads = p; },
    frame(ts) { now = ts; const f = raf.shift(); f(ts); },
    flushWall() { now += 1; timers.find(t => t.ms === 250).f(); },
    msgs: kind => sent.filter(s => s.ch === "snapper:p" && s.a[0] === kind).map(s => s.a[1]),
    arm() { sandbox.onMain({}, "arm", true); },
    sandbox,
  };
}

const pad = (pressed = [], axes = [0, 0]) => ({
  index: 0, id: "Fake Pad", mapping: "standard", axes,
  buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
});

test("preload: gamepad changes become wall lines (bitmask + rounded axes), unchanged polls do not", () => {
  const h = boot();
  h.setPads([pad([0], [0.5, -0.987])]);
  h.frame(0); h.frame(16);
  h.setPads([pad([0], [0.5, -0.987])]);
  h.frame(32);
  h.setPads([pad([0, 2], [0.5, -0.987])]);
  h.frame(48);
  h.flushWall();
  const [batch] = h.msgs("wall");
  assert.equal(batch.ev.length, 2);
  assert.equal(JSON.stringify({ p: batch.ev[0].p, b: batch.ev[0].b, ax: batch.ev[0].ax }), JSON.stringify({ p: 0, b: 1, ax: [0.5, -0.99] }));
  assert.equal(batch.ev[1].b, 5);
});

test("preload: pad mark combo needs the hold time, fires once, 2 s cooldown", () => {
  const h = boot();
  h.setPads([pad([8, 9])]);
  h.frame(0);
  h.frame(200);
  assert.equal(h.msgs("padmark").length, 0);
  h.frame(450);
  assert.equal(h.msgs("padmark").length, 1);
  h.frame(900);
  assert.equal(h.msgs("padmark").length, 1, "held: no repeat");
  h.setPads([pad([])]);
  h.frame(1000);
  h.setPads([pad([8, 9])]);
  h.frame(1100); h.frame(1600);
  assert.equal(h.msgs("padmark").length, 1, "within the 2 s cooldown");
  h.setPads([pad([])]); h.frame(2000);
  h.setPads([pad([8, 9])]);
  h.frame(2500); h.frame(3000);
  assert.equal(h.msgs("padmark").length, 2);
});

test("preload: keys are recorded once per press, by code, repeats deduplicated", () => {
  const h = boot();
  const key = (type, code, repeat = false) => h.listeners[type].forEach(f => f({ type, code, key: code, repeat, stopImmediatePropagation() {}, stopPropagation() {}, preventDefault() {} }));
  key("keydown", "KeyD"); key("keydown", "KeyD", true); key("keyup", "KeyD");
  h.flushWall();
  const ev = h.msgs("wall")[0].ev;
  assert.equal(JSON.stringify(ev.map(e => [e.k, e.d])), JSON.stringify([["KeyD", 1], ["KeyD", 0]]));
});

test("preload: the bridge forwards only the D-013 message types", () => {
  const h = boot();
  const api = h.sandbox.exposed.api;
  assert.equal(h.sandbox.exposed.name, "__snapperBridge");
  api.send("log", { frame: 1, level: "warn", msg: "x" });
  api.send("bogus", {});
  const sdk = h.msgs("sdk");
  assert.equal(sdk.length, 1);
  assert.equal(sdk[0].type, "log");
  api.sendTape(Int32Array.from([0, 5, 0]), Int32Array.from([0, 3, 0]), 2);
  const tape = h.sent.find(s => s.ch === "snapper:tape");
  assert.equal(JSON.stringify(Array.from(tape.a[0])), "[0,5]");
  assert.equal(tape.a[2], 2);
});

test("preload: pacing drops (single interval or a run), armed 2 s after ready, 10 s cooldown", () => {
  const h = boot();
  let t = 0;
  const run = (n, step) => { for (let i = 0; i < n; i++) { t += step; h.frame(t); } };
  run(10, 16.7);
  h.arm();
  run(5, 300);                                     // within the 2 s arming delay: ignored (boot hitches)
  assert.equal(h.msgs("fps").length, 0);
  run(200, 16.7);
  assert.equal(h.msgs("fps").length, 0);
  run(1, 300);
  assert.equal(h.msgs("fps").length, 1);
  assert.equal(h.msgs("fps")[0].kind, "single");
  assert.ok(h.msgs("fps")[0].worstMs >= 299);
  run(30, 16.7);
  run(1, 300);                                     // inside the 10 s cooldown
  assert.equal(h.msgs("fps").length, 1);
  run(700, 16.7);                                  // > 10 s later
  run(10, 40);                                     // ten consecutive intervals over 2 x expected
  assert.equal(h.msgs("fps").length, 2);
  assert.equal(h.msgs("fps")[1].kind, "run");
});
