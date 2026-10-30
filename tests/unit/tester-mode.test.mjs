// Tester mode (v1.4, BRIEF-v1.4 §3.2): the pure host parts (tester.json, the outbox name, the hint and line texts) and the
// page side (the one-time name prompt, the "What happened?" note box, the chip hint), run in a node:vm sandbox with a
// small fake DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanTesterName, readTesterFile, writeTesterFile, outboxName, keyLabel, testerHint, testerNameTitle, sendLine, TESTER_NOTE_TITLE,
} from "../../packages/host/main/helpers.mjs";

const PAGE = readFileSync(fileURLToPath(new URL("../../packages/host/preload/page.js", import.meta.url)), "utf8");

// ---------------------------------------------------------------------------------------------------------------- host side
test("tester.json: write, read, validation", () => {
  const kit = mkdtempSync(join(tmpdir(), "snapper-tester-"));
  try {
    assert.equal(readTesterFile(kit), null, "missing file: ask");
    const doc = writeTesterFile(kit, "  Ann\tLee \n", "2026-10-21T10:00:00.000Z");
    assert.deepEqual(doc, { name: "Ann Lee", at: "2026-10-21T10:00:00.000Z" });
    assert.deepEqual(JSON.parse(readFileSync(join(kit, "tester.json"), "utf8")), { name: "Ann Lee", at: "2026-10-21T10:00:00.000Z" });
    assert.deepEqual(readTesterFile(kit), { name: "Ann Lee", at: "2026-10-21T10:00:00.000Z" });
    const keep = readFileSync(join(kit, "tester.json"), "utf8");
    assert.equal(writeTesterFile(kit, ""), null);
    assert.equal(writeTesterFile(kit, "   "), null);
    assert.equal(writeTesterFile(kit, "Anonymous"), null, "anonymous is never written");
    assert.equal(readFileSync(join(kit, "tester.json"), "utf8"), keep, "a refused name leaves the file alone");
    for (const bad of ["not json", "{}", '{"name":""}', '{"name":5}', '{"name":"  "}', "[]", "null"]) {
      writeFileSync(join(kit, "tester.json"), bad);
      assert.equal(readTesterFile(kit), null, bad);
    }
    writeFileSync(join(kit, "tester.json"), JSON.stringify({ name: "Bo" }));
    assert.deepEqual(readTesterFile(kit), { name: "Bo", at: null });
  } finally { rmSync(kit, { recursive: true, force: true }); }
  assert.equal(existsSync(kit), false);
});

test("cleanTesterName: control characters out, whitespace collapsed, 60 characters at most", () => {
  assert.equal(cleanTesterName("a\u0000b\u001fc"), "a b c");
  assert.equal(cleanTesterName("  x   y  "), "x y");
  assert.equal(cleanTesterName(undefined), "");
  assert.equal(cleanTesterName("é".repeat(80)).length, 60);
});

test("outbox name, key label, hint and line texts", () => {
  assert.equal(outboxName("demo", "2026-10-21T10-00-00"), "demo-2026-10-21T10-00-00.zip");
  assert.equal(outboxName("my game", "2026-10-21T10-00-00-2"), "my-game-2026-10-21T10-00-00-2.zip");
  assert.equal(outboxName("a/b", "x:y"), "a-b-x-y.zip");
  assert.equal(keyLabel("F8"), "F8");
  assert.equal(keyLabel("KeyM"), "M");
  assert.equal(keyLabel("Digit5"), "5");
  assert.equal(testerHint("F8"), "F8 marks a moment");
  assert.equal(testerHint("KeyM"), "M marks a moment");
  assert.equal(TESTER_NOTE_TITLE, "What happened?");
  assert.equal(testerNameTitle("Maxim"), "Your name (sent with your sessions to Maxim)");
  assert.equal(testerNameTitle(""), "Your name (sent with your sessions to the developer)");
  assert.equal(sendLine("Maxim", "outbox/demo-2026.zip"), "Send this file to Maxim: outbox\\demo-2026.zip");
  assert.equal(sendLine(undefined, "outbox\\a.zip"), "Send this file to the developer: outbox\\a.zip");
});

