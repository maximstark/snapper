// G1 core: writer (append-only, atomic SESSION.md), reader tolerance, renderer against the fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionWriter, readSession, renderSessionMd, writeSummary, SessionWriter,
  sessionIdFor, isoLocal, fmtT, fmtDuration, markId, stateLine, parseJsonl,
} from "../../packages/core/index.mjs";
import { buildSessionA } from "../fixtures/session-a.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "snapper-core-"));

test("time helpers", () => {
  assert.equal(sessionIdFor(new Date(2026, 9, 18, 14, 2, 11)), "2026-10-18T14-02-11");
  assert.match(isoLocal(new Date(2026, 9, 18, 14, 2, 11)), /^2026-10-18T14:02:11[+-]\d{2}:\d{2}$/);
  assert.equal(fmtT(42300), "0:42.3");
  assert.equal(fmtT(70000), "1:10.0");
  assert.equal(fmtT(5), "0:00.0");
  assert.equal(fmtDuration(724000), "12 m 04 s");
  assert.equal(fmtDuration(3600000 + 125000), "1 h 02 m 05 s");
  assert.equal(markId(3), "0003");
});

test("writer: folder layout, session id, append-only lines, tape, env patch", async () => {
  const out = await tmp();
  let clock = 1000;
  const w = await createSessionWriter({ out, slug: "demo", startedAt: new Date(2026, 9, 18, 14, 2, 11), now: () => clock });
  assert.ok(w instanceof SessionWriter);
  assert.equal(w.id, "2026-10-18T14-02-11");
  assert.equal(w.dir, join(out, "demo", "2026-10-18T14-02-11"));
  assert.deepEqual(await readdir(w.dir), ["marks"]);

  clock = 1012.345;
  const l1 = w.line("session", { v: 1, id: w.id });
  assert.equal(l1.t, 12.3);
  w.line("boot", { ok: true, ms: 10 }, 5);
  await w.flush();
  const before = await readFile(w.sessionPath, "utf8");
  w.line("ready", { sdk: false, state: false, frame: false, stepper: false, commands: [] });
  await w.flush();
  const after = await readFile(w.sessionPath, "utf8");
  assert.ok(after.startsWith(before), "earlier bytes are never rewritten");
  assert.equal(parseJsonl(after).lines.length, 3);
  assert.deepEqual(parseJsonl(after).lines.map(l => l.kind), ["session", "boot", "ready"]);
  assert.equal(parseJsonl(after).lines[1].t, 5);

  w.tape({ kind: "tape", v: 1, keymap: [], pauseParam: "" });
  w.tapeMany([{ f: 0, m: 0 }, { f: 10, m: 1 }]);
  await w.flush();
  assert.equal((await readFile(w.tapePath, "utf8")).trim().split("\n").length, 3);

  await w.writeEnv({ format: 1, game: { slug: "demo", git: null }, sdk: { present: false } });
  await w.patchEnv({ sdk: { present: true, state: true }, gamepads: [] });
  const env = JSON.parse(await readFile(w.envPath, "utf8"));
  assert.deepEqual(env.sdk, { present: true, state: true });
  assert.equal(env.game.slug, "demo");
  assert.deepEqual(env.gamepads, []);

  assert.equal(w.nextMarkId(), "0001");
  assert.equal(w.nextMarkId(), "0002");
  await w.makeMarkDir("0001");
  await w.writeMarkFile("0001", "state.json", { a: 1 });
  await w.writeMarkFile("0001", "before/index.json", []);
  await w.writeMarkFile("0001", "note.txt", "hello\n");
  assert.deepEqual(JSON.parse(await readFile(w.markPath("0001", "state.json"), "utf8")), { a: 1 });
  assert.equal(await readFile(w.markPath("0001", "note.txt"), "utf8"), "hello\n");

  // the class exposes no method that rewrites session.jsonl or tape.jsonl
  const names = Object.getOwnPropertyNames(SessionWriter.prototype);
  assert.ok(!names.some(n => /rewrite|truncate|replace|edit/i.test(n)), names.join(","));

  // same second: a second session gets a suffix and never overwrites the first
  const w2 = await createSessionWriter({ out, slug: "demo", startedAt: new Date(2026, 9, 18, 14, 2, 11) });
  assert.equal(w2.id, "2026-10-18T14-02-11-2");
  await rm(out, { recursive: true, force: true });
});

