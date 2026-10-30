// Checkpoints (D-021): names, files, --at resolution, resume source, tape segments, SESSION.md header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointName, checkpointPath, makeCheckpoint, writeCheckpoint, readCheckpoint, listCheckpoints, resolveAt,
  findResumeSource, samePath, rawSegments, pickSegment, resumeTapeLines, segmentOf, sessionIdOf,
  readSession, renderSessionMd, resumedLine, listCheckpointsWithMarks, synthesiseMarkCheckpoint,
} from "../../packages/core/index.mjs";
import { buildSessionA } from "../fixtures/session-a.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "snapper-cp-"));

test("checkpointName: manual is padded, mark is prefixed, exit is bare", () => {
  assert.equal(checkpointName("manual", 1), "0001");
  assert.equal(checkpointName("manual", 42), "0042");
  assert.equal(checkpointName("mark", 3), "mark-0003");
  assert.equal(checkpointName("mark", "0007"), "mark-0007");
  assert.equal(checkpointName("exit", 9), "exit");
  assert.equal(checkpointPath("/s", "0001").replace(/\\/g, "/"), "/s/checkpoints/0001.json");
});

test("makeCheckpoint: defaults and key order with state last", () => {
  const cp = makeCheckpoint({ name: "0001", kind: "manual", frame: 120, t: 5000, state: { a: 1 } });
  assert.deepEqual(Object.keys(cp), ["v", "name", "kind", "trigger", "frame", "t", "query", "segment", "restorable", "state"]);
  assert.equal(cp.v, 1);
  assert.equal(cp.trigger, "manual", "trigger defaults to the kind");
  assert.equal(cp.query, "");
  assert.deepEqual(cp.segment, { index: 0, reloadT: null });
  assert.equal(cp.restorable, false, "restorable must be explicit");
  assert.deepEqual(cp.state, { a: 1 });

  const full = makeCheckpoint({
    name: "mark-0003", kind: "mark", trigger: "mark", frame: 450, t: 9000, markId: 3, query: "?x=1",
    segment: { index: 2, reloadT: 777 }, restorable: true, reason: "because", state: { p: 1 },
  });
  assert.deepEqual(Object.keys(full), ["v", "name", "kind", "trigger", "frame", "t", "markId", "query", "segment", "restorable", "reason", "state"]);
  assert.equal(full.markId, "3", "markId is a string");

  const bad = makeCheckpoint({ name: "x", kind: "exit", frame: 1.5, t: 1, restorable: true });
  assert.equal(bad.frame, -1, "a non-integer frame becomes -1");
  assert.deepEqual(bad.state, { unavailable: true }, "missing state is marked unavailable");
});

test("write / read / list checkpoints: round trip, sorted by t, restorable flag, missing folder", async () => {
  const dir = await tmp();
  assert.deepEqual(await listCheckpoints(dir), []);
  assert.equal(await readCheckpoint(dir, "0001"), null);

  const a = makeCheckpoint({ name: "exit", kind: "exit", frame: 900, t: 30000, restorable: true, state: { x: 9 } });
  const b = makeCheckpoint({ name: "0001", kind: "manual", frame: 300, t: 10000, restorable: true, state: { x: 3 } });
  const c = makeCheckpoint({ name: "mark-0001", kind: "mark", trigger: "mark", frame: 600, t: 20000, markId: "0001", restorable: false, reason: "no stepper", state: { x: 6 } });
  const p = await writeCheckpoint(dir, a);
  assert.ok(p.replace(/\\/g, "/").endsWith("/checkpoints/exit.json"));
  await writeCheckpoint(dir, b);
  await writeCheckpoint(dir, c);
  assert.ok((await readFile(p, "utf8")).endsWith("\n"));

  assert.deepEqual(await readCheckpoint(dir, "exit"), a);
  const list = await listCheckpoints(dir);
  assert.deepEqual(list.map(x => x.name), ["0001", "mark-0001", "exit"]);
  assert.deepEqual(list[0], { name: "0001", kind: "manual", trigger: "manual", frame: 300, t: 10000, restorable: true });
  assert.equal(list[1].markId, "0001");
  assert.equal(list[1].restorable, false);
  assert.ok(!("state" in list[0]), "the list entry carries no state");

  // a stray non-json file and a broken json file are skipped
  await writeFile(join(dir, "checkpoints", "notes.txt"), "hi");
  await writeFile(join(dir, "checkpoints", "broken.json"), "{nope");
  assert.equal((await listCheckpoints(dir)).length, 3);
});

