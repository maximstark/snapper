// SDK unit tests (G1): packages/sdk/snapper.js loaded in a vm context with a fake bridge and fake timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../../packages/sdk/snapper.js", import.meta.url)), "utf8");

// Fresh context. Fake clock + interval list; optional bridge recording every call.
function make({ bridge = false } = {}) {
  const clock = { t: 1000 };
  const intervals = [];
  const calls = [];
  const sandbox = {
    performance: { now: () => clock.t },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const fakeBridge = {
    send: (type, payload) => calls.push({ type, payload: JSON.parse(JSON.stringify(payload)) }),
    sendTape: (f, m, n) => calls.push({ type: "tape", f: Array.from(f), m: Array.from(m), n, isI32: f instanceof vm.runInContext("Int32Array", ctx) }),
  };
  if (bridge) sandbox.__snapperBridge = fakeBridge;
  vm.runInContext(SRC, ctx);
  return {
    sn: sandbox.snapper, ctx, clock, intervals, calls, sandbox, fakeBridge,
    attach() { sandbox.__snapperBridge = fakeBridge; },
    advance(ms) { clock.t += ms; for (const i of intervals) for (let k = 0; k < ms / i.ms; k++) i.fn(); },
    of(type) { return calls.filter(c => c.type === type); },
  };
}
const J = v => JSON.parse(JSON.stringify(v));

test("identity: version, attached getter, existing snapper kept", () => {
  const h = make();
  assert.equal(h.sn.version, "1.0.0");
  assert.equal(h.sn.attached, false);
  assert.equal(h.sn.frame(), -1);
  const first = h.sn;
  vm.runInContext(SRC, h.ctx);                         // second load must not replace it
  assert.equal(h.sandbox.snapper, first);
});

test("no bridge: every method is a no-op that never throws, even with bad arguments", () => {
  const h = make();
  const sn = h.sn;
  const cyc = {}; cyc.self = cyc;
  const bad = [undefined, null, 0, -5, NaN, "x", {}, [], cyc, () => 1, Symbol("s"), 10n];
  const names = ["registerState", "registerFrame", "registerStepper", "registerCommands", "tick", "tickKeys", "log", "event", "mark", "assert", "export"];
  for (const n of names) {
    for (const a of bad) for (const b of bad) assert.doesNotThrow(() => sn[n](a, b, a), `${n}(${String(typeof a)},${String(typeof b)})`);
  }
  for (const k of ["ready", "state", "frame", "pause", "resume", "step", "command", "commandList", "flush"]) {
    for (const a of bad) assert.doesNotThrow(() => sn.__host[k](a, a), k);
  }
  assert.equal(h.intervals.length, 0, "no timers without a bridge");
});

test("providers that throw are caught", () => {
  const h = make({ bridge: true });
  h.sn.registerState(() => { throw new Error("boom"); });
  h.sn.registerFrame(() => { throw new Error("nope"); });
  h.sn.registerStepper({ step() { throw new Error("s"); }, pause() { throw 1; }, resume() { throw 1; }, seed() { throw 1; }, keymap: ["A"] });
  h.sn.registerCommands({ bad: { label: "Bad", run() { throw new Error("cmd fail"); } } });
  assert.deepEqual(J(JSON.parse(h.sn.__host.state())), { error: "boom" });
  assert.equal(h.sn.__host.frame(), null);
  assert.doesNotThrow(() => { h.sn.__host.step(3, []); h.sn.__host.pause(); h.sn.__host.resume(); });
  assert.deepEqual(J(JSON.parse(h.sn.__host.command("bad"))), { error: "cmd fail" });
  assert.deepEqual(J(JSON.parse(h.sn.__host.command("missing"))), { error: "unknown command: missing" });
  assert.equal(h.sn.__host.ready().stepper, true);
});

test("truncation caps: long arrays, 256 KB state, cycles, bigint", () => {
  const h = make();
  const big = Array.from({ length: 1500 }, (_, i) => i);
  h.sn.registerState(() => ({ list: big, name: "x", n: 3 }));
  let st = JSON.parse(h.sn.__host.state());
  assert.equal(st.list.length, 1001);
  assert.deepEqual(J(st.list[1000]), { _truncated: 500 });
  assert.equal(st.list[999], 999);

  h.sn.registerState(() => ({ blob: "x".repeat(300 * 1024), scalar: 7, flag: true, label: "hi", nested: { a: 1 } }));
  const raw = h.sn.__host.state();
  assert.ok(raw.length < 4096, "capped output is small");
  st = JSON.parse(raw);
  assert.equal(st.error, "state exceeds 256 KB");
  assert.ok(st._truncated > 300 * 1024);
  assert.equal(st.scalar, 7); assert.equal(st.flag, true); assert.equal(st.label, "hi");
  assert.equal(st.nested, undefined);

  const cyc = { a: 1 }; cyc.me = cyc;
  h.sn.registerState(() => cyc);
  assert.match(JSON.parse(h.sn.__host.state()).error, /not serialisable/);
  h.sn.registerState(() => ({ b: 10n }));
  assert.match(JSON.parse(h.sn.__host.state()).error, /not serialisable/);
  h.sn.registerState(() => undefined);
  assert.equal(h.sn.__host.state(), "null");
});

test("data arguments get the same caps (log/event/mark)", () => {
  const h = make({ bridge: true });
  const cyc = {}; cyc.c = cyc;
  h.sn.log("warn", "w", { list: new Array(2000).fill(1) });
  h.sn.event("e", cyc);
  h.sn.mark("m", { blob: "y".repeat(300 * 1024) });
  const [lg] = h.of("log"), [ev] = h.of("event"), [mk] = h.of("mark");
  assert.equal(lg.payload.data.list.length, 1001);
  assert.match(ev.payload.data.error, /not serialisable/);
  assert.equal(mk.payload.data.error, "data exceeds 256 KB");
});

test("tick appends only on change, first tick, and reset (with -1 marker)", () => {
  const h = make({ bridge: true });
  const sn = h.sn;
  sn.tick(0, 0);
  for (let f = 1; f < 100; f++) sn.tick(f, 0);
  sn.tick(100, 5);
  for (let f = 101; f < 200; f++) sn.tick(f, 5);
  sn.tick(200, 0);
  sn.tick(3, 0);                                  // frame went backwards: reset
  sn.tick(4, 0);
  assert.equal(sn.frame(), 4);
  sn.__host.flush();
  const [t] = h.of("tape");
  assert.deepEqual(t.f, [0, 100, 200, 3, 3]);
  assert.deepEqual(t.m, [0, 5, 0, -1, 0]);
  assert.equal(t.n, 5);
  assert.equal(t.isI32, true);
});

test("tickKeys maps codes through the stepper keymap", () => {
  const h = make({ bridge: true });
  h.sn.registerStepper({ keymap: ["KeyA", "KeyD", "Space"] });
  h.sn.tickKeys(0, []);
  h.sn.tickKeys(1, ["Space", "KeyA", "Unknown"]);
  h.sn.tickKeys(2, ["Space", "KeyA"]);
  h.sn.tickKeys(3, null);
  h.sn.__host.flush();
  const [t] = h.of("tape");
  assert.deepEqual(t.f, [0, 1, 3]);
  assert.deepEqual(t.m, [0, 5, 0]);
});

test("flush batching: one sendTape per 250 ms with exactly the new entries; none when idle", () => {
  const h = make({ bridge: true });
  const sn = h.sn;
  assert.equal(h.intervals.length, 0, "timer is lazy");
  sn.tick(0, 0);
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].ms, 250);
  for (let f = 1; f < 30; f++) sn.tick(f, f % 2 ? 1 : 2);
  assert.equal(h.of("tape").length, 0, "tick never flushes");
  h.advance(250);
  let tapes = h.of("tape");
  assert.equal(tapes.length, 1);
  assert.equal(tapes[0].n, 30);                    // first tick + 29 changes
  assert.deepEqual(tapes[0].f.slice(0, 3), [0, 1, 2]);
  h.advance(250);
  assert.equal(h.of("tape").length, 1, "nothing new, no call");
  sn.tick(30, 0);
  sn.tick(31, 0);
  h.advance(250);
  tapes = h.of("tape");
  assert.equal(tapes.length, 2);
  assert.deepEqual(tapes[1].f, [30]);
  assert.deepEqual(tapes[1].m, [0]);
  assert.equal(h.intervals.length, 1, "one timer only");
});