test("writer: SESSION.md rendered atomically from disk, no temp files left", async () => {
  const out = await tmp();
  const w = await createSessionWriter({ out, slug: "demo" });
  w.line("session", { v: 1, id: w.id, game: "demo" });
  await w.renderSummary();
  await w.flush();
  const md = await readFile(w.summaryPath, "utf8");
  assert.match(md, /^# Snapper session /);
  assert.match(md, /Boot pending · SDK: pending/);
  assert.ok(!(await readdir(w.dir)).some(f => f.endsWith(".tmp")));
  await rm(out, { recursive: true, force: true });
});

test("reader: tolerates garbage, half-written lines, unknown kinds and a live session", async () => {
  const dir = await buildSessionA(await tmp(), { garbage: true });
  const s = await readSession(dir);
  assert.equal(s.bad, 2, "the garbage line and the half-written last line are skipped");
  assert.equal(s.id, "2026-10-18T14-02-11");
  assert.equal(s.marks.length, 2);
  assert.equal(s.marks[0].note, "swan clips through the sluice");
  assert.equal(s.marks[0].info.before.count, 48);
  assert.equal(s.errors.length, 2);
  assert.ok(s.lines.some(l => l.kind === "mystery-kind-from-the-future"));

  // a session with nothing but a header still reads
  const empty = await tmp();
  await writeFile(join(empty, "session.jsonl"), '{"kind":"session","t":0,"v":1,"id":"x"}\n{"kind":"bo');
  const e = await readSession(empty);
  assert.equal(e.marks.length, 0);
  assert.equal(e.env, null);
  assert.match(renderSessionMd(e), /Boot pending · SDK: pending · 0 m 00 s \(live\) · errors 0 · marks 0/);

  // a folder with no files at all
  const none = await readSession(await tmp());
  assert.equal(none.lines.length, 0);
});

test("renderer: fixture session matches the SESSION_FORMAT.md template", async () => {
  const dir = await buildSessionA(await tmp(), { garbage: true });
  const s = await readSession(dir);
  const expected = (await readFile(new URL("../fixtures/session-a.SESSION.md", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const got = renderSessionMd(s).split(dir).join("<DIR>");
  assert.equal(got, expected);
  // writeSummary writes the same file
  await writeSummary(dir);
  assert.equal((await readFile(join(dir, "SESSION.md"), "utf8")).split(dir).join("<DIR>"), expected);
});

test("renderer: live session, no SDK, boot failure, replay done", async () => {
  const dir = await buildSessionA(await tmp(), { garbage: false });
  const s = await readSession(dir);
  s.end = null;
  s.ready = { sdk: false, state: false, frame: false, stepper: false, commands: [] };
  s.boot = { ok: false, error: "net::ERR_CONNECTION_REFUSED" };
  s.env.game.git = null;
  s.marks[0].info.replay = { stateMatches: false, firstDiff: "$.player.x" };
  const md = renderSessionMd(s);
  assert.match(md, /@ no git sha \(code unknown\)/);
  assert.match(md, /Boot FAILED: net::ERR_CONNECTION_REFUSED · SDK: absent \(not replayable\) · 12 m 04 s \(live\) · errors 2/);
  assert.ok(!md.includes("(* = working tree dirty"));
  assert.match(md, /Replay: done · stateMatches false \(first diff \$\.player\.x\) · replay\/replay\.md/);
  assert.match(md, /Replay: not replayable \(no stepper\)/);
});

test("renderer: state line rules", () => {
  assert.equal(stateLine({ unavailable: true }), "unavailable (no state provider)");
  assert.equal(stateLine({ error: "x is not defined" }), "error: x is not defined");
  assert.equal(stateLine({ a: 1.23456, b: "s", c: { deep: { x: 1 } }, d: [1, 2], e: null, perf: { fps: 1 } }), "a=1.23 b=s d=(1,2) e=null");
  const long = stateLine(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, i])));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});

test("writer + appendFile: a tailer sees complete lines in order", async () => {
  const out = await tmp();
  const w = await createSessionWriter({ out, slug: "t" });
  for (let i = 0; i < 200; i++) w.line("event", { frame: i, name: `e${i}` });
  await w.flush();
  const { lines, bad } = parseJsonl(await readFile(w.sessionPath, "utf8"));
  assert.equal(bad, 0);
  assert.deepEqual(lines.map(l => l.frame), Array.from({ length: 200 }, (_, i) => i));
  await appendFile(w.sessionPath, "");
  await rm(out, { recursive: true, force: true });
});
