// page.js (the page-side code shared by the Electron preload and the attach injection) and its attach transport
// (packages/host/main/attach-inject.mjs), run in a node:vm sandbox with a fake DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { embedPage, embeddedPage } from "../../scripts/make-preload.mjs";
import { buildAttachScript, pageMessageExpression, parseBindingPayload, ATTACH_BINDING } from "../../packages/host/main/attach-inject.mjs";

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PAGE = read("../../packages/host/preload/page.js");
const PRELOAD = read("../../packages/host/preload/preload.cjs");

test("preload.cjs embeds page.js verbatim between the marker lines (run node scripts/make-preload.mjs when this fails)", () => {
  const embedded = embeddedPage(PRELOAD);
  assert.ok(embedded !== null, "markers present");
  assert.equal(embedded, PAGE.replace(/\n*$/, "\n"), "the embedded copy differs from packages/host/preload/page.js");
  assert.equal(embedPage(PRELOAD, PAGE), PRELOAD, "regenerating changes nothing");
  assert.match(PRELOAD, /\nsnapperPage\(OPTS, T\);\n$/);
});

test("page.js is ONE plain function: no module syntax, no require, no electron", () => {
  const code = PAGE.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  assert.match(code, /^function snapperPage\(OPTS, T\) \{/m);
  assert.equal((code.match(/^function /gm) || []).length, 1, "only one top-level function");
  assert.doesNotMatch(code, /\brequire\s*\(/);
  assert.doesNotMatch(code, /^\s*(import|export)\b/m);
  assert.doesNotMatch(code, /ipcRenderer|contextBridge/);
  new vm.Script(PAGE);                                    // parses as a classic script
});

test("attach transport: pure helpers (expression, binding payloads)", () => {
  assert.equal(ATTACH_BINDING, "__snapperHostBinding");
  assert.equal(pageMessageExpression("toast", { text: 'a"b', ms: 5 }), 'globalThis.__snapperPage&&globalThis.__snapperPage.msg("toast",{"text":"a\\"b","ms":5})');
  assert.equal(pageMessageExpression("dispose"), 'globalThis.__snapperPage&&globalThis.__snapperPage.msg("dispose",null)');
  assert.deepEqual(parseBindingPayload(JSON.stringify(["p", "hello", { url: "u" }])), { type: "p", kind: "hello", data: { url: "u" } });
  const tape = parseBindingPayload(JSON.stringify(["tape", [0, 5, 9], [0, 3, 1], 2]));
  assert.equal(tape.type, "tape");
  assert.deepEqual(Array.from(tape.frames), [0, 5]);
  assert.deepEqual(Array.from(tape.masks), [0, 3]);
  assert.equal(tape.count, 2);
  assert.ok(tape.frames instanceof Int32Array);
  for (const bad of ["", "nope", "{}", "[]", '["x"]', '["p"]', '["tape",1,2]']) assert.equal(parseBindingPayload(bad), null, bad);
});

/** Run the attach script in a vm sandbox. Returns handles to drive it. */
function boot(opts = {}, { top = true } = {}) {
  const payloads = [];
  const listeners = {};
  const removed = [];
  const cleared = [];
  const raf = [];
  const timers = [];
  let now = 0, cancelled = 0;
  const sandbox = {
    __snapperHostBinding: s => payloads.push(JSON.parse(s)),
    document: { readyState: "complete", addEventListener() {}, removeEventListener() {}, documentElement: null, visibilityState: "visible", activeElement: null },
    navigator: { getGamepads: () => [] },
    performance: { now: () => now },
    requestAnimationFrame: f => { raf.push(f); return raf.length; },
    cancelAnimationFrame: () => { cancelled++; },
    setInterval: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearInterval: h => cleared.push(h),
    setTimeout: () => 0, clearTimeout() {},
    innerWidth: 100, innerHeight: 100, location: { href: "http://x/game" }, getComputedStyle: () => ({ display: "none" }),
    Float64Array, Int32Array, Math, JSON, Array, Set, Map, Promise, Object, Number, String, console,
  };
  sandbox.window = sandbox;
  sandbox.top = top ? sandbox : {};
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = (t, f, o) => { (listeners[t] ||= []).push(f); };
  sandbox.removeEventListener = (t, f) => { removed.push(t); const a = listeners[t]; if (a) a.splice(a.indexOf(f), 1); };
  vm.createContext(sandbox);
  const script = buildAttachScript({ expectedMs: 16.667, fpsDropMs: 250, fpsDropRun: 10, padMark: [8, 9], padMarkHoldMs: 400, attach: true, inPageHotkeys: true, ...opts });
  const run = () => vm.runInContext(script, sandbox);
  run();
  const kinds = k => payloads.filter(p => p[0] === "p" && p[1] === k).map(p => p[2]);
  const key = (type, code, extra = {}) => {
    const ev = { type, code, key: code, repeat: false, ctrlKey: false, altKey: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, stopPropagation() {}, ...extra };
    for (const f of [...(listeners[type] || [])]) f(ev);
    return ev;
  };
  return { sandbox, payloads, listeners, removed, cleared, raf, timers, kinds, key, run, script,
    msg: (kind, data) => sandbox.__snapperPage && sandbox.__snapperPage.msg(kind, data),
    flushWall() { now += 1; timers.find(t => t.ms === 250).f(); },
    frame(ts) { now = ts; raf.shift()(ts); },
    cancelled: () => cancelled };
}

test("attach script: hello over the binding, a non-enumerable bridge for the SDK, once per document, top frame only", () => {
  const h = boot();
  assert.deepEqual(h.payloads[0], ["p", "hello", { url: "http://x/game" }]);
  const d = Object.getOwnPropertyDescriptor(h.sandbox, "__snapperBridge");
  assert.equal(d.enumerable, false);
  assert.equal(typeof d.value.send, "function");
  assert.equal(Object.getOwnPropertyDescriptor(h.sandbox, "__snapperPage").enumerable, false);
  const n = h.payloads.length;
  h.run();                                                // the guard: a second run in the same document does nothing
  assert.equal(h.payloads.length, n);
  const sub = boot({}, { top: false });
  assert.equal(sub.payloads.length, 0, "a subframe does not run it");
  assert.equal(sub.sandbox.__snapperBridge, undefined);
});

test("attach script: bridge messages and tape flushes become binding payloads (D-013 types only)", () => {
  const h = boot();
  const api = h.sandbox.__snapperBridge;
  api.send("log", { frame: 1, level: "warn", msg: "x" });
  api.send("bogus", {});
  api.send("register");
  assert.deepEqual(h.kinds("sdk"), [{ type: "log", payload: { frame: 1, level: "warn", msg: "x" } }, { type: "register", payload: {} }]);
  api.sendTape(Int32Array.from([0, 5, 0]), Int32Array.from([0, 3, 0]), 2);
  const tape = h.payloads.find(p => p[0] === "tape");
  assert.deepEqual(tape, ["tape", [0, 5], [0, 3], 2]);
  const back = parseBindingPayload(JSON.stringify(tape));
  assert.deepEqual(Array.from(back.frames), [0, 5]);
});

test("attach script: host messages arrive through __snapperPage.msg (ask replies, status, arm)", async () => {
  const h = boot();
  h.msg("ask", { id: 7, what: "pads" });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(h.kinds("reply"), [{ id: 7, out: [] }]);
  h.msg("ask", { id: 8, what: "snap", windowMs: 10000 });
  await new Promise(r => setImmediate(r));
  const snap = h.kinds("reply").find(r => r.id === 8);
  assert.ok(snap && Array.isArray(snap.out.intervals) && typeof snap.out.now === "number");
  h.msg("ask", { id: 9, what: "hide" });                  // no overlay built in this fake DOM: answers at once
  await new Promise(r => setImmediate(r));
  assert.deepEqual(h.kinds("reply").find(r => r.id === 9), { id: 9, out: true });
  h.msg("status", { frame: 3 });
  h.msg("arm", true);
  h.msg("nonsense", 1);                                   // unknown kinds are ignored, nothing throws
});

test("attach script: pacing drops and the wall flush work over the binding", () => {
  const h = boot();
  let t = 0;
  for (let i = 0; i < 10; i++) { t += 16.7; h.frame(t); }
  h.msg("arm", true);
  for (let i = 0; i < 5; i++) { t += 300; h.frame(t); }
  assert.equal(h.kinds("fps").length, 0, "armed 2 s after ready");
  for (let i = 0; i < 200; i++) { t += 16.7; h.frame(t); }
  t += 300; h.frame(t);
  assert.equal(h.kinds("fps").length, 1);
  h.key("keydown", "KeyD"); h.key("keyup", "KeyD");
  h.flushWall();
  const wall = h.kinds("wall")[0];
  assert.deepEqual(wall.ev.map(e => [e.k, e.d]), [["KeyD", 1], ["KeyD", 0]]);
});

test("attach script: hotkeys are the page's own keydown events; the game never sees them and the tape does not record them", () => {
  const h = boot({ hotkeys: { mark: "F8", overlay: "F9", pause: "F10", step: "F7", fullscreen: "F11", save: "F6" } });
  const down = h.key("keydown", "F8");
  assert.equal(down.stopped, true);
  assert.equal(down.prevented, true);
  assert.deepEqual(h.kinds("hotkey"), [{ name: "mark" }]);
  const rep = h.key("keydown", "F8", { repeat: true });
  assert.equal(rep.stopped, true);
  assert.equal(h.kinds("hotkey").length, 1, "auto-repeat does not fire again");
  const up = h.key("keyup", "F8");
  assert.equal(up.stopped, true, "the keyup is taken too");
  for (const [code, name] of [["F9", "overlay"], ["F10", "pause"], ["F7", "step"], ["F6", "save"]]) {
    h.key("keydown", code); h.key("keyup", code);
    assert.equal(h.kinds("hotkey").at(-1).name, name);
  }
  // F11 (fullscreen), F12, F5 are the browser's: recorded like any key, never taken
  const f11 = h.key("keydown", "F11");
  assert.equal(f11.stopped, false);
  h.key("keyup", "F11");
  // Ctrl+F8 is not the hotkey
  const ctrl = h.key("keydown", "F8", { ctrlKey: true });
  assert.equal(ctrl.stopped, false);
  h.key("keyup", "F8");
  const n = h.kinds("hotkey").length;
  h.key("keydown", "KeyD"); h.key("keyup", "KeyD");
  assert.equal(h.kinds("hotkey").length, n);
  h.flushWall();
  const keys = h.kinds("wall")[0].ev.map(e => `${e.k}:${e.d}`);
  assert.deepEqual(keys, ["F11:1", "F11:0", "F8:1", "F8:0", "KeyD:1", "KeyD:0"]);
});

test("attach script: custom hotkeys follow the config, and hotkeys are not special when inPageHotkeys is off", () => {
  const h = boot({ hotkeys: { mark: "KeyM" } });
  h.key("keydown", "KeyM");
  assert.deepEqual(h.kinds("hotkey"), [{ name: "mark" }]);
  const plain = boot({ inPageHotkeys: false });
  const ev = plain.key("keydown", "F8");
  assert.equal(ev.stopped, false);
  assert.equal(plain.kinds("hotkey").length, 0);
});

test("attach script: dispose removes listeners, timers and the rAF loop, and silences the bridge", () => {
  const h = boot();
  const before = h.payloads.length;
  assert.ok(h.listeners.keydown.length > 0);
  h.msg("dispose");
  for (const t of ["keydown", "keyup", "keypress", "blur", "gamepadconnected", "gamepaddisconnected"]) assert.ok(h.removed.includes(t), `removed ${t}`);
  assert.ok(h.cleared.length >= 2, "flush + overlay timers cleared");
  assert.equal(h.cancelled(), 1);
  assert.equal(h.sandbox.__snapperPage, undefined, "the host handle is gone");
  h.frame(10);                                            // the pending rAF callback runs once more and does not re-arm
  assert.equal(h.raf.length, 0);
  h.sandbox.__snapperBridge.send("log", { msg: "after" });
  h.sandbox.__snapperBridge.sendTape(Int32Array.from([1]), Int32Array.from([1]), 1);
  assert.equal(h.payloads.length, before, "nothing is sent after dispose");
  h.msg("toast", "x");                                    // msg after dispose: the handle is deleted from the sandbox, nothing to call
  // a later injection (re-attach) starts fresh
  h.run();
  assert.ok(h.payloads.length > before, "re-injection says hello again");
});

test("page.js: the preload transport shape still holds (T.send / sendTape / listen / exposeBridge are all it needs)", () => {
  const calls = [];
  const T = { send: (k, d) => calls.push(["send", k]), sendTape: () => calls.push(["tape"]), listen: () => calls.push(["listen"]), exposeBridge: () => calls.push(["bridge"]) };
  const sandbox = {
    document: { readyState: "complete", addEventListener() {}, documentElement: null, visibilityState: "visible" },
    window: { addEventListener() {} }, navigator: { getGamepads: () => [] }, performance: { now: () => 0 },
    requestAnimationFrame: () => 1, setInterval: () => 1, setTimeout: () => 0, clearTimeout() {},
    location: { href: "http://x/" }, innerWidth: 1, innerHeight: 1, getComputedStyle: () => ({ display: "none" }),
    Float64Array, Int32Array, Math, JSON, Array, Set, Map, Promise, Object, Number, String, console, T,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PAGE + "\nsnapperPage({}, T);", sandbox);
  assert.deepEqual(calls.map(c => c[0]).sort(), ["bridge", "listen", "send"]);
  assert.deepEqual(calls.find(c => c[0] === "send"), ["send", "hello"]);
});
