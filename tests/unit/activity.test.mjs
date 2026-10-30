// v1.4.1 played time (D-030): the accumulator, the duration text, SESSION.md line 3, `snapper list`, and the host's end line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDLE_MS, createActivity, noteActivity, activeTotal, activeMsOf, fmtSessionDuration,
  readSession, readTape, renderSessionMd, createSessionWriter, DEFAULT_CONFIG,
} from "../../packages/core/index.mjs";
import { fakeBackend } from "../../packages/host/main/cdp.mjs";
import { createCapture } from "../../packages/host/main/capture.mjs";
import { listSessions } from "../../packages/host/tools/list.mjs";
import { buildSessionA } from "../fixtures/session-a.mjs";

test("activity: gaps count up to IDLE_MS, the start counts, the tail counts up to IDLE_MS", () => {
  assert.equal(IDLE_MS, 60000);
  const a = createActivity();
  noteActivity(a, 2000);
  noteActivity(a, 5000);
  noteActivity(a, 4000);                       // out of order: ignored
  noteActivity(a, 200000);                     // 195 s gap: counts 60 s
  assert.equal(activeTotal(a, 210000), 2000 + 3000 + 60000 + 10000);
  assert.equal(activeTotal(a, 10_000_000), 2000 + 3000 + 60000 + 60000);
  assert.equal(activeMsOf([], 5000), 5000, "a short session with no input counts whole");
  assert.equal(activeMsOf([], 3_600_000), 60000, "an hour left alone counts one minute");
  // a real session: inputs between 2.8 s and 18.0 s, end at 42,216 s
  assert.equal(activeMsOf([2777.7, 15910.9, 17931, 18018.8], 42216039.3), 78018.8);
});

test("fmtSessionDuration: `played X of Y` only when a minute or more was idle", () => {
  assert.equal(fmtSessionDuration({ durationMs: 724000 }), "12 m 04 s", "no activeMs (before 1.4.1)");
  assert.equal(fmtSessionDuration({ durationMs: 724000, activeMs: 700000 }), "12 m 04 s", "24 s idle");
  assert.equal(fmtSessionDuration({ durationMs: 724000, activeMs: 664000 }), "played 11 m 04 s of 12 m 04 s");
  assert.equal(fmtSessionDuration({ durationMs: 42216039.3, activeMs: 78018.8 }), "played 1 m 18 s of 11 h 43 m 36 s");
});

async function sessionWithEnd(end) {
  const dir = await mkdtemp(join(tmpdir(), "snapper-activity-"));
  await buildSessionA(dir, { garbage: false });
  if (end) await appendFile(join(dir, "session.jsonl"), JSON.stringify(end) + "\n");
  return dir;
}

test("SESSION.md line 3: played time when the end line says a minute or more was idle", async () => {
  const plain = await sessionWithEnd(null);
  const idle = await sessionWithEnd({ kind: "end", t: 724000, marks: 2, errors: 2, durationMs: 724000, activeMs: 100000, idleMs: 60000 });
  const busy = await sessionWithEnd({ kind: "end", t: 724000, marks: 2, errors: 2, durationMs: 724000, activeMs: 723000, idleMs: 60000 });
  try {
    const line3 = async d => renderSessionMd(await readSession(d)).split("\n")[2];
    assert.match(await line3(plain), / · 12 m 04 s · /);
    assert.match(await line3(idle), / · played 1 m 40 s of 12 m 04 s · /);
    assert.match(await line3(busy), / · 12 m 04 s · /);
  } finally {
    for (const d of [plain, idle, busy]) await rm(d, { recursive: true, force: true });
  }
});

test("snapper list rows: activeMs and the played text (what the launcher shows)", async () => {
  const root = await mkdtemp(join(tmpdir(), "snapper-activity-root-"));
  try {
    const dir = join(root, ".snapper", "sessions", "demo", "2026-10-18T14-02-11");
    await mkdir(dir, { recursive: true });
    await buildSessionA(dir, { garbage: false });
    await appendFile(join(dir, "session.jsonl"), JSON.stringify({ kind: "end", t: 724000, marks: 2, errors: 2, durationMs: 724000, activeMs: 100000, idleMs: 60000 }) + "\n");
    const { rows } = await listSessions(root, { out: join(root, ".snapper", "sessions") });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].activeMs, 100000);
    assert.equal(rows[0].duration, "played 1 m 40 s of 12 m 04 s");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("host: wall and pointer activity feed the end line; pointer activity never reaches the tape", async () => {
  const out = await mkdtemp(join(tmpdir(), "snapper-activity-cap-"));
  try {
    const writer = await createSessionWriter({ out, slug: "fake" });
    writer.line("session", { v: 1, id: writer.id, game: "fake", url: "http://x/", query: "", snapper: "1.4.1", startedAt: writer.startedAtIso }, 0);
    await writer.writeEnv({ format: 1, game: { slug: "fake", url: "http://x/", query: "" }, host: { adapter: "cdp", bare: true }, display: { hz: 60 }, window: { w: 10, h: 10 } });
    const cdp = fakeBackend({ handlers: { "Runtime.evaluate": () => ({ result: { type: "number", value: 1 } }) } });
    const capture = createCapture({
      cdp, page: { send: () => true }, writer, config: { ...DEFAULT_CONFIG, bare: true },
      composer: { warm() {}, destroy() {}, compose: async () => ({ frames: [], sheet: null, bad: [] }) },
      displayHz: 60, warn: () => {}, res: null, adapter: "cdp", baseUrl: "http://x/", query: "",
      writeResult: () => {}, hooks: { endSession: () => {} },
    });
    capture.connect();
    const before = capture.host.activity.last;
    await new Promise(r => setTimeout(r, 20));
    capture.onPage("wall", { now: 1000, ev: [{ pt: 1000, k: "KeyD", d: 1 }] });
    const afterWall = capture.host.activity.last;
    assert.ok(afterWall > before, "a wall line is activity");
    await new Promise(r => setTimeout(r, 20));
    capture.onPage("active", { now: 5000, pt: 5000 });
    assert.ok(capture.host.activity.last > afterWall, "a pointer message is activity");
    await capture.finalize();
    const end = writer.lines.at(-1);
    assert.equal(end.kind, "end");
    assert.equal(end.idleMs, 60000);
    assert.equal(typeof end.activeMs, "number");
    assert.ok(end.activeMs <= end.durationMs + 0.1 && end.activeMs > 0, `${end.activeMs} of ${end.durationMs}`);
    const s = await readSession(writer.dir);
    assert.equal(s.end.activeMs, end.activeMs);
    const tape = await readTape(writer.dir);
    assert.ok(tape.lines.some(l => l.k === "KeyD"), "the key is in the tape");
    assert.ok(!tape.lines.some(l => "pt" in l || l.kind === "active"), "pointer activity is not");
  } finally { await rm(out, { recursive: true, force: true }); }
});