test("ring overflow drops oldest and counts", () => {
  const h = make();                                // standalone
  for (let f = 0; f < 5000; f++) h.sn.tick(f, f & 1 ? 1 : 2);
  const ex = h.sn.export();
  assert.equal(ex.tape.length, 4096);
  assert.equal(ex.tapeDropped, 5000 - 4096);
  assert.equal(ex.tape.at(-1).f, 4999);
});

test("detached methods work (const tick = snapper.tick)", () => {
  const h = make({ bridge: true });
  const { tick, log, event, mark, assert: as, tickKeys, frame } = h.sn;
  tick(7, 3);
  tickKeys(8, []);
  log("error", "m"); event("e"); mark("n"); as(false, "z");
  assert.equal(frame(), 8);
  h.sn.__host.flush();
  assert.deepEqual(h.of("tape")[0].f, [7, 8]);
  assert.deepEqual(h.calls.filter(c => c.type !== "tape").map(c => c.type), ["log", "event", "mark", "assert"]);
  const { ready, state } = h.sn.__host;
  assert.equal(ready().sdk, true);
  assert.equal(state(), '{"unavailable":true}');
});

test("attached flips when a bridge appears after load; the timer starts then", () => {
  const h = make();
  assert.equal(h.sn.attached, false);
  h.sn.tick(0, 0);
  assert.equal(h.intervals.length, 0);
  h.attach();
  assert.equal(h.sn.attached, true);
  h.sn.tick(1, 0);                                 // unchanged mask still starts the timer
  assert.equal(h.intervals.length, 1);
  h.sn.log("info", "hello");
  assert.equal(h.of("log").length, 1);
  h.sandbox.__snapperBridge = null;
  assert.equal(h.sn.attached, false);
});