const L = [
  { name: "0001", kind: "manual", frame: 300, t: 1000, restorable: true },
  { name: "0003", kind: "manual", frame: 500, t: 2000, restorable: true },
  { name: "mark-0003", kind: "mark", frame: 450, t: 3000, markId: "0003", restorable: true },
  { name: "mark-0004", kind: "mark", frame: 460, t: 3500, markId: "0004", restorable: true },
  { name: "exit", kind: "exit", frame: 900, t: 4000, restorable: true },
];

test("resolveAt: default is exit; a missing exit lists the states", () => {
  assert.equal(resolveAt(L).checkpoint.name, "exit");
  assert.equal(resolveAt(L, true).checkpoint.name, "exit");
  assert.equal(resolveAt(L, "").checkpoint.name, "exit");
  const r = resolveAt(L.slice(0, 2), "exit");
  assert.match(r.error, /no exit checkpoint/);
  assert.match(r.error, /0001 \(frame 300\)/);
  assert.match(r.error, /0003 \(frame 500\)/);
  assert.match(resolveAt([], "exit").error, /states: none/);
});

test("resolveAt: names, bare numbers, mark forms", () => {
  assert.equal(resolveAt(L, "0001").checkpoint.name, "0001");
  assert.equal(resolveAt(L, "mark-0003").checkpoint.name, "mark-0003");
  assert.equal(resolveAt(L, "1").checkpoint.name, "0001", "bare 1 pads to the manual 0001");
  assert.equal(resolveAt(L, "0001").checkpoint.name, "0001");
  assert.equal(resolveAt(L, "3").checkpoint.name, "0003", "manual wins over mark for the same number");
  const noManual3 = L.filter(c => c.name !== "0003");
  assert.equal(resolveAt(noManual3, "3").checkpoint.name, "mark-0003", "bare 3 falls back to mark-0003");
  assert.equal(resolveAt(noManual3, "0003").checkpoint.name, "mark-0003");
  for (const form of ["mark-3", "m3", "mark:0003", "mark3", "M3"]) {
    assert.equal(resolveAt(L, form).checkpoint.name, "mark-0003", form);
  }
  assert.match(resolveAt(L, "m9").error, /no checkpoint for mark 0009/);
});

test("resolveAt: f<frame> gives { frame, base, exact? }; base prefers exit", () => {
  const r = resolveAt(L, "f450");
  assert.equal(r.frame, 450);
  assert.equal(r.base.name, "exit");
  assert.equal(r.exact.name, "mark-0003");

  const between = resolveAt(L, "f400");
  assert.equal(between.frame, 400);
  assert.equal(between.base.name, "exit");
  assert.ok(!("exact" in between));

  assert.equal(resolveAt(L, "frame:450").frame, 450);
  assert.equal(resolveAt(L, "F450").frame, 450);
  assert.equal(resolveAt(L, "f0").frame, 0);

  // no exit: the last usable checkpoint (list order) is the base
  const noExit = L.filter(c => c.name !== "exit");
  assert.equal(resolveAt(noExit, "f400").base.name, "mark-0004");

  // non-restorable states are not usable as a base
  const mixed = [
    { name: "0001", kind: "manual", frame: 300, t: 1, restorable: true },
    { name: "exit", kind: "exit", frame: 900, t: 2, restorable: false },
  ];
  assert.equal(resolveAt(mixed, "f200").base.name, "0001");

  // a short bare number that names no state is an error (a typo must not land at a tiny frame);
  // 5+ digits is a frame, f<n> always is
  assert.match(resolveAt(L, "350").error, /no state or mark named "350"; write f350 for a frame/);
  assert.match(resolveAt(L, "0009").error, /no state or mark named "0009"/);
  const bare = resolveAt(L, "f350");
  assert.equal(bare.frame, 350);
  assert.equal(bare.base.name, "exit");
  assert.equal(resolveAt([{ name: "exit", kind: "exit", frame: 20000, t: 9, restorable: true }], "12345").frame, 12345);
});

