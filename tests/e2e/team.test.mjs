// v1.4 team e2e: a real demo session -> SESSION.html in a plain Electron window (images load, offline), triage shows in
// `check`, and a tester-style zip imports into a fresh root and replays (import.json root).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip } from "../../packages/core/index.mjs";
import { importSession } from "../../packages/host/tools/import.mjs";
import { shotPage } from "../fixtures/shot-page.mjs";
import { REPO, CLI, zipSession } from "../fixtures/team.mjs";

const DEMO = join(REPO, "examples", "demo");
const snapper = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO, timeout: 240000 });
let work, session;

before(async () => {
  work = await mkdtemp(join(tmpdir(), "snapper-team-e2e-"));
  const r = snapper("play", DEMO, "--smoke", join(DEMO, "smoke.json"), "--out", join(work, "out"));
  assert.equal(r.status, 0, r.stderr);
  session = JSON.parse(r.stdout.trim().split("\n").pop()).session;
});
after(async () => { if (work && !process.env.SNAPPER_KEEP) await rm(work, { recursive: true, force: true }); });

test("SESSION.html opens offline in Electron and its images load", async () => {
  assert.equal(snapper("summary", session).status, 0);
  const shot = await shotPage(join(session, "SESSION.html"), join(work, "report.png"));
  assert.ok(shot.ok, shot.error);
  assert.deepEqual(shot.blocked, []);
  const img = shot.page.images.find(i => i.src === "marks/0001/shot.png");
  assert.ok(img && img.complete && img.naturalWidth > 0);
  assert.equal(shot.page.scripts, 0);
});

test("triage fixed shows as status in check --json", async () => {
  assert.equal(snapper("triage", session, "1", "fixed", "--by", "e2e", "--commit", "abcdef1").status, 0);
  const r = snapper("check", DEMO, "--session", session, "--marks", "0001", "--out", join(work, "chk"), "--json");
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(res.rows[0].status, "fixed");
  assert.equal(res.rows[0].result, "match");
});

test("a tester-style zip imports into a fresh copy of the demo and replays there", async () => {
  const copy = join(work, "demo-copy");
  await cp(DEMO, copy, { recursive: true });
  const patched = join(work, "patched");
  await cp(session, patched, { recursive: true });
  const env = JSON.parse(await readFile(join(patched, "env.json"), "utf8"));
  env.tester = { name: "Ann" };
  env.game.root = join(work, "gone-on-this-machine");
  await writeFile(join(patched, "env.json"), JSON.stringify(env, null, 2));
  const zip = await zipSession(patched, join(work, "outbox.zip"));
  assert.ok((await readZip(zip)).length > 5);
  const r = await importSession(zip, { root: copy });
  assert.equal(r.tester, "Ann");
  const rp = snapper("replay", r.dir, "0001", "--out", join(work, "replay"));
  assert.equal(rp.status, 0, rp.stderr);
  const doc = JSON.parse(await readFile(join(work, "replay", "replay.json"), "utf8").catch(() => "null") || "null")
    ?? JSON.parse(await readFile(join(r.dir, "marks", "0001", "replay", "replay.json"), "utf8"));
  assert.equal(doc.stateMatches, true);
});
