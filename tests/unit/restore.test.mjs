// Replay-to-frame stepping (D-014, D-021): chunking, stepTo against a fake stepper, query param, compare.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { chunkRuns, stepTo, addQueryParam, stepExpression, firstDiff, compareState, maskAt, codesOf, segmentQuery, chooseQuery } from "../../packages/core/index.mjs";

const KEYMAP = ["KeyA", "KeyD", "Space"];
const FRAMES = [{ f: 0, m: 0 }, { f: 10, m: 2 }, { f: 25, m: 6 }, { f: 40, m: 0 }, { f: 55, m: 1 }];

/** In-memory stepper: records the codes used for every frame it ticks. */
function fakeStepper({ start = -1, skipAfter = null, stuck = false } = {}) {
  const s = { cur: start, codesByFrame: new Map(), calls: 0, skipped: false };
  s.stepRuns = async runs => {
    s.calls++;
    if (stuck) return s.cur;
    for (const r of runs) {
      for (let i = 0; i < r.n; i++) {
        s.cur++;
        s.codesByFrame.set(s.cur, r.codes);
        if (skipAfter !== null && !s.skipped && s.cur === skipAfter) { s.cur++; s.skipped = true; }
      }
    }
    return s.cur;
  };
  return s;
}

const expectCodes = (st, from, to) => {
  for (let f = from; f <= to; f++) {
    if (!st.codesByFrame.has(f)) continue;
    assert.deepEqual(st.codesByFrame.get(f), codesOf(maskAt(FRAMES, f), KEYMAP), `codes at frame ${f}`);
  }
};

test("chunkRuns: splits runs across chunk boundaries and reports the end frame", () => {
  const runs = [{ from: 0, n: 25, mask: 1 }, { from: 25, n: 10, mask: 2 }];
  const chunks = [...chunkRuns(runs, 10)];
  assert.deepEqual(chunks.map(c => [c.frames, c.end]), [[10, 9], [10, 19], [10, 29], [5, 34]]);
  assert.deepEqual(chunks[2].runs, [{ from: 20, n: 5, mask: 1 }, { from: 25, n: 5, mask: 2 }]);
  assert.deepEqual(chunks[3].runs, [{ from: 30, n: 5, mask: 2 }]);
  const total = chunks.flatMap(c => c.runs).reduce((a, r) => a + r.n, 0);
  assert.equal(total, 35, "no frame is lost or repeated");

  assert.deepEqual([...chunkRuns([], 10)], []);
  const big = [...chunkRuns(runs, 1000)];
  assert.equal(big.length, 1);
  assert.equal(big[0].end, 34);
  assert.deepEqual([...chunkRuns([{ from: 5, n: 3, mask: 0 }], 0)].map(c => c.end), [5, 6, 7], "size < 1 is treated as 1");
});

test("chunkRuns: size may be a function, called before each chunk", () => {
  const sizes = [3, 100, 4];
  let i = 0;
  const seen = [];
  const chunks = [...chunkRuns([{ from: 0, n: 20, mask: 1 }], () => { const s = sizes[Math.min(i++, sizes.length - 1)]; seen.push(s); return s; })];
  assert.deepEqual(chunks.map(c => c.frames), [3, 17]);
  assert.deepEqual(seen, [3, 100]);
});

test("stepTo: every frame after `last` up to `to` gets the codes of its mask; last === to", async () => {
  const st = fakeStepper();
  const chunks = [];
  const r = await stepTo({ frames: FRAMES, keymap: KEYMAP, last: -1, to: 70, chunk: 16, stepRuns: st.stepRuns, onChunk: c => chunks.push(c) });
  assert.equal(r.last, 70);
  assert.equal(st.cur, 70);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.steps, 71);
  assert.equal(r.chunks, 5);
  assert.equal(st.codesByFrame.size, 71);
  expectCodes(st, 0, 70);
  assert.equal(chunks.length, 5, "onChunk once per chunk");
  assert.equal(chunks[chunks.length - 1].last, 70);
  assert.equal(chunks[0].to, 70);
  assert.equal(chunks[0].frames, 16);
  assert.deepEqual(st.codesByFrame.get(12), ["KeyD"]);
  assert.deepEqual(st.codesByFrame.get(30), ["KeyD", "Space"]);
  assert.deepEqual(st.codesByFrame.get(45), []);
  assert.deepEqual(st.codesByFrame.get(60), ["KeyA"]);
});