test("log/event/mark/assert payloads follow the bridge protocol (D-013)", () => {
  const h = make({ bridge: true });
  h.sn.tick(12, 0);
  h.sn.log("debug", "d", { a: 1 });
  h.sn.log("bogus", "x");
  h.sn.event("lvl", { n: 2 });
  h.sn.mark("look", { k: 1 });
  h.sn.mark("bare");
  assert.equal(h.sn.assert(true, "fine"), true);
  assert.equal(h.sn.assert(false, "bad", { v: 1 }), false);
  const sends = h.calls.filter(c => c.type !== "tape");
  assert.deepEqual(sends.map(c => c.type), ["log", "log", "event", "mark", "mark", "assert"]);
  assert.deepEqual(sends[0].payload, { frame: 12, level: "debug", msg: "d", data: { a: 1 } });
  assert.equal(sends[1].payload.level, "info");
  assert.deepEqual(sends[2].payload, { frame: 12, name: "lvl", data: { n: 2 } });
  assert.deepEqual(sends[3].payload, { frame: 12, note: "look", data: { k: 1 } });
  assert.deepEqual(sends[4].payload, { frame: 12, note: "bare" });
  assert.deepEqual(sends[5].payload, { frame: 12, msg: "bad", data: { v: 1 } });
});

test("assert: cooldown is 2 s per message", () => {
  const h = make({ bridge: true });
  h.sn.assert(false, "a");
  h.sn.assert(false, "a");
  h.sn.assert(false, "b");
  h.clock.t += 1999; h.sn.assert(false, "a");
  assert.equal(h.of("assert").length, 2);
  h.clock.t += 2; h.sn.assert(false, "a");
  assert.equal(h.of("assert").length, 3);
  assert.equal(h.sn.assert(0, "z"), 0, "returns cond as given");
});