test("resolveAt: a frame beyond every checkpoint, and garbage, are errors", () => {
  const beyond = resolveAt(L, "f901");
  assert.match(beyond.error, /no restorable state at or after frame 901/);
  assert.match(beyond.error, /exit \(frame 900\)/);
  const none = resolveAt([{ name: "exit", kind: "exit", frame: 900, t: 1, restorable: false }], "f10");
  assert.match(none.error, /no restorable state/);
  assert.match(none.error, /not restorable/);
  const g = resolveAt(L, "banana");
  assert.match(g.error, /cannot resolve --at "banana"/);
  assert.match(resolveAt(L, "f-3").error, /cannot resolve/);
});

async function sessionAt(base, id, { checkpoints = false } = {}) {
  const dir = join(base, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.jsonl"), JSON.stringify({ kind: "session", t: 0, v: 1, id }) + "\n");
  await writeFile(join(dir, "env.json"), JSON.stringify({ game: { slug: "g" } }));
  if (checkpoints) await writeCheckpoint(dir, makeCheckpoint({ name: "exit", kind: "exit", frame: 10, t: 1, restorable: true, state: {} }));
  return dir;
}

test("findResumeSource: last / true pick the newest session that has checkpoints", async () => {
  const base = await tmp();
  const oldWith = await sessionAt(base, "2026-10-16T09-00-00", { checkpoints: true });
  const midWith = await sessionAt(base, "2026-10-17T09-00-00", { checkpoints: true });
  const newestWithout = await sessionAt(base, "2026-10-18T09-00-00");
  assert.ok(newestWithout && oldWith);
  assert.deepEqual(await findResumeSource(base, "last"), { dir: midWith });
  assert.deepEqual(await findResumeSource(base, true), { dir: midWith });
  assert.deepEqual(await findResumeSource(base, undefined), { dir: midWith });

  const empty = await tmp();
  await sessionAt(empty, "2026-10-18T09-00-00");
  assert.match((await findResumeSource(empty, "last")).error, /no session with saved states/);
  assert.match((await findResumeSource(join(empty, "missing"), "last")).error, /no session with saved states/);
});

test("findResumeSource: an explicit path, and a folder without env.json", async () => {
  const base = await tmp();
  const dir = await sessionAt(base, "2026-10-17T09-00-00");
  const r = await findResumeSource(base, dir);
  assert.equal(samePath(r.dir, dir), true);
  const bare = join(base, "not-a-session");
  await mkdir(bare);
  const e = await findResumeSource(base, bare);
  assert.match(e.error, /not a session folder \(no env\.json\)/);
  assert.match((await findResumeSource(base, join(base, "nope"))).error, /not a session folder/);
});

test("samePath: slashes, trailing slash, case on Windows", () => {
  assert.equal(samePath("C:/Coding/game", "C:\\Coding\\game"), true);
  assert.equal(samePath("C:/Coding/game/", "C:/Coding/game"), true);
  assert.equal(samePath("C:/Coding/game", "C:/Coding/other"), false);
  assert.equal(samePath(null, "C:/x"), false);
  assert.equal(samePath("C:/x", undefined), false);
  if (process.platform === "win32") assert.equal(samePath("C:/Coding/Game", "c:/coding/game"), true);
});

const TAPE = [
  { f: 0, m: 0 }, { f: 100, m: 2 }, { t: 50, k: "KeyD", d: 1 },
  { f: 200, ev: "reload", t: 5000 },
  { f: 0, m: 0 }, { f: 40, ev: "seed", s: 7 }, { f: 60, m: 4 },
  { f: 90, ev: "reload", t: 9000 },
  { f: 0, m: 1 },
];

test("rawSegments: split at reload markers, wall lines dropped, seed kept", () => {
  const segs = rawSegments(TAPE);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].marker, null);
  assert.deepEqual(segs[0].lines, [{ f: 0, m: 0 }, { f: 100, m: 2 }]);
  assert.equal(segs[1].marker.t, 5000);
  assert.deepEqual(segs[1].lines.map(l => l.ev ?? "frame"), ["frame", "seed", "frame"]);
  assert.deepEqual(segs[2].lines, [{ f: 0, m: 1 }]);
});