test("stepTo: starting from a later frame steps only (last, to]", async () => {
  const st = fakeStepper({ start: 20 });
  const r = await stepTo({ frames: FRAMES, keymap: KEYMAP, last: 20, to: 50, chunk: 7, stepRuns: st.stepRuns });
  assert.equal(r.last, 50);
  assert.equal(r.steps, 30);
  assert.deepEqual([...st.codesByFrame.keys()].sort((a, b) => a - b)[0], 21);
  expectCodes(st, 21, 50);
  // already there: nothing to step
  const same = fakeStepper({ start: 50 });
  const r2 = await stepTo({ frames: FRAMES, keymap: KEYMAP, last: 50, to: 50, stepRuns: same.stepRuns });
  assert.equal(r2.last, 50);
  assert.equal(r2.steps, 0);
  assert.equal(same.calls, 0);
});

test("stepTo: a non-integer `last` starts from -1; the default chunk is 500", async () => {
  const st = fakeStepper();
  const r = await stepTo({ frames: FRAMES, keymap: KEYMAP, last: undefined, to: 1200, stepRuns: st.stepRuns });
  assert.equal(r.last, 1200);
  assert.equal(r.chunks, 3);
  expectCodes(st, 0, 1200);
});

test("stepTo: a tick number that is skipped → warning, single-step fallback still reaches `to`", async () => {
  const st = fakeStepper({ skipAfter: 12 });
  const r = await stepTo({ frames: FRAMES, keymap: KEYMAP, last: -1, to: 60, chunk: 20, stepRuns: st.stepRuns });
  assert.equal(r.last, 60);
  assert.equal(st.cur, 60);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /tick numbering skipped \(expected frame 19, got 20\)/);
  assert.match(r.warnings[0], /single steps/);
  expectCodes(st, 0, 60);
  assert.ok(st.calls > 3, "fell back to one call per frame");
});

test("stepTo: the fallback reports progress every 200 steps", async () => {
  const st = fakeStepper({ skipAfter: 1 });
  const progress = [];
  const r = await stepTo({ frames: FRAMES, keymap: KEYMAP, last: -1, to: 500, chunk: 50, stepRuns: st.stepRuns, onChunk: c => progress.push(c) });
  assert.equal(r.last, 500);
  assert.ok(progress.length >= 1);
  assert.ok(progress.every(p => p.frames === 1));
});

test("stepTo: a stepper that never advances throws", async () => {
  const st = fakeStepper({ stuck: true });
  await assert.rejects(
    stepTo({ frames: FRAMES, keymap: KEYMAP, last: -1, to: 30, chunk: 10, stepRuns: st.stepRuns }),
    /the stepper stopped advancing at frame -1/,
  );
  assert.ok(st.calls <= 6, "gives up after a few attempts");
});

test("stepTo: the game is already past the target → warning, no steps", async () => {
  const st = fakeStepper({ start: 100 });
  const r = await stepTo({ frames: FRAMES, keymap: KEYMAP, last: 100, to: 50, stepRuns: st.stepRuns });
  assert.equal(r.last, 100);
  assert.equal(r.steps, 0);
  assert.equal(r.chunks, 0);
  assert.equal(st.calls, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /already at frame 100, past the target 50/);
});

test("addQueryParam: appends a bare param once", () => {
  assert.equal(addQueryParam("http://h/index.html", "paused"), "http://h/index.html?paused");
  assert.equal(addQueryParam("http://h/index.html?a=1", "paused"), "http://h/index.html?a=1&paused");
  assert.equal(addQueryParam("http://h/index.html?paused", "paused"), "http://h/index.html?paused");
  assert.equal(addQueryParam("http://h/index.html?a=1&paused", "paused"), "http://h/index.html?a=1&paused");
  assert.equal(addQueryParam("http://h/index.html?paused=1&a=2", "paused"), "http://h/index.html?paused=1&a=2");
  assert.equal(addQueryParam("http://h/index.html?unpaused", "paused"), "http://h/index.html?unpaused&paused", "a longer name is not the param");
  assert.equal(addQueryParam("http://h/index.html", ""), "http://h/index.html");
  assert.equal(addQueryParam("http://h/index.html", undefined), "http://h/index.html");
  assert.equal(addQueryParam("http://h/index.html", "hold"), "http://h/index.html?hold");
});