test("standalone export(): logs, events, marks, tape", () => {
  const h = make();
  h.sn.tick(0, 1); h.sn.tick(5, 2); h.sn.tick(1, 2);
  h.sn.log("warn", "w", { a: 1 }); h.sn.event("ev", { b: 2 }); h.sn.mark("m"); h.sn.assert(false, "az");
  const ex = J(h.sn.export());
  assert.equal(ex.logs.length, 1); assert.equal(ex.logs[0].msg, "w"); assert.deepEqual(ex.logs[0].data, { a: 1 });
  assert.equal(ex.events[0].name, "ev");
  assert.deepEqual(ex.marks.map(m => m.trigger), ["api", "assert"]);
  assert.deepEqual(ex.tape, [{ f: 0, m: 1 }, { f: 5, m: 2 }, { f: 1, ev: "reload" }, { f: 1, m: 2 }]);
});

test("registrations: register messages, seed message, __host shapes", () => {
  const h = make({ bridge: true });
  const sn = h.sn;
  assert.deepEqual(J(sn.__host.ready()), { sdk: true, state: false, frame: false, stepper: false, commands: [], keymap: [], pauseParam: "", version: "1.0.0" });
  assert.equal(sn.__host.frame(), null);
  sn.registerState(() => ({ a: 1 }));
  sn.registerFrame(() => "data:image/png;base64,AAAA");
  const stepped = [];
  sn.registerStepper({ pause() { stepped.push("p"); }, resume() { stepped.push("r"); }, step(n, c) { stepped.push([n, c]); sn.tick(9, 1); }, keymap: ["KeyA", "KeyD"], seed: () => 42 });
  sn.registerCommands({ reset: { label: "Reset", run: () => ({ ok: 1 }) }, go: { label: "Go", arg: "text", run: a => "to " + a } });
  assert.equal(h.of("register").length, 4);
  assert.deepEqual(h.of("seed")[0].payload, { frame: -1, seed: 42 });
  const r = J(sn.__host.ready());
  assert.deepEqual(r, { sdk: true, state: true, frame: true, stepper: true, commands: ["reset", "go"], keymap: ["KeyA", "KeyD"], pauseParam: "paused", version: "1.0.0", seed: 42 });
  assert.equal(sn.__host.state(), '{"a":1}');
  assert.equal(sn.__host.frame(), "data:image/png;base64,AAAA");
  sn.__host.pause(); sn.__host.resume();
  assert.equal(sn.__host.step(3, ["KeyA"]), 9);
  assert.deepEqual(J(stepped), ["p", "r", [3, ["KeyA"]]]);
  assert.equal(sn.__host.command("reset"), '{"ok":1}');
  assert.equal(sn.__host.command("go", "1,2"), '"to 1,2"');
  assert.deepEqual(J(sn.__host.commandList()), [{ id: "reset", label: "Reset", arg: null }, { id: "go", label: "Go", arg: "text" }]);
  // canvas-like frame provider
  sn.registerFrame(() => ({ toDataURL: t => "data:" + t }));
  assert.equal(sn.__host.frame(), "data:image/png");
  sn.registerState(() => { throw new Error("x"); });
  assert.equal(typeof sn.__host.state(), "string");
  sn.registerStepper({ keymap: ["Q"], pauseParam: "stop" });
  assert.equal(sn.__host.ready().pauseParam, "stop");
});

test("tick does not allocate at steady state (1e6 ticks, unchanged mask)", () => {
  const h = make({ bridge: true });
  const tick = h.sn.tick;
  tick(0, 5);
  // Run the tick loop inside the context too, so nothing but tick's own work is measured.
  const run = vm.runInContext("(function (tick, f, n) { for (var i = 0; i < n; i++) tick(f++, 5); })", h.ctx);
  run(tick, 1, 200000);                               // warm up the JIT
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  run(tick, 200001, 1e6);
  const grew = process.memoryUsage().heapUsed - before;
  // 1e6 boxed doubles or arrays would cost >= 8-16 MB; a quiet loop stays well under 1 MB.
  assert.ok(grew < 1024 * 1024, `heap grew ${grew} bytes over 1e6 ticks`);
  assert.equal(h.sn.frame(), 1200000);
  h.sn.__host.flush();
  assert.equal(h.of("tape")[0].n, 1, "only the first tick was appended");
});
