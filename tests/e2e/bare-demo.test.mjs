// v1.3 Part 2 e2e: overhead telemetry on a ring session, and a --bare session (no before/, host.bare, SESSION.md marker,
// replay still matches, --resume still works because checkpoints come from the tape).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEMO = join(REPO, "examples", "demo");
const CLI = join(REPO, "bin", "snapper.mjs");
const snapper = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO, timeout: 240000 });
const lastJson = r => JSON.parse(r.stdout.trim().split("\n").pop());
const json = async p => JSON.parse(await readFile(p, "utf8"));

let work, ring, bare;

before(async () => {
  work = await mkdtemp(join(tmpdir(), "snapper-bare-e2e-"));
  const a = snapper("play", DEMO, "--smoke", join(DEMO, "smoke.json"), "--out", join(work, "ring"));
  assert.equal(a.status, 0, a.stderr);
  ring = lastJson(a).session;
  const b = snapper("play", DEMO, "--bare", "--smoke", join(DEMO, "smoke.json"), "--out", join(work, "bare"));
  assert.equal(b.status, 0, b.stderr);
  bare = lastJson(b).session;
});

after(async () => { if (work && !process.env.SNAPPER_KEEP) await rm(work, { recursive: true, force: true }); });

const markDirs = async dir => (await readdir(join(dir, "marks"))).sort();

test("ring session: env host.bare false, perf.json host keys, cumulative markCaptureMs, Host overhead line", async () => {
  assert.equal((await json(join(ring, "env.json"))).host.bare, false);
  const ids = await markDirs(ring);
  assert.ok(ids.length >= 5);
  let prev = 0;
  for (const id of ids) {
    const perf = await json(join(ring, "marks", id, "perf.json"));
    const h = perf.host;
    assert.ok(h, `${id}: perf.json host`);
    assert.equal(h.bare, false);
    assert.ok(Number.isInteger(h.ringFrames) && h.ringFrames >= 0, `ringFrames ${h.ringFrames}`);
    assert.equal(typeof h.ringFps, "number");
    const keys = Object.keys(h.markCaptureMs);
    assert.ok(keys.length >= prev + 1 || keys.length === Number(id), `${id}: markCaptureMs cumulative (${keys})`);
    assert.ok(keys.includes(id));
    assert.ok(Object.values(h.markCaptureMs).every(v => typeof v === "number" && v > 0 && v < 5000));
    prev = keys.length;
    assert.ok(existsSync(join(ring, "marks", id, "before", "sheet.png")), `${id}: before/sheet.png in a ring session`);
  }
  const last = await json(join(ring, "marks", ids[ids.length - 1], "perf.json"));
  assert.equal(Object.keys(last.host.markCaptureMs).length, ids.length);
  // a mark with a warm ring holds frames
  assert.ok(Math.max(...await Promise.all(ids.map(async id => (await json(join(ring, "marks", id, "perf.json"))).host.ringFrames))) >= 10);
  const md = await readFile(join(ring, "SESSION.md"), "utf8");
  const line = md.split("\n").find(l => l.startsWith("Host overhead:"));
  assert.match(line, /^Host overhead: ring [\d.]+ fps \(\d+ frames held\) · mark capture \d+ ms avg, \d+ ms max over \d+ marks$/);
  assert.doesNotMatch(md.split("\n")[1], /\bbare\b/);
});

test("--bare session: host.bare, no before/, perf host, SESSION.md, files kept, replay matches", async () => {
  const env = await json(join(bare, "env.json"));
  assert.equal(env.host.bare, true);
  assert.equal(env.config.bare, true);
  const ids = await markDirs(bare);
  assert.ok(ids.length >= 5);
  for (const id of ids) {
    const dir = join(bare, "marks", id);
    assert.equal(existsSync(join(dir, "before")), false, `${id}: no before/ folder`);
    for (const f of ["shot.png", "state.json", "inputs.json", "log.json", "perf.json"]) assert.ok(existsSync(join(dir, f)), `${id}/${f}`);
    const h = (await json(join(dir, "perf.json"))).host;
    assert.equal(h.bare, true);
    assert.equal(h.ringFrames, 0);
    assert.equal(h.ringFps, 0);
    assert.ok(Object.keys(h.markCaptureMs).includes(id));
  }
  assert.ok(existsSync(join(bare, "marks", ids[0], "frame.png")), "the demo's frame.png is kept");
  assert.ok(existsSync(join(bare, "checkpoints", "exit.json")), "the exit checkpoint is kept");
  const md = await readFile(join(bare, "SESSION.md"), "utf8");
  assert.match(md.split("\n")[1], / · bare( · |$)/);
  assert.match(md, /^Host overhead: bare \(no ring buffer\) · mark capture \d+ ms avg, \d+ ms max over \d+ marks$/m);
  assert.doesNotMatch(md, /before\/sheet\.png/);
  // the perf-derived auto marks still work: intervals are recorded
  const perf = await json(join(bare, "marks", ids[0], "perf.json"));
  assert.ok(perf.intervalsMs.length > 20, `intervals ${perf.intervalsMs.length}`);

  const r = snapper("replay", bare, ids[0], "--before", "5", "--after", "5");
  assert.equal(r.status, 0, r.stderr);
  const rj = await json(join(bare, "marks", ids[0], "replay", "replay.json"));
  assert.equal(rj.stateMatches, true, JSON.stringify(rj.firstDiff));
});

test("--bare does not break --resume: the restore comes from the tape and matches", async () => {
  const smoke = join(work, "resume-smoke.json");
  await writeFile(smoke, JSON.stringify([{ wait: 2500 }, { wait: 600 }, { end: true }]));
  const r = snapper("play", DEMO, "--bare", "--resume", bare, "--at", "exit", "--smoke", smoke, "--out", join(work, "resumed"));
  assert.equal(r.status, 0, r.stderr);
  const dir = lastJson(r).session;
  const env = await json(join(dir, "env.json"));
  assert.equal(env.host.bare, true);
  assert.equal(env.resumeMatched, true, JSON.stringify({ m: env.resumeMatched, d: env.firstDiff, e: env.resumeError }));
});
