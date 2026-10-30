// G1 core: tape segment selection and run-length helpers, perf stats, PNG, static server, config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTape, segments, segmentForMark, maskAt, codesOf, maskOf, runsBetween, frameLinesWindow, tapeLinesFromFlush,
  perfStats, buildPerfJson, longTasksOf,
  encodePng, decodePng, pngSize, pngStats, dataUrlToBuffer,
  serveStatic, slugify, resolveConfig, gitInfo, DEFAULT_CONFIG, composeSheetSource,
} from "../../packages/core/index.mjs";

test("tape: parse, segments, segment for a mark (stamped markers)", () => {
  const text = [
    { kind: "tape", v: 1, keymap: ["KeyA", "KeyD", "Space"], pauseParam: "paused" },
    { f: 0, m: 0 }, { t: 10, k: "KeyD", d: 1 }, { f: 5, m: 2 }, { f: 9, m: 0 },
    { f: 0, ev: "reload", t: 5000 },
    { f: 0, m: 0 }, { f: 3, m: 4 },
    { f: 0, ev: "reload", t: 9000 },
    { f: 0, m: 1 },
  ].map(l => JSON.stringify(l)).join("\n") + "\n{\"f\":";
  const { header, lines } = parseTape(text);
  assert.deepEqual(header.keymap, ["KeyA", "KeyD", "Space"]);
  const segs = segments(lines);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0].frames, [{ f: 0, m: 0 }, { f: 5, m: 2 }, { f: 9, m: 0 }]);
  assert.equal(segmentForMark(lines, { t: 4000, frame: 7 }).index, 0);
  assert.equal(segmentForMark(lines, { t: 5000, frame: 7 }).index, 1);
  assert.equal(segmentForMark(lines, { t: 8999, frame: 7 }).index, 1);
  assert.equal(segmentForMark(lines, { t: 12000, frame: 7 }).index, 2);
  // unstamped markers: the last segment (the format's literal rule)
  const un = lines.map(l => (l.ev ? { f: l.f, ev: l.ev } : l));
  assert.equal(segmentForMark(un, { t: 4000, frame: 7 }).index, 2);
  // no frame lines at all
  assert.equal(segmentForMark([{ t: 1, k: "KeyA", d: 1 }], { t: 5 }), null);
});

test("tape: masks, codes, runs, windows, SDK flush conversion", () => {
  const keymap = ["KeyA", "KeyD", "Space"];
  const frames = [{ f: 0, m: 0 }, { f: 5, m: 2 }, { f: 9, m: 6 }, { f: 20, m: 0 }];
  assert.equal(maskAt(frames, 0), 0);
  assert.equal(maskAt(frames, 4), 0);
  assert.equal(maskAt(frames, 5), 2);
  assert.equal(maskAt(frames, 19), 6);
  assert.equal(maskAt(frames, 1000), 0);
  assert.equal(maskAt([{ f: 3, m: 1 }], 1), 0);
  assert.deepEqual(codesOf(6, keymap), ["KeyD", "Space"]);
  assert.equal(maskOf(["Space", "KeyA", "Nope"], keymap), 5);
  assert.deepEqual(runsBetween(frames, 0, 25), [
    { from: 0, n: 5, mask: 0 }, { from: 5, n: 4, mask: 2 }, { from: 9, n: 11, mask: 6 }, { from: 20, n: 6, mask: 0 }]);
  assert.deepEqual(runsBetween(frames, 7, 10), [{ from: 7, n: 2, mask: 2 }, { from: 9, n: 2, mask: 6 }]);
  assert.deepEqual(runsBetween(frames, 7, 6), []);
  const total = runsBetween(frames, 3, 30).reduce((a, r) => a + r.n, 0);
  assert.equal(total, 28);
  assert.deepEqual(frameLinesWindow(frames, 6, 19), [{ f: 5, m: 2 }, { f: 9, m: 6 }]);
  const f = Int32Array.from([0, 4, 2, 2]), m = Int32Array.from([0, 1, -1, 1]);
  assert.deepEqual(tapeLinesFromFlush(f, m, 4, 123.4), [{ f: 0, m: 0 }, { f: 4, m: 1 }, { f: 2, ev: "reload", t: 123.4 }, { f: 2, m: 1 }]);
  assert.deepEqual(tapeLinesFromFlush(f, m, 1), [{ f: 0, m: 0 }]);
});

