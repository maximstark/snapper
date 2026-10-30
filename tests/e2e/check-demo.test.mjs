// v1.3 Part 3 e2e: play the demo smoke into a temp --out, then `snapper check` it (match), check a COPY of the demo with one
// constant changed (differs, firstDiff under $.player), --accept on the copy (expected.json), check again (match), and
// prove examples/demo itself is untouched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, cp, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEMO = join(REPO, "examples", "demo");
const CLI = join(REPO, "bin", "snapper.mjs");
const snapper = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO, timeout: 240000 });

async function treeHash(dir) {
  const h = createHash("sha256");
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) h.update(e.name + ":" + await treeHash(p));
    else h.update(e.name + ":" + await readFile(p));
  }
  return h.digest("hex");
}

let work, out, sessionDir, copy, demoHash;

before(async () => {
  work = await mkdtemp(join(tmpdir(), "snapper-check-e2e-"));
  out = join(work, "out");
  demoHash = await treeHash(DEMO);
  const r = snapper("play", DEMO, "--smoke", join(DEMO, "smoke.json"), "--out", out);
  assert.equal(r.status, 0, r.stderr);
  sessionDir = JSON.parse(r.stdout.trim().split("\n").pop()).session;
  copy = join(work, "demo-copy");
  await cp(DEMO, copy, { recursive: true });
  const game = join(copy, "game.js");
  const src = await readFile(game, "utf8");
  assert.ok(src.includes("SPEED = 2,"), "the demo still has SPEED = 2");
  await writeFile(game, src.replace("SPEED = 2,", "SPEED = 2.5,"));
});

after(async () => { if (work && !process.env.SNAPPER_KEEP) await rm(work, { recursive: true, force: true }); });

test("check: the demo session matches on the unchanged demo", async () => {
  const r = snapper("check", DEMO, "--out", out, "--json");
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(r.stdout.trim().split("\n").length, 1, "--json prints exactly one line on stdout");
  assert.equal(res.summary.match, 5);
  assert.equal(res.summary.differs + res.summary.error + res.summary.skipped, 0, JSON.stringify(res.summary));
  assert.equal(res.summary.exit, 0);
  assert.ok(res.rows.every(x => x.expectation === "state" && x.result === "match"));
  assert.ok(res.checkFile.startsWith(join(out, "checks")));
  const doc = JSON.parse(await readFile(res.checkFile, "utf8"));
  assert.equal(doc.v, 1);
  assert.equal(doc.rows.length, 5);
  assert.equal(doc.summary.match, 5);
  // nothing was written into the session folder
  assert.equal(existsSync(join(sessionDir, "marks", "0001", "expected.json")), false);
});

test("check: table output, --marks, exit 2 on a bad root", async () => {
  const r = snapper("check", DEMO, "--out", out, "--marks", "1,3");
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^session\s+mark\s+trigger\s+note\s+status\s+result$/);
  assert.equal(lines.filter(l => /\bmatch$/.test(l)).length, 2);
  assert.match(lines[lines.length - 2], /^match 2 · differs 0 · skipped 0 · error 0 · \d+\.\d s$/);
  assert.match(lines[lines.length - 1], /^check\.json: .+\.json$/);
  const bad = snapper("check", join(work, "does-not-exist"));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /game root not found/);
});

test("check: a changed copy differs under $.player, --accept makes it match, the original is untouched", async () => {
  const d = snapper("check", copy, "--session", sessionDir, "--out", out, "--json");
  assert.equal(d.status, 1, d.stderr);
  const res = JSON.parse(d.stdout.trim().split("\n").pop());
  assert.ok(res.summary.differs >= 1, JSON.stringify(res.summary));
  const diffs = res.rows.filter(x => x.result === "differs");
  assert.ok(diffs.every(x => x.firstDiff.startsWith("$.player")), JSON.stringify(diffs.map(x => x.firstDiff)));
  assert.ok(diffs.some(x => x.firstDiff === "$.player.x"));
  assert.equal(res.summary.exit, 1);
  assert.equal(existsSync(join(sessionDir, "marks", "0001", "expected.json")), false, "a plain check writes nothing into the session");

  const a = snapper("check", copy, "--session", sessionDir, "--out", out, "--accept", "--json");
  assert.equal(a.status, 0, a.stderr);
  const acc = JSON.parse(a.stdout.trim().split("\n").pop());
  assert.equal(acc.summary.exit, 0);
  assert.equal(acc.summary.accepted, 5);
  assert.ok(acc.rows.every(x => x.accepted === true));
  assert.equal(acc.rows.filter(x => x.result === "differs").length, res.summary.differs, "the rows still report the comparison against the OLD expectation");
  const exp = JSON.parse(await readFile(join(sessionDir, "marks", "0001", "expected.json"), "utf8"));
  assert.equal(exp.host, "1.4.1");
  assert.equal(exp.frame, JSON.parse(await readFile(join(sessionDir, "marks", "0001", "state.json"), "utf8")).frame);
  assert.match(exp.acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok("git" in exp);
  assert.ok(exp.state.player, "the replayed state is recorded");
  // state.json (what the player saw) is untouched; only expected.json was added
  assert.deepEqual((await readdir(join(sessionDir, "marks", "0001"))).filter(f => f.endsWith(".json")).sort(),
    ["expected.json", "inputs.json", "log.json", "perf.json", "state.json"]);

  const again = snapper("check", copy, "--session", sessionDir, "--out", out, "--json");
  assert.equal(again.status, 0, again.stderr);
  const m = JSON.parse(again.stdout.trim().split("\n").pop());
  assert.equal(m.summary.match, 5, JSON.stringify(m.summary));
  assert.ok(m.rows.every(x => x.expectation === "expected"));

  // examples/demo is byte-identical
  assert.equal(await treeHash(DEMO), demoHash);
  assert.equal(existsSync(join(DEMO, ".snapper")), false);
  assert.ok((await stat(join(copy, "game.js"))).size > 0);
});