test("pickSegment: by reloadT, by index, fallback by t", () => {
  assert.equal(pickSegment(TAPE, { index: 99, reloadT: 5000 }).index, 1, "reloadT wins over a wrong index");
  assert.equal(pickSegment(TAPE, { index: 0, reloadT: 9000 }).index, 2);
  assert.equal(pickSegment(TAPE, { index: 0, reloadT: null }).index, 0);
  assert.equal(pickSegment(TAPE, { index: 0, reloadT: null }).marker, null);
  assert.equal(pickSegment(TAPE, { index: 1 }).index, 1, "index only");
  assert.equal(pickSegment(TAPE, { index: 2, reloadT: 1234 }).index, 2, "unknown reloadT falls back to the index");
  assert.equal(pickSegment(TAPE, {}, 6000).index, 1, "fallback by t");
  assert.equal(pickSegment(TAPE, undefined, 100).index, 0);
  assert.equal(pickSegment(TAPE, { index: 50 }, 9500).index, 2, "index out of range falls back to t");
  const seg = pickSegment(TAPE, { index: 1, reloadT: 5000 });
  assert.equal(seg.marker.t, 5000);
  assert.equal(seg.lines.length, 3);
});

test("segmentOf: the segment of a checkpoint time", () => {
  assert.deepEqual(segmentOf(TAPE, 100), { index: 0, reloadT: null });
  assert.deepEqual(segmentOf(TAPE, 5000), { index: 1, reloadT: 5000 });
  assert.deepEqual(segmentOf(TAPE, 7000), { index: 1, reloadT: 5000 });
  assert.deepEqual(segmentOf(TAPE, 99999), { index: 2, reloadT: 9000 });
  assert.deepEqual(segmentOf([], 5), { index: 0, reloadT: null }, "empty tape");
  assert.deepEqual(segmentOf([{ f: 3, ev: "reload" }, { f: 0, m: 1 }], 5), { index: 1, reloadT: null }, "unstamped marker: last segment, no reloadT");
});

test("resumeTapeLines: copies frame/seed/resume lines up to the frame, appends the marker", () => {
  const seg = [
    { f: 0, m: 0 }, { f: 5, ev: "seed", s: 1 }, { f: 10, m: 2 }, { t: 33, k: "KeyD", d: 1 },
    { f: 20, ev: "resume", from: "old/exit", t: 1 }, { f: 25, m: 4 }, { f: 30, m: 0 }, { f: 40, m: 6 },
  ];
  const r = resumeTapeLines(seg, 25, { from: "src/exit", t: 777 });
  assert.deepEqual(r.lines, [
    { f: 0, m: 0 }, { f: 5, ev: "seed", s: 1 }, { f: 10, m: 2 }, { f: 20, ev: "resume", from: "old/exit", t: 1 }, { f: 25, m: 4 },
    { f: 25, ev: "resume", from: "src/exit", t: 777 },
  ]);
  assert.deepEqual(r.frames, [{ f: 0, m: 0 }, { f: 10, m: 2 }, { f: 25, m: 4 }]);

  const noT = resumeTapeLines(seg, 8, { from: "src/0001" });
  assert.deepEqual(noT.lines[noT.lines.length - 1], { f: 8, ev: "resume", from: "src/0001" });
  assert.equal(noT.frames.length, 1);

  const none = resumeTapeLines([], 5, { from: "a/b", t: 1 });
  assert.deepEqual(none.lines, [{ f: 5, ev: "resume", from: "a/b", t: 1 }]);
  assert.deepEqual(none.frames, []);
});