test("perf stats", () => {
  const iv = [...Array(98).fill(16.7), 40, 300];
  const s = perfStats(iv, 1000 / 60);
  assert.equal(s.samples, 100);
  assert.equal(s.p50, 16.7);
  assert.equal(s.p95, 16.7);
  assert.equal(s.max, 300);
  assert.equal(s.drops, 2);
  assert.deepEqual(perfStats([]), { samples: 0, p50: 0, p95: 0, max: 0, drops: 0 });
  const j = buildPerfJson({ intervals: iv, displayHz: 180, gameStats: { fps: 60 } });
  assert.equal(j.expectedMs, 16.667);
  assert.equal(j.window.samples, 100);
  assert.equal(j.max, 300);
  assert.deepEqual(j.gameStats, { fps: 60 });
  assert.deepEqual(longTasksOf([10, 120, 300], [100, 220, 520]), [{ t: 220, ms: 120 }, { t: 520, ms: 300 }]);
});

test("png: encode/decode round trip, size, stats, data URL", () => {
  const w = 5, h = 3, rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([i * 10, 255 - i, i, 255], i * 4);
  const buf = encodePng(w, h, rgba);
  assert.deepEqual(pngSize(buf), { w, h });
  const d = decodePng(buf);
  assert.deepEqual(Array.from(d.data), Array.from(rgba));
  const black = pngStats(encodePng(4, 4, new Uint8Array(64).fill(0).map((v, i) => (i % 4 === 3 ? 255 : 0))));
  assert.equal(black.nonBlack, 0);
  assert.ok(pngStats(buf).nonBlack > 0.5);
  assert.deepEqual(dataUrlToBuffer("data:image/png;base64," + buf.toString("base64")), buf);
  assert.equal(dataUrlToBuffer("nope"), null);
  assert.equal(pngSize(Buffer.from("x")), null);
});

test("static server: MIME, no-cache, index.html, traversal blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "snapper-serve-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "index.html"), "<h1>hi</h1>");
  await writeFile(join(root, "src", "a.mjs"), "export {}");
  await writeFile(join(root, "x.wasm"), Buffer.from([0, 97, 115, 109]));
  const srv = await serveStatic(root);
  try {
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    let r = await fetch(srv.url + "/");
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "<h1>hi</h1>");
    assert.match(r.headers.get("cache-control"), /no-store/);
    r = await fetch(srv.url + "/src/a.mjs");
    assert.match(r.headers.get("content-type"), /text\/javascript/);
    r = await fetch(srv.url + "/x.wasm");
    assert.equal(r.headers.get("content-type"), "application/wasm");
    r = await fetch(srv.url + "/missing.png");
    assert.equal(r.status, 404);
    r = await fetch(srv.url + "/..%2f..%2fWindows%2fwin.ini");
    assert.equal(r.status, 404);
  } finally {
    await srv.close();
  }
});

test("config: slug, precedence, git info", async () => {
  assert.equal(slugify("MoonFlex Force_Abilities v3!"), "moonflex-force-abilities-v3");
  const root = await mkdtemp(join(tmpdir(), "snapper-game-"));
  await writeFile(join(root, "snapper.config.json"), JSON.stringify({ slug: "MyGame", preset: "ultrawide", hotkeys: { mark: "F6" }, ringSeconds: 3 }));
  const r = resolveConfig({ root, flags: { preset: "deck", ringSeconds: undefined } });
  assert.equal(r.slug, "mygame");
  assert.equal(r.config.preset, "deck");
  assert.equal(r.config.ringSeconds, 3);
  assert.deepEqual(r.config.hotkeys, { ...DEFAULT_CONFIG.hotkeys, mark: "F6" });
  assert.equal(r.out, join(root, ".snapper", "sessions"));
  assert.equal(gitInfo(root), null);
  const repo = gitInfo(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  assert.ok(repo && /^[0-9a-f]{40}$/.test(repo.sha));
  assert.equal(resolveConfig({ flags: {} }).out, null);
});

test("composeSheetSource is a serialisable function expression", () => {
  const fn = new Function(`return ${composeSheetSource}`)();
  assert.equal(typeof fn, "function");
});
