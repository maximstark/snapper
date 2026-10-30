import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  jpegSize, nthFor, rectsAt, rectsNear, scaleRects, Cooldowns, consoleText, consoleLevel, exceptionText,
  keyInfo, charKeyInfo, configFlags, checkExpect, oneLine,
} from "../../packages/host/main/helpers.mjs";
import { buildOptions } from "../../packages/host/main/cli-play.mjs";

test("host helpers: jpegSize reads the SOF marker", () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8, 0x01, 0x0e, 0x01, 0xe0, 3, 1, 0x22, 0]);
  assert.deepEqual(jpegSize(jpg), { h: 270, w: 480 });
  assert.equal(jpegSize(Buffer.from([1, 2, 3, 4])), null);
});

test("host helpers: nthFor targets ~10 fps", () => {
  assert.equal(nthFor(180), 18);
  assert.equal(nthFor(60), 6);
  assert.equal(nthFor(0), 6);
  assert.equal(nthFor(5), 1);
});

test("host helpers: overlay rect history", () => {
  const h = [{ t: 100, vw: 1000, vh: 500, rects: [{ x: 800, y: 0, w: 200, h: 40 }] }, { t: 900, vw: 1000, vh: 500, rects: [] }, { t: 1000, vw: 1000, vh: 500, rects: [{ x: 0, y: 0, w: 8, h: 8 }] }];
  assert.equal(rectsAt(h, 50), null);
  assert.equal(rectsAt(h, 500).rects.length, 1);
  assert.equal(rectsAt(h, 950).rects.length, 0);
  assert.equal(rectsNear(h, 950, 100).rects.length, 1);     // a rect reported 50 ms later also counts
  assert.equal(rectsNear(h, 20, 100).rects.length, 1);       // first report just after the frame
  assert.equal(rectsNear(h, 20, 10), null);
  assert.deepEqual(scaleRects([{ x: 800, y: 0, w: 200, h: 40 }], 1000, 500, 480, 240, 0), [{ x: 384, y: 0, w: 96, h: 20 }]);
  assert.deepEqual(scaleRects([], 1000, 500, 480, 240), []);
});

test("host helpers: cooldowns", () => {
  const c = new Cooldowns();
  assert.equal(c.ok("error", 0, 5000), true);
  assert.equal(c.ok("error", 4999, 5000), false);
  assert.equal(c.ok("fps", 100, 10000), true);
  assert.equal(c.ok("error", 5000, 5000), true);
});

test("host helpers: console and exception text", () => {
  assert.equal(consoleText([{ type: "string", value: "a" }, { type: "number", value: 2, description: "2" }, { type: "object", description: "Object" }]), "a 2 Object");
  assert.equal(consoleLevel("warning"), "warn");
  assert.equal(consoleLevel("assert"), "error");
  assert.equal(consoleLevel("log"), "log");
  const e = exceptionText({ exception: { description: "TypeError: x\n    at f (a.js:1:2)\n    at g (a.js:3:4)" } });
  assert.equal(e.text, "TypeError: x");
  assert.match(e.stack, /at f/);
  assert.equal(exceptionText({ text: "Uncaught", exception: { value: "boom" }, url: "u.js", lineNumber: 0, columnNumber: 4 }).text, "Uncaught boom");
});

test("host helpers: key info for CDP", () => {
  assert.deepEqual(keyInfo("KeyD"), { code: "KeyD", key: "d", vk: 68, text: "d" });
  assert.equal(keyInfo("Space").vk, 32);
  assert.equal(keyInfo("F8").vk, 119);
  assert.equal(keyInfo("Enter").key, "Enter");
  assert.equal(charKeyInfo("h").code, "KeyH");
  assert.equal(charKeyInfo("H").shift, true);
});

test("host helpers: CLI flags become a config patch", () => {
  const f = configFlags({ preset: "deck", gameRoot: "x", smoke: "s.json", ringSeconds: "8", padMark: "6,7", out: "rel/dir", fullscreen: true }, { cwd: "C:/work", resolve });
  assert.deepEqual(f, { preset: "deck", ringSeconds: 8, padMark: [6, 7], out: resolve("C:/work", "rel/dir") });
});

test("host helpers (v1.3): --hotkeys, --bare and --coi flags", () => {
  assert.deepEqual(configFlags({ hotkeys: "mark=F9,save=F6" }), { hotkeys: { mark: "F9", save: "F6" } });
  assert.deepEqual(configFlags({ hotkeys: " mark = KeyM " }), { hotkeys: { mark: "KeyM" } });
  assert.throws(() => configFlags({ hotkeys: "jump=F9" }), /--hotkeys/);
  assert.throws(() => configFlags({ hotkeys: "mark" }), /--hotkeys/);
  assert.deepEqual(configFlags({ bare: true, coi: true, padMarkHoldMs: "600" }), { padMarkHoldMs: 600, bare: true, crossOriginIsolated: true });
  assert.deepEqual(configFlags({ bare: "nope" }), {});
  const o = buildOptions({ positional: ["examples/demo"], flags: { bare: true, coi: true, hotkeys: "mark=F9", ringSeconds: "3" } });
  assert.equal(o.config.bare, true);
  assert.equal(o.config.crossOriginIsolated, true);
  assert.equal(o.config.hotkeys.mark, "F9");
  assert.equal(o.config.hotkeys.save, "F6");
  assert.equal(o.config.ringSeconds, 3);
  const d = buildOptions({ positional: ["examples/demo"], flags: {} });
  assert.equal(d.config.bare, false);
  assert.equal(d.config.crossOriginIsolated, false);
  assert.throws(() => buildOptions({ positional: ["examples/demo"], flags: { hotkeys: "x=1" } }), /--hotkeys/);
});

test("host helpers: smoke expect", () => {
  const st = { marks: 3, exceptions: 1, errors: 2, triggers: new Set(["smoke", "error"]), ready: { sdk: true, state: false } };
  assert.deepEqual(checkExpect({ marksAtLeast: 3, exceptions: 1, errors: 1, triggers: ["smoke"], ready: { sdk: true } }, st), []);
  assert.equal(checkExpect({ marksAtLeast: 4 }, st).length, 1);
  assert.equal(checkExpect({ triggers: ["fps"] }, st).length, 1);
  assert.equal(checkExpect({ ready: ["sdk", "state"] }, st).length, 1);
  assert.equal(oneLine("a\n  b", 10), "a b");
});

test("host cli: buildOptions validates the target", () => {
  assert.throws(() => buildOptions({ positional: [], flags: {} }), /missing/);
  assert.throws(() => buildOptions({ positional: ["http://127.0.0.1:1/"], flags: {} }), /game-root/);
  const o = buildOptions({ positional: ["tests/fixtures/host-page"], flags: { preset: "deck", slug: "x" } });
  assert.equal(o.target.kind, "dir");
  assert.equal(o.slug, "x");
  assert.equal(o.config.preset, "deck");
  assert.equal(o.smoke, null);
});
