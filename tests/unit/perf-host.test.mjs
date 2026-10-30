// v1.3 Part 2: overhead telemetry (perf.json `host`), --bare mark folders, the SESSION.md bare marker and overhead line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPerfJson, createSessionWriter, readSession, renderSessionMd, overheadLine,
} from "../../packages/core/index.mjs";
import { ringFpsOf } from "../../packages/host/main/marks.mjs";

test("buildPerfJson: host block is additive and only present when given", () => {
  const plain = buildPerfJson({ intervals: [16.7, 16.8], expectedMs: 16.7, displayHz: 60 });
  assert.equal("host" in plain, false);
  const host = { bare: false, ringFrames: 52, ringFps: 10.2, markCaptureMs: { "0001": 61.4 } };
  const withHost = buildPerfJson({ intervals: [16.7], expectedMs: 16.7, host });
  assert.deepEqual(withHost.host, host);
  assert.deepEqual(Object.keys(withHost).slice(0, 5), ["expectedMs", "displayHz", "window", "intervalsMs", "p50"]);
});

test("ringFpsOf: captured frames per second over the held window", () => {
  assert.equal(ringFpsOf([]), 0);
  assert.equal(ringFpsOf([{ t: 100 }]), 0);
  assert.equal(ringFpsOf([{ t: 0 }, { t: 100 }, { t: 200 }, { t: 300 }, { t: 400 }, { t: 500 }]), 10);
  assert.equal(ringFpsOf([{ t: 0 }, { t: 98 }, { t: 205 }]), 9.8);
});

test("writer: makeMarkDir creates before/ unless asked not to (--bare)", async () => {
  const out = await mkdtemp(join(tmpdir(), "snapper-bare-"));
  try {
    const w = await createSessionWriter({ out, slug: "demo" });
    await w.makeMarkDir("0001");
    await w.makeMarkDir("0002", { before: false });
    assert.ok(existsSync(w.markPath("0001", "before")));
    assert.equal(existsSync(w.markPath("0002", "before")), false);
    assert.deepEqual(await readdir(w.markPath("0002")), []);
  } finally { await rm(out, { recursive: true, force: true }); }
});

async function sessionWith({ bare, host }) {
  const out = await mkdtemp(join(tmpdir(), "snapper-host-md-"));
  const w = await createSessionWriter({ out, slug: "demo" });
  w.line("session", { v: 1, id: w.id, game: "demo", url: "http://127.0.0.1:1/index.html", query: "", snapper: "1.3.0", startedAt: w.startedAtIso });
  await w.writeEnv({ format: 1, game: { slug: "demo", url: "http://127.0.0.1:1/index.html", query: "" }, host: { adapter: "electron", chromium: "146.0.1.0", bare }, window: { preset: "1080p", w: 1920, h: 1080 }, display: { hz: 60 } });
  w.line("boot", { ok: true, ms: 100 });
  w.line("ready", { sdk: true, state: true, frame: true, stepper: true, commands: [] });
  const ms = {};
  for (const [i, v] of [61.4, 88.2, 40].entries()) {
    const id = String(i + 1).padStart(4, "0");
    ms[id] = v;
    await w.makeMarkDir(id, { before: !bare });
    await w.writeMarkFile(id, "state.json", { frame: 10 * (i + 1) });
    await w.writeMarkFile(id, "perf.json", buildPerfJson({ intervals: [16.7], host: host && { ...host, markCaptureMs: { ...ms } } }));
    w.line("mark", { id, frame: 10 * (i + 1), trigger: "api", dir: `marks/${id}`, summary: "api mark", errors: 0, worstMs: 16.7 }, 1000 * (i + 1));
  }
  w.line("end", { marks: 3, errors: 0, durationMs: 4000 });
  await w.flush();
  return { out, dir: w.dir };
}

test("reader + renderer: perfHost, the bare marker on line 2, one Host overhead line", async () => {
  const bare = await sessionWith({ bare: true, host: { bare: true, ringFrames: 0, ringFps: 0, markCaptureMs: {} } });
  const ring = await sessionWith({ bare: false, host: { bare: false, ringFrames: 52, ringFps: 10.2, markCaptureMs: {} } });
  const old = await sessionWith({ bare: false, host: null });
  try {
    const sb = await readSession(bare.dir);
    assert.equal(sb.marks[0].info.perfHost.bare, true);
    const mdBare = renderSessionMd(sb).split("\n");
    assert.match(mdBare[1], / · bare$| · bare · /, mdBare[1]);
    const lines = mdBare.filter(l => l.startsWith("Host overhead:"));
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "Host overhead: bare (no ring buffer) · mark capture 63 ms avg, 88 ms max over 3 marks");
    assert.equal(overheadLine(sb), lines[0]);

    const mdRing = renderSessionMd(await readSession(ring.dir)).split("\n");
    assert.doesNotMatch(mdRing[1], /\bbare\b/);
    assert.equal(mdRing.filter(l => l.startsWith("Host overhead:"))[0],
      "Host overhead: ring 10.2 fps (52 frames held) · mark capture 63 ms avg, 88 ms max over 3 marks");

    // a session recorded before 1.3 has neither
    const sOld = await readSession(old.dir);
    assert.equal(sOld.marks[0].info.perfHost, null);
    assert.doesNotMatch(renderSessionMd(sOld), /Host overhead/);
  } finally { for (const s of [bare, ring, old]) await rm(s.out, { recursive: true, force: true }); }
});
