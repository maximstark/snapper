// v1.3 launcher model: capture settings, URL target, Copy for Claude text, mark labels, new command lines.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normHotkey, normInt, checkUrl, fieldsProblem, pruneCapture, resetCapture, captureFlags, markLabel, copyForClaudeText,
  commandLine, mergeSettings, rememberRoot, fieldsFor,
} from "../../packages/host/launcher/settings.mjs";
import { buildOptions } from "../../packages/host/main/cli-play.mjs";

const EFF = { hotkey: "F8", padHoldMs: 400, ringSeconds: 5, bare: false };

test("normHotkey: KeyboardEvent.code, typed leniently", () => {
  for (const [typed, code] of [["F8", "F8"], ["f9", "F9"], ["F24", "F24"], ["a", "KeyA"], ["KeyZ", "KeyZ"], ["keyq", "KeyQ"], ["1", "Digit1"],
    ["digit7", "Digit7"], ["Numpad3", "Numpad3"], ["space", "Space"], ["arrowup", "ArrowUp"], [" F10 ", "F10"]]) assert.equal(normHotkey(typed), code, typed);
  for (const bad of ["", "F0", "F25", "F100", "Ctrl+F8", "mark=F8", "KeyAB", "12", "Enter,", "😀"]) assert.equal(normHotkey(bad), null, bad);
});

test("normInt: whole numbers in range only", () => {
  assert.equal(normInt("400", [100, 5000]), 400);
  assert.equal(normInt(400, [100, 5000]), 400);
  for (const bad of ["", "  ", null, undefined, "4.5", "-1", "99", "5001", "abc", "1e3", NaN]) assert.equal(normInt(bad, [100, 5000]), null, String(bad));
});

test("checkUrl: empty, http, https; nothing else", () => {
  assert.deepEqual(checkUrl(""), { url: "" });
  assert.deepEqual(checkUrl(undefined), { url: "" });
  assert.deepEqual(checkUrl("  http://127.0.0.1:8771/index.html "), { url: "http://127.0.0.1:8771/index.html" });
  assert.deepEqual(checkUrl("https://example.com/play?x=1#a"), { url: "https://example.com/play?x=1#a" });
  for (const bad of ["file:///C:/g/index.html", "ftp://x/y", "javascript:alert(1)", "localhost:8080", "not a url", "http://", "127.0.0.1:8771", "http://a b/"]) {
    assert.ok(checkUrl(bad).error, bad);
  }
});

test("fieldsProblem: the first problem, or null", () => {
  assert.equal(fieldsProblem({}), null);
  assert.equal(fieldsProblem({ url: "", hotkey: "", padHoldMs: "", ringSeconds: "" }), null);
  assert.equal(fieldsProblem({ url: "http://x/", hotkey: "f4", padHoldMs: "600", ringSeconds: "3" }), null);
  assert.match(fieldsProblem({ url: "ftp://x" }), /http/);
  assert.match(fieldsProblem({ hotkey: "Ctrl+Q" }), /key code/);
  assert.match(fieldsProblem({ padHoldMs: "5" }), /pad hold/);
  assert.match(fieldsProblem({ ringSeconds: "0" }), /ring/);
  assert.match(fieldsProblem({ ringSeconds: "31" }), /ring/);
  assert.match(fieldsProblem({ hotkey: "f9" }), /already Snapper.s overlay key/);
  assert.match(fieldsProblem({ hotkey: "F6" }), /save-state/);
  assert.equal(fieldsProblem({ hotkey: "F8" }), null);
});

test("merge of bad values: dropped to defaults, valid ones normalised", () => {
  const s = mergeSettings({ perRoot: {
    "C:/a": { url: "ftp://x", hotkey: "Ctrl+F8", padHoldMs: "abc", ringSeconds: 99, bare: "yes" },
    "C:/b": { url: "http://127.0.0.1:8771/", hotkey: "f9", padHoldMs: 600, ringSeconds: "3", bare: true },
  } });
  assert.deepEqual(fieldsFor(s, "C:/a"), { preset: "1080p", fullscreen: false, query: "", url: "", hotkey: "", padHoldMs: null, ringSeconds: null, bare: false });
  assert.deepEqual(fieldsFor(s, "C:/b"), { preset: "1080p", fullscreen: false, query: "", url: "http://127.0.0.1:8771/", hotkey: "F9", padHoldMs: 600, ringSeconds: 3, bare: true });
});

