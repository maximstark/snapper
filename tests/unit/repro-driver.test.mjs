// v1.4 Part 4: the no-Snapper repro driver (packages/sdk/repro-driver.js) agrees with core's replay positioning and compare,
// and export-repro's pure helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as D from "../../packages/sdk/repro-driver.js";
import { stepTo as coreStepTo, runsBetween as coreRuns, maskAt as coreMaskAt, codesOf as coreCodes, diffPaths as coreDiffs } from "../../packages/core/index.mjs";
import { injectTags, openQuery, tapeJson } from "../../packages/host/tools/export-repro.mjs";

const KEYMAP = ["KeyA", "KeyD", "KeyW", "KeyS", "Space"];
const TAPE = [{ f: 0, m: 0 }, { f: 3, m: 2 }, { f: 4, m: 18 }, { f: 40, m: 0 }, { f: 41, m: 1 }, { f: 90, m: 16 }, { f: 91, m: 0 }];

/** A deterministic fake game with the SDK's tick semantics: `skew` = the frame counter runs one ahead of the ticks. */
function fakeGame({ skew = false } = {}) {
  let frame = -1, x = 0, y = 0, log = [];
  const g = {
    lastTick: -1,
    step(n, codes) {
      for (let i = 0; i < n; i++) {
        frame++;
        const m = KEYMAP.reduce((a, c, b) => a | (codes.includes(c) ? 1 << b : 0), 0);
        if (m & 2) x += 1.5; if (m & 1) x -= 1.5; if (m & 16) y = (y * 31 + frame) % 997;
        log.push(m);
        g.lastTick = skew && frame === 10 ? frame + 1 : frame;          // one skewed tick number, as a game that counts after update
      }
      return g.lastTick;
    },
    state: () => ({ frame, x, y, steps: log.length, perf: { fps: Math.random() } }),
  };
  return g;
}

test("repro-driver helpers equal core's maskAt / codesOf / runsBetween / diffPaths", () => {
  for (let f = -1; f < 100; f++) assert.equal(D.maskAt(TAPE, f), coreMaskAt(TAPE, f));
  for (const m of [0, 1, 2, 18, 31]) assert.deepEqual(D.codesOf(m, KEYMAP), coreCodes(m, KEYMAP));
  for (const [a, b] of [[0, 99], [5, 41], [41, 41], [50, 10], [0, 0]]) assert.deepEqual(D.runsBetween(TAPE, a, b), coreRuns(TAPE, a, b));
  const s1 = { a: 1, b: { c: [1, 2, 3] }, perf: 1, z: 0 }, s2 = { a: 2, b: { c: [1, 9, 3] }, perf: 2, y: 0 };
  assert.deepEqual(D.diffPaths(s1, s2), coreDiffs(s1, s2, ["perf"]));
  assert.equal(D.valueAt({ a: { b: [5, { c: 7 }] } }, "$.a.b[1].c"), 7);
});

test("repro-driver stepTo lands on the same frame with the same inputs as core stepTo (plain and skewed tick numbering)", async () => {
  for (const skew of [false, true]) {
    for (const to of [0, 3, 39, 40, 95]) {
      const g1 = fakeGame({ skew }), g2 = fakeGame({ skew });
      const core = await coreStepTo({ frames: TAPE, keymap: KEYMAP, last: -1, to, chunk: 7,
        stepRuns: async runs => { let r; for (const x of runs) r = g1.step(x.n, x.codes); return r; } });
      const mine = await D.stepTo({ frames: TAPE, keymap: KEYMAP, last: -1, to, step: (n, codes) => g2.step(n, codes) });
      assert.equal(mine.last, core.last, `skew ${skew} to ${to}`);
      assert.deepEqual(g2.state().x, g1.state().x);
      assert.deepEqual({ ...g2.state(), perf: 0 }, { ...g1.state(), perf: 0 }, `skew ${skew} to ${to}`);
    }
  }
});