test("sessionIdOf: the folder name", () => {
  assert.equal(sessionIdOf("C:/x/y/2026-10-18T14-02-11"), "2026-10-18T14-02-11");
  assert.equal(sessionIdOf("C:/x/y/2026-10-18T14-02-11/"), "2026-10-18T14-02-11");
});

async function renderWith({ env = {}, lines = [] } = {}) {
  const dir = await tmp();
  await buildSessionA(dir, { garbage: false });
  const envPath = join(dir, "env.json");
  await writeFile(envPath, JSON.stringify({ ...JSON.parse(await readFile(envPath, "utf8")), ...env }, null, 2));
  if (lines.length) await appendFile(join(dir, "session.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return renderSessionMd(await readSession(dir)).split("\n");
}

test("renderSessionMd: no checkpoints, no resume → neither line", async () => {
  const md = await renderWith();
  assert.ok(!md.join("\n").includes("states "));
  assert.ok(!md.join("\n").includes("resumed from"));
});

test("renderSessionMd: checkpoint lines add `states N (exit @ frame F)` to line 3", async () => {
  const md = await renderWith({
    lines: [
      { kind: "checkpoint", t: 10000, frame: 300, name: "0001", trigger: "save", restorable: true },
      { kind: "checkpoint", t: 20000, frame: 600, name: "mark-0003", trigger: "mark", markId: "0003", restorable: true },
      { kind: "checkpoint", t: 30000, frame: 900, name: "exit", trigger: "exit", restorable: true },
    ],
  });
  assert.match(md[2], / · states 3 \(exit @ frame 900\)$/);
  const noExit = await renderWith({ lines: [{ kind: "checkpoint", t: 10000, frame: 300, name: "0001", trigger: "save", restorable: true }] });
  assert.match(noExit[2], / · states 1$/);
});

test("renderSessionMd: the resumed-from line for matched / DIFFERS / not compared / restoring", async () => {
  const from = { session: "2026-10-17T09-00-00", checkpoint: "exit", frame: 900, dir: "C:/x" };
  const base = "resumed from 2026-10-17T09-00-00/exit @ frame 900";
  const line = md => md.find(l => l.startsWith("resumed from"));

  assert.equal(line(await renderWith({ env: { resumedFrom: from, resumeMatched: true } })), `${base} (matched)`);
  assert.equal(line(await renderWith({ env: { resumedFrom: from, resumeMatched: false, firstDiff: "$.player.x" } })), `${base} (DIFFERS) · first diff $.player.x`);
  assert.equal(line(await renderWith({ env: { resumedFrom: from, resumeMatched: null } })), `${base} (not compared)`);
  assert.equal(line(await renderWith({ env: { resumedFrom: from } })), `${base} (restoring…)`);
  assert.equal(
    line(await renderWith({ env: { resumedFrom: from, resumeMatched: false, firstDiff: "$.a", resumeError: "boom\nbang" } })),
    `${base} (DIFFERS) · first diff $.a · restore failed: boom bang`,
  );
  // the resumed line comes after the status line
  const md = await renderWith({ env: { resumedFrom: from, resumeMatched: true } });
  assert.equal(md.findIndex(l => l.startsWith("resumed from")), 3);
});

test("resumedLine: pure", () => {
  assert.equal(resumedLine(null), null);
  assert.equal(resumedLine({ session: "s", checkpoint: "f300" }, { resumeMatched: true }), "resumed from s/f300 @ frame ? (matched)");
});

// ---- implicit mark checkpoints: sessions recorded before v1.1 have marks but no checkpoints/ folder
async function oldSession({ withTape = true } = {}) {
  const dir = await tmp();
  const jl = a => a.map(l => JSON.stringify(l)).join("\n") + "\n";
  await writeFile(join(dir, "env.json"), JSON.stringify({ game: { query: "?lvl=2" } }));
  await writeFile(join(dir, "session.jsonl"), jl([
    { kind: "session", id: "old" },
    { kind: "mark", t: 5000, id: "0001", frame: 100, dir: "marks/0001" },
    { kind: "mark", t: 9000, id: "0002", frame: 250, dir: "marks/0002" },
    { kind: "mark", t: 9500, id: "0003", frame: 260, dir: "marks/0003" },
  ]));
  await writeFile(join(dir, "tape.jsonl"), jl(withTape ? [
    { f: 1, m: 0 }, { f: 40, m: 1 }, { f: 120, m: 0 },
    { ev: "reload", t: 7000 },
    { f: 1, m: 0 }, { f: 30, m: 2 }, { f: 260, m: 0 },
  ] : [{ ev: "reload", t: 7000 }]));
  for (const id of ["0001", "0002"]) {
    await mkdir(join(dir, "marks", id), { recursive: true });
    await writeFile(join(dir, "marks", id, "state.json"), JSON.stringify({ at: id }));
  }
  return dir;
}

test("implicit mark checkpoint: --at mark-0002 on a session without checkpoints/ resolves to the mark's frame and state", async () => {
  const dir = await oldSession();
  const list = await listCheckpointsWithMarks(dir);
  assert.deepEqual(list.map(c => c.name), ["mark-0001", "mark-0002"], "mark 0003 has no state.json so it is not offered");
  const r = resolveAt(list, "mark-0002");
  assert.equal(r.checkpoint.frame, 250);
  const cp = await readCheckpoint(dir, r.checkpoint.name);
  assert.equal(cp.frame, 250);
  assert.equal(cp.t, 9000);
  assert.equal(cp.kind, "mark");
  assert.equal(cp.markId, "0002");
  assert.equal(cp.query, "?lvl=2");
  assert.deepEqual(cp.state, { at: "0002" });
  assert.deepEqual(cp.segment, { index: 1, reloadT: 7000 }, "last reload at or before the mark's t");
  assert.equal(cp.restorable, true);
  assert.deepEqual((await readCheckpoint(dir, "mark-0001")).segment, { index: 0, reloadT: null });
  assert.equal(await (async () => { try { await readFile(join(dir, "checkpoints", "mark-0002.json")); return true; } catch { return false; } })(), false, "nothing is written to the old session");
});

test("implicit mark checkpoint: not restorable without frame lines; a missing mark errors clearly", async () => {
  const dir = await oldSession({ withTape: false });
  assert.equal((await synthesiseMarkCheckpoint(dir, "0001")).restorable, false);
  const dir2 = await oldSession();
  const list = await listCheckpointsWithMarks(dir2);
  const r = resolveAt(list, "mark-0009");
  assert.match(r.error, /no checkpoint for mark 0009/);
  assert.equal(await readCheckpoint(dir2, "mark-0009"), null);
  assert.equal(await readCheckpoint(dir2, "mark-0003"), null, "no state.json, no checkpoint");
});

test("implicit mark checkpoint: an existing checkpoints/mark-NNNN.json takes precedence", async () => {
  const dir = await oldSession();
  await writeCheckpoint(dir, makeCheckpoint({ name: "mark-0002", kind: "mark", frame: 251, t: 9000, markId: "0002", restorable: true, state: { at: "file" } }));
  const list = await listCheckpointsWithMarks(dir);
  assert.equal(list.filter(c => c.name === "mark-0002").length, 1);
  assert.equal(resolveAt(list, "mark-0002").checkpoint.frame, 251);
  assert.deepEqual((await readCheckpoint(dir, "mark-0002")).state, { at: "file" });
});