test("stepExpression: evaluated against a fake snapper it steps every run and returns the frame", () => {
  const calls = [];
  let frame = 7;
  const ctx = vm.createContext({});
  ctx.snapper = { __host: { step(n, codes) { calls.push([n, codes]); frame += n; } }, frame: () => frame };
  const expr = stepExpression([{ n: 3, codes: ["KeyD"] }, { n: 5, codes: [] }, { n: 2, codes: ["KeyA", "Space"] }]);
  assert.equal(typeof expr, "string");
  const got = vm.runInContext(expr, ctx);
  assert.equal(got, 17);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[3, ["KeyD"]], [5, []], [2, ["KeyA", "Space"]]]); // arrays come from another realm
  // no runs → just the frame
  assert.equal(vm.runInContext(stepExpression([]), ctx), 17);
});

test("compareState / firstDiff: only the top-level perf key is ignored", () => {
  assert.equal(compareState({ a: 1, perf: { fps: 60 } }, { a: 1, perf: { fps: 3 } }), null);
  assert.equal(compareState({ a: 1 }, { a: 1, perf: { fps: 3 } }), null, "perf may be missing on one side");
  assert.deepEqual(compareState({ player: { x: 1 } }, { player: { x: 2 } }), { path: "$.player.x", recorded: 1, replayed: 2 });
  assert.equal(compareState({ n: { perf: 1 } }, { n: { perf: 2 } }).path, "$.n.perf", "nested perf is compared");
  assert.equal(compareState({ list: [{ perf: 1 }] }, { list: [{ perf: 2 }] }).path, "$.list[0].perf");
  assert.equal(compareState({ a: 1, b: 2 }, { b: 2, a: 1 }), null, "key order is irrelevant");
  assert.equal(compareState({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2, 3] }).path, "$.b[2]");
  assert.equal(compareState({ x: NaN }, { x: NaN }), null);
  assert.equal(firstDiff({ a: 1, perf: 1 }, { a: 1, perf: 2 }).path, "$.perf", "firstDiff alone ignores nothing");
  assert.equal(compareState(null, null), null);
  assert.equal(compareState({ a: 1 }, null).path, "$");
});

test("segmentQuery / chooseQuery (D-022): marker query, else env query, override wins", () => {
  const lines = [
    { f: 0, m: 0 },
    { f: 0, ev: "reload", t: 10, query: "?scene=stage&level=2-1", url: "http://x/?scene=stage&level=2-1" },
    { f: 0, m: 0 },
    { f: 0, ev: "reload", t: 20 },                       // no query (old session or an SDK reset): inherits
    { f: 0, ev: "reload", t: 30, query: "" },            // an explicit empty query is a query
  ];
  assert.deepEqual(segmentQuery(lines, 0, "?env=1"), { query: "?env=1", source: "env" }, "segment 0 is the session's query");
  assert.deepEqual(segmentQuery(lines, 1, "?env=1"), { query: "?scene=stage&level=2-1", source: "marker" });
  assert.deepEqual(segmentQuery(lines, 2, "?env=1"), { query: "?scene=stage&level=2-1", source: "marker" });
  assert.deepEqual(segmentQuery(lines, 3, "?env=1"), { query: "", source: "marker" });
  assert.deepEqual(segmentQuery([{ f: 0, ev: "reload", t: 1 }], 1, "?env=1"), { query: "?env=1", source: "env" }, "no marker has a query: the env's");
  assert.deepEqual(segmentQuery([], 0, undefined), { query: "", source: "env" });
  assert.deepEqual(chooseQuery({ override: "?o=1", lines, index: 1, envQuery: "?env=1" }), { query: "?o=1", source: "override" });
  assert.deepEqual(chooseQuery({ override: "", lines, index: 1, envQuery: "?env=1" }), { query: "", source: "override" }, "an empty override is still an override");
  assert.deepEqual(chooseQuery({ lines, index: 1, envQuery: "?env=1" }), { query: "?scene=stage&level=2-1", source: "marker" });
});