test("capture settings are per root and survive JSON", () => {
  let s = rememberRoot(undefined, "C:/g/one", { url: "http://127.0.0.1:8771/index.html", hotkey: "F9", ringSeconds: 3, bare: true });
  s = rememberRoot(s, "C:/g/two", { padHoldMs: 700 });
  assert.equal(fieldsFor(s, "c:/g/one/").hotkey, "F9");
  assert.equal(fieldsFor(s, "C:/g/one").bare, true);
  assert.equal(fieldsFor(s, "C:/g/two").hotkey, "");
  assert.equal(fieldsFor(s, "C:/g/two").padHoldMs, 700);
  assert.equal(fieldsFor(s, "C:/g/two").bare, false);
  assert.deepEqual(mergeSettings(JSON.parse(JSON.stringify(s))), s);
  // updating one field keeps the others
  s = rememberRoot(s, "C:/g/one", { preset: "deck" });
  assert.equal(fieldsFor(s, "C:/g/one").hotkey, "F9");
  assert.equal(fieldsFor(s, "C:/g/one").preset, "deck");
});

test("pruneCapture: only overrides are kept", () => {
  assert.deepEqual(pruneCapture({ hotkey: "F8", padHoldMs: "400", ringSeconds: "5", bare: false }, EFF),
    { preset: "1080p", fullscreen: false, query: "", url: "", hotkey: "", padHoldMs: null, ringSeconds: null, bare: false });
  const p = pruneCapture({ hotkey: "f9", padHoldMs: "600", ringSeconds: "3", bare: true }, EFF);
  assert.deepEqual([p.hotkey, p.padHoldMs, p.ringSeconds, p.bare], ["F9", 600, 3, true]);
  // the game's own config says bare: a checked box stores nothing
  assert.equal(pruneCapture({ bare: true }, { ...EFF, bare: true }).bare, false);
});

test("resetCapture clears this root's overrides, keeps the rest", () => {
  const r = resetCapture({ preset: "deck", fullscreen: true, query: "?a=1", url: "http://x/", hotkey: "F9", padHoldMs: 600, ringSeconds: 3, bare: true });
  assert.deepEqual(r, { preset: "deck", fullscreen: true, query: "?a=1", url: "http://x/", hotkey: "", padHoldMs: null, ringSeconds: null, bare: false });
  const s = rememberRoot(rememberRoot(undefined, "C:/g", { hotkey: "F9", bare: true }), "C:/g", resetCapture(fieldsFor(rememberRoot(undefined, "C:/g", { hotkey: "F9", bare: true }), "C:/g")));
  assert.equal(fieldsFor(s, "C:/g").hotkey, "");
  assert.equal(fieldsFor(s, "C:/g").bare, false);
});

test("captureFlags: a flag only where the value differs from the game's own", () => {
  assert.deepEqual(captureFlags({}, EFF), {});
  assert.deepEqual(captureFlags({ hotkey: "F8", padHoldMs: 400, ringSeconds: 5 }, EFF), {});
  assert.deepEqual(captureFlags({ hotkey: "F9" }, EFF), { hotkeys: "mark=F9" });
  assert.deepEqual(captureFlags({ hotkey: "F9", padHoldMs: 600, ringSeconds: 3, bare: true }, EFF), { hotkeys: "mark=F9", padMarkHoldMs: 600, ringSeconds: 3, bare: true });
  // a game config that already says F9 / ring 3: the same values pass no flag, others do
  const own = { hotkey: "F9", padHoldMs: 400, ringSeconds: 3, bare: false };
  assert.deepEqual(captureFlags({ hotkey: "F9", ringSeconds: 3, padHoldMs: 500 }, own), { padMarkHoldMs: 500 });
  // bare has no off flag: the game's own bare:true is never overridden
  assert.deepEqual(captureFlags({ bare: true }, { ...EFF, bare: true }), {});
  // invalid values never become flags
  assert.deepEqual(captureFlags({ hotkey: "Ctrl+Q", padHoldMs: "x", ringSeconds: 999 }, EFF), {});
});