test("runRepro: match, differs (with the recorded/replayed values), and the refusals", async () => {
  const play = async (to, tweak) => {
    const g = fakeGame();
    await D.stepTo({ frames: TAPE, keymap: KEYMAP, last: -1, to, step: (n, c) => g.step(n, c) });
    const s = g.state();
    return tweak ? tweak(s) : s;
  };
  const tape = { frames: TAPE, markFrame: 60, keymap: KEYMAP, pauseParam: "paused", query: "?level=2" };
  const snFor = () => {
    const g = fakeGame();
    const host = { ready: () => ({ stepper: true }), pause() {}, step: (n, c) => g.step(n, c), state: () => JSON.stringify(g.state()) };
    return () => ({ __host: host, frame: () => g.lastTick });
  };
  const expected = { state: await play(60) };
  const ok = await D.runRepro({ tape, expected, sn: snFor(), search: "?level=2&paused&snapper-repro=1" });
  assert.equal(ok.status, "match");
  assert.equal(ok.frame, 60);
  assert.equal(D.verdictLine(ok), "REPRO: match at frame 60");
  const bad = await D.runRepro({ tape, expected: { state: await play(60, s => ({ ...s, x: s.x + 1, y: -1 })) }, sn: snFor(), search: "?level=2&paused" });
  assert.equal(bad.status, "differs");
  assert.deepEqual(bad.diffs, ["$.x", "$.y"]);
  assert.match(D.verdictLine(bad), /^REPRO: differs \$\.x, \$\.y \(at frame 60; \$\.x: recorded [\d.]+, replayed [\d.]+\)$/);
  const notPaused = await D.runRepro({ tape, expected, sn: snFor(), search: "?level=2" });
  assert.equal(notPaused.status, "error");
  assert.match(notPaused.message, /open the game with \?paused/);
  const noSdk = await D.runRepro({ tape, expected, sn: () => undefined, search: "?paused", timeoutMs: 120 });
  assert.match(noSdk.message, /window\.snapper is missing/);
  const wrongQuery = await D.runRepro({ tape, expected, sn: snFor(), search: "?paused" });
  assert.equal(wrongQuery.status, "match");
  assert.match(wrongQuery.warnings[0], /played with level=2; this page has no level/);
  assert.equal((await D.runRepro({ tape: null, expected, sn: snFor(), search: "?paused" })).status, "error");
});

test("repro-driver.js is browser-clean ESM: no Node imports, no require, no Chromium-only API", () => {
  const src = readFileSync(fileURLToPath(new URL("../../packages/sdk/repro-driver.js", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\brequire\(|node:|process\.|chrome\.|webkit[A-Z]/);
});

test("export-repro helpers: injectTags, openQuery, tapeJson", () => {
  const html = '<head></head><body><canvas></canvas><script src="lib.js"></script><script type="module" src="./game.js"></script></body>';
  const out = injectTags(html);
  assert.ok(out.indexOf('<script src="repro/snapper-sdk.js"></script>') < out.indexOf('<script type="module" src="./game.js">'));
  assert.ok(out.indexOf('<script src="lib.js">') < out.indexOf("repro/snapper-sdk.js"), "before the first MODULE script");
  assert.match(injectTags("<body><script src=a.js></script></body>"), /repro\/driver\.js"><\/script>\n<script src=a\.js>/);
  assert.match(injectTags("<body>x</body>", "../repro/"), /<script src="\.\.\/repro\/snapper-sdk\.js"><\/script>\n<script type="module" src="\.\.\/repro\/driver\.js"><\/script>\n<\/body>/);
  assert.equal(openQuery("?scene=stage&level=1-1", "paused"), "?scene=stage&level=1-1&paused&snapper-repro=1");
  assert.equal(openQuery("", "p"), "?p&snapper-repro=1");
  const t = tapeJson({ v: 1, markFrame: 5, frames: [{ f: 0, m: 0 }, { f: 3, m: 2 }] });
  assert.deepEqual(JSON.parse(t), { v: 1, markFrame: 5, frames: [{ f: 0, m: 0 }, { f: 3, m: 2 }] });
  assert.match(t, /^  \{"f":3,"m":2\}$/m);
});
