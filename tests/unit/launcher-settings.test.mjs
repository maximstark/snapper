import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultSettings, mergeSettings, addRecent, rememberRoot, fieldsFor, commandLine, normRoot,
} from "../../packages/host/launcher/settings.mjs";

const DEF = { preset: "1080p", fullscreen: false, query: "", url: "", hotkey: "", padHoldMs: null, ringSeconds: null, bare: false };
const def = o => ({ ...DEF, ...o });

test("defaults", () => {
  const d = defaultSettings();
  assert.deepEqual(d, { v: 1, recent: [], lastRoot: "", perRoot: {}, bounds: null, attach: {} });
  assert.deepEqual(fieldsFor(d, "C:/anything"), DEF);
});

test("mergeSettings: nothing, garbage, partial", () => {
  assert.deepEqual(mergeSettings(undefined), defaultSettings());
  assert.deepEqual(mergeSettings(null), defaultSettings());
  assert.deepEqual(mergeSettings("junk"), defaultSettings());
  assert.deepEqual(mergeSettings([1, 2]), defaultSettings());
  const g = mergeSettings({ recent: "x", lastRoot: 5, perRoot: [], bounds: { x: "a" } });
  assert.deepEqual(g, defaultSettings());
  const p = mergeSettings({
    recent: ["C:\\a", 7, "", "c:/A/", "D:/b"], lastRoot: "D:\\b",
    perRoot: { "D:\\b": { preset: "nope", fullscreen: "yes", query: 3 }, "E:/c": { preset: "deck", fullscreen: true, query: "?x=1" }, "F:/d": 5 },
    bounds: { x: 10.4, y: 20, width: 800, height: 600 },
  });
  assert.deepEqual(p.recent, ["C:/a", "D:/b"]);
  assert.equal(p.lastRoot, "D:/b");
  assert.deepEqual(p.perRoot["D:/b"], DEF);
  assert.deepEqual(p.perRoot["E:/c"], def({ preset: "deck", fullscreen: true, query: "?x=1" }));
  assert.equal(p.perRoot["F:/d"], undefined);
  assert.deepEqual(p.bounds, { x: 10, y: 20, width: 800, height: 600 });
  assert.equal(mergeSettings({ bounds: { x: 0, y: 0, width: 10, height: 10 } }).bounds, null);
});

test("addRecent: newest first, de-dup case and slashes, cap 8", () => {
  let r = [];
  r = addRecent(r, "C:\\Games\\One");
  r = addRecent(r, "C:/Games/Two");
  assert.deepEqual(r, ["C:/Games/Two", "C:/Games/One"]);
  r = addRecent(r, "c:/games/one/");
  assert.deepEqual(r, ["c:/games/one", "C:/Games/Two"]);
  r = addRecent(r, "C:\\GAMES\\TWO\\");
  assert.deepEqual(r, ["C:/GAMES/TWO", "c:/games/one"]);
  for (let i = 0; i < 12; i++) r = addRecent(r, `D:/g${i}`);
  assert.equal(r.length, 8);
  assert.equal(r[0], "D:/g11");
  assert.equal(r[7], "D:/g4");
  assert.deepEqual(addRecent(["C:/a"], ""), ["C:/a"]);
  assert.equal(normRoot("C:\\"), "C:/");
});

test("rememberRoot + fieldsFor round trip per root", () => {
  let s = defaultSettings();
  s = rememberRoot(s, "C:\\Coding\\Moon", { preset: "ultrawide", fullscreen: true, query: "?scene=stage&level=1-1" });
  s = rememberRoot(s, "C:/Coding/Demo", { preset: "deck" });
  assert.equal(s.lastRoot, "C:/Coding/Demo");
  assert.deepEqual(s.recent, ["C:/Coding/Demo", "C:/Coding/Moon"]);
  assert.deepEqual(fieldsFor(s, "c:/coding/moon/"), def({ preset: "ultrawide", fullscreen: true, query: "?scene=stage&level=1-1" }));
  assert.deepEqual(fieldsFor(s, "C:/Coding/Demo"), def({ preset: "deck" }));
  assert.deepEqual(fieldsFor(s, "C:/Unknown"), DEF);
  // remembering again with other case keeps one entry and keeps unspecified fields
  s = rememberRoot(s, "C:/CODING/MOON", { query: "" });
  assert.equal(Object.keys(s.perRoot).length, 2);
  assert.deepEqual(fieldsFor(s, "C:/Coding/Moon"), def({ preset: "ultrawide", fullscreen: true, query: "" }));
  assert.deepEqual(s.recent, ["C:/CODING/MOON", "C:/Coding/Demo"]);
  // survives JSON
  assert.deepEqual(mergeSettings(JSON.parse(JSON.stringify(s))), s);
});

test("commandLine: play", () => {
  assert.equal(commandLine("play", { root: "C:/g/demo", preset: "deck" }), 'snapper play "C:/g/demo" --preset deck');
  assert.equal(commandLine("play", { root: "C:\\g\\demo", preset: "ultrawide", fullscreen: true, query: "?scene=stage&level=1-1" }),
    'snapper play "C:/g/demo" --preset ultrawide --fullscreen --query "?scene=stage&level=1-1"');
  assert.equal(commandLine("play", { root: "C:/My Games/x y", preset: "1080p", out: "C:/t/out dir" }),
    'snapper play "C:/My Games/x y" --preset 1080p --out "C:/t/out dir"');
  assert.equal(commandLine("play", { root: "C:/g", preset: "native", fullscreen: false, query: "", out: "" }), 'snapper play "C:/g" --preset native');
  assert.equal(commandLine("play", { root: "C:/g", query: 'a"b' }), 'snapper play "C:/g" --query "a\\"b"');
});

test("commandLine: resume and replay", () => {
  assert.equal(commandLine("resume", { root: "C:/g", session: "C:/s/a b/2026", at: "mark-0003", preset: "deck", fullscreen: true, query: "?ignored" }),
    'snapper play "C:/g" --resume "C:/s/a b/2026" --at mark-0003 --preset deck --fullscreen');
  assert.equal(commandLine("resume", { root: "C:/g", session: "C:/s/x" }), 'snapper play "C:/g" --resume "C:/s/x" --at exit');
  assert.equal(commandLine("resume", { root: "C:/g", session: "C:/s/x", at: "exit", out: "D:/o" }), 'snapper play "C:/g" --resume "C:/s/x" --at exit --out "D:/o"');
  assert.equal(commandLine("replay", { session: "C:\\s\\my session\\2026-10-20", markId: "0001" }), 'snapper replay "C:/s/my session/2026-10-20" 0001');
});