// ---------------------------------------------------------------------------------------------------------------- page side
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.className = ""; this.value = ""; this._text = ""; this.isConnected = false; this.classList = { add() {}, remove() {}, contains: () => false }; }
  set innerHTML(v) { this.children = []; this._text = ""; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(c) { this.children.push(c); c.isConnected = true; return c; }
  setAttribute() {}
  addEventListener() {}
  attachShadow() { this.shadow = new El("shadow"); return this.shadow; }
  remove() { this.isConnected = false; }
  focus() {}
  blur() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

function boot(opts = {}) {
  const sent = [];
  const listeners = {};
  const timers = [];
  let hostFn = null, now = 1000;
  const doc = {
    readyState: "complete", visibilityState: "visible", activeElement: null, documentElement: new El("html"),
    createElement: tag => new El(tag), createTextNode: data => ({ isText: true, data }),
    addEventListener() {},
  };
  const T = {
    send: (kind, data) => sent.push({ kind, data }), sendTape() {}, listen: fn => { hostFn = fn; }, exposeBridge() {},
  };
  const sandbox = {
    document: doc, navigator: { getGamepads: () => [] }, performance: { now: () => now },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setInterval: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearInterval() {},
    setTimeout: () => 0, clearTimeout() {}, innerWidth: 800, innerHeight: 600, location: { href: "http://x/game" },
    getComputedStyle: () => ({ display: "block" }),
    Float64Array, Int32Array, Math, JSON, Array, Set, Map, Promise, Object, Number, String, console, T, OPTS: opts,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = (t, f) => { (listeners[t] ||= []).push(f); };
  sandbox.removeEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(PAGE + "\nsnapperPage(OPTS, T);", sandbox);
  const key = (type, code, extra = {}) => {
    const ev = { type, code, key: code, repeat: false, stopped: false, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, stopPropagation() {}, ...extra };
    for (const f of [...(listeners[type] || [])]) f(ev);
    return ev;
  };
  const wrap = () => doc.documentElement.children[0].shadow.children[1];
  const els = () => {
    const w = wrap();
    const [chip, err, toast, note] = w.children;
    return { chip, err, toast, note, label: note.children[0], input: note.children[1] };
  };
  return {
    sent, key, els, doc,
    kinds: k => JSON.parse(JSON.stringify(sent.filter(s => s.kind === k).map(s => s.data))),
    msg: async (kind, data) => { await hostFn(kind, data); },
    setNow: v => { now = v; },
    tick: () => { for (const t of timers.filter(t => t.ms === 250)) t.f(); },
    flushWall() { for (const t of timers.filter(t => t.ms === 250)) t.f(); },
  };
}

test("page: the name prompt is an input like the note box; its keys never reach the game", async () => {
  const h = boot({});
  await h.msg("name", { title: "Your name (sent with your sessions to Maxim)" });
  const { note, label, input } = h.els();
  assert.equal(note.style.display, "block");
  assert.equal(label.textContent, "Your name (sent with your sessions to Maxim)");
  assert.match(input.placeholder, /Enter saves, Esc skips/);
  for (const c of ["KeyA", "KeyN", "KeyN"]) {
    const d = h.key("keydown", c), u = h.key("keyup", c);
    assert.equal(d.stopped, true, `${c} keydown is swallowed`);
    assert.equal(u.stopped, true, `${c} keyup is swallowed`);
  }
  assert.equal(h.key("keypress", "KeyA").stopped, true);
  h.flushWall();
  assert.equal(h.kinds("wall").length, 0, "nothing typed in the box is recorded as game input");
  input.value = "Ann";
  const enter = h.key("keydown", "Enter", { key: "Enter" });
  assert.equal(enter.prevented, true);
  assert.deepEqual(h.kinds("tester-name"), [{ text: "Ann" }]);
  assert.equal(note.style.display, "none");
  h.key("keyup", "Enter", { key: "Enter" });
  h.key("keydown", "KeyD"); h.key("keyup", "KeyD");
  h.flushWall();
  assert.deepEqual(h.kinds("wall")[0].ev.map(e => `${e.k}:${e.d}`), ["KeyD:1", "KeyD:0"], "after the prompt the game gets keys again");
  assert.equal(h.kinds("note").length, 0, "a name is not sent as a note");
});

test("page: Esc skips the name prompt (an empty tester-name, the host asks again next run); empty Enter is a skip too", async () => {
  const h = boot({});
  await h.msg("name", { title: "T" });
  const esc = h.key("keydown", "Escape", { key: "Escape" });
  assert.equal(esc.stopped, true);
  assert.deepEqual(h.kinds("tester-name"), [{ text: "" }]);
  assert.equal(h.els().note.style.display, "none");
  await h.msg("name", { title: "T" });
  h.key("keydown", "Enter", { key: "Enter" });
  assert.deepEqual(h.kinds("tester-name"), [{ text: "" }, { text: "" }]);
});

test("page: a mark's note box in tester mode is titled exactly \"What happened?\"; the normal box keeps its suffix", async () => {
  const h = boot({});
  await h.msg("note", { id: "0001", text: "What happened?", plain: true });
  const e = h.els();
  assert.equal(e.label.textContent, "What happened?");
  assert.equal(e.note.style.display, "block");
  e.input.value = "the jump feels floaty";
  h.key("keydown", "Enter", { key: "Enter" });
  assert.deepEqual(h.kinds("note"), [{ id: "0001", text: "the jump feels floaty" }]);
  await h.msg("note", { id: "0002", text: "Mark 0002 saved" });
  assert.equal(h.els().label.textContent, "Mark 0002 saved · type a note (Enter saves, Esc skips)");
});

test("page: a mark during the name prompt keeps what was typed as the name and opens the note box", async () => {
  const h = boot({});
  await h.msg("name", { title: "T" });
  h.els().input.value = "Bo";
  await h.msg("note", { id: "0001", text: "What happened?", plain: true });
  assert.deepEqual(h.kinds("tester-name"), [{ text: "Bo" }]);
  assert.equal(h.els().label.textContent, "What happened?");
});

test("page: the chip shows the hint, then the normal chip", async () => {
  const h = boot({});
  await h.msg("hint", { text: "F8 marks a moment", ms: 10000 });
  assert.equal(h.els().chip.textContent, "F8 marks a moment");
  h.setNow(1000 + 9000); h.tick();
  assert.equal(h.els().chip.textContent, "F8 marks a moment", "still within the 10 s");
  h.setNow(1000 + 10500); h.tick();
  const chip = h.els().chip;
  assert.equal(chip.textContent, "");
  assert.ok(chip.children.some(c => c.isText && /REC/.test(c.data)), "the normal REC chip is back");
});

test("page: in a bare session there is no chip (the host shows the hint as a toast instead)", async () => {
  const h = boot({ bare: true });
  await h.msg("hint", { text: "F8 marks a moment", ms: 10000 });                 // nothing to show it on: must not throw
  await h.msg("toast", { text: "F8 marks a moment", ms: 9000 });
  const w = h.doc.documentElement.children[0].shadow.children[1];
  assert.equal(w.children[0].className, "err", "no chip element in bare mode");
  assert.equal(w.children[1].textContent, "F8 marks a moment");
  assert.equal(w.children[1].style.display, "block");
});