test("captureFlags feed buildOptions: the host sees the config", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapper-launcher-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  const flags = captureFlags({ hotkey: "f9", padHoldMs: "600", ringSeconds: 3, bare: true }, EFF);
  const o = buildOptions({ positional: [dir], flags });
  assert.equal(o.config.hotkeys.mark, "F9");
  assert.equal(o.config.hotkeys.pause, "F10");             // the other hotkeys keep their defaults
  assert.equal(o.config.padMarkHoldMs, 600);
  assert.equal(o.config.ringSeconds, 3);
  assert.equal(o.config.bare, true);
  // the URL target
  const u = buildOptions({ positional: ["http://127.0.0.1:8771/index.html"], flags: { gameRoot: dir, ...flags } });
  assert.deepEqual(u.target, { kind: "url", value: "http://127.0.0.1:8771/index.html" });
  assert.equal(u.config.hotkeys.mark, "F9");
  mkdirSync(join(dir, "x"));
});

test("markLabel: id, time, trigger, note (clipped to 60)", () => {
  assert.equal(markLabel({ id: "0003", t: 62300, trigger: "hotkey", note: "jumped through the floor" }), '0003 · 1:02.3 · hotkey · "jumped through the floor"');
  assert.equal(markLabel({ id: "0001", t: 800, trigger: "pad" }), "0001 · 0:00.8 · pad");
  assert.equal(markLabel({ id: "0002", t: 5000, trigger: "error", note: null, summary: "TypeError: x is undefined" }), "0002 · 0:05.0 · error · TypeError: x is undefined");
  const long = "x".repeat(100);
  const l = markLabel({ id: "0004", t: 1000, trigger: "hotkey", note: long });
  assert.equal(l, `0004 · 0:01.0 · hotkey · "${"x".repeat(59)}…"`);
  assert.equal(markLabel({ id: "0005", t: 1000, trigger: "hotkey", note: "two\nlines  here" }), '0005 · 0:01.0 · hotkey · "two lines here"');
});

test("copyForClaudeText: Windows separators, with and without a mark", () => {
  assert.equal(copyForClaudeText("C:/Coding/Snapper/sessions/x/2026-10-21T10-00-00"),
    'Read "C:\\Coding\\Snapper\\sessions\\x\\2026-10-21T10-00-00\\SESSION.md" and triage it with the snapper skill.');
  assert.equal(copyForClaudeText("C:\\g\\.snapper\\sessions\\g\\s1\\", "0003"),
    'Read "C:\\g\\.snapper\\sessions\\g\\s1\\SESSION.md" and triage mark 0003 with the snapper skill.');
  assert.throws(() => copyForClaudeText("", ""), /session/);
  assert.throws(() => copyForClaudeText("C:/s", "../x"), /mark id/);
});

test("commandLine: URL target, capture flags, skill install, check", () => {
  const flags = { hotkeys: "mark=F9", padMarkHoldMs: 600, ringSeconds: 3, bare: true };
  assert.equal(commandLine("play", { root: "C:\\g\\demo", url: "http://127.0.0.1:8771/index.html", preset: "deck" }),
    'snapper play "http://127.0.0.1:8771/index.html" --game-root "C:/g/demo" --preset deck');
  assert.equal(commandLine("play", { root: "C:/g", preset: "1080p", flags, out: "C:/o" }),
    'snapper play "C:/g" --preset 1080p --hotkeys mark=F9 --padMarkHoldMs 600 --ringSeconds 3 --bare --out "C:/o"');
  assert.equal(commandLine("play", { root: "C:/g", preset: "1080p", flags: {} }), 'snapper play "C:/g" --preset 1080p');
  assert.equal(commandLine("resume", { root: "C:/g", url: "http://ignored/", session: "C:/s", at: "exit", flags: { bare: true } }),
    'snapper play "C:/g" --resume "C:/s" --at exit --bare');
  assert.equal(commandLine("skill", { root: "C:\\g" }), 'snapper skill install "C:/g"');
  assert.equal(commandLine("check", { root: "C:/g", sessions: 3 }), 'snapper check "C:/g" --sessions 3');
  assert.equal(commandLine("check", { root: "C:/g", sessions: 3, out: "C:/o" }), 'snapper check "C:/g" --sessions 3 --out "C:/o"');
  assert.equal(commandLine("check", { root: "C:/g", session: "C:/s/x", marks: ["0003"], accept: true }), 'snapper check "C:/g" --session "C:/s/x" --marks 0003 --accept');
});
