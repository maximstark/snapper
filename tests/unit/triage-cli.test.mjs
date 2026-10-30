// v1.4 `snapper triage`: status, --of, --commit, refusals (exit 2), SESSION.md / SESSION.html regenerated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeSession, CLI, REPO } from "../fixtures/team.mjs";

const snapper = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO });
const tmp = () => mkdtemp(join(tmpdir(), "snapper-triage-"));
const json = async p => JSON.parse(await readFile(p, "utf8"));

test("triage fixed: prints the line, writes triage.json, SESSION.md shows the Triage lines and counts, SESSION.html too", async () => {
  const dir = await makeSession(await tmp());
  const r = snapper("triage", dir, "1", "fixed", "--by", "ada", "--commit", "00e9b48", "--note", "z5 check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^0001: fixed by ada \d{4}-\d{2}-\d{2} · commit 00e9b48 · "z5 check"\n$/);
  const doc = await json(join(dir, "marks", "0001", "triage.json"));
  assert.equal(doc.status, "fixed");
  assert.equal(doc.by, "ada");
  assert.equal(doc.commit, "00e9b48");
  assert.equal(doc.note, "z5 check");
  const md = await readFile(join(dir, "SESSION.md"), "utf8");
  assert.match(md, /^Triage: 1 fixed · 1 untriaged$/m, "header counts");
  assert.match(md, /^Triage: fixed by ada .* commit 00e9b48 · "z5 check"$/m, "per-mark line");
  const html = await readFile(join(dir, "SESSION.html"), "utf8");
  assert.match(html, /Triage: fixed by ada/);
  // a second call rewrites (open again), keeps nothing stale
  const r2 = snapper("triage", dir, "0001", "open", "--by", "ada");
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal((await json(join(dir, "marks", "0001", "triage.json"))).status, "open");
});

test("triage: --by defaults to the OS user name", async () => {
  const dir = await makeSession(await tmp());
  assert.equal(snapper("triage", dir, "2", "wontfix").status, 0);
  assert.equal((await json(join(dir, "marks", "0002", "triage.json"))).by, userInfo().username);
});

test("triage duplicate needs --of an existing other mark", async () => {
  const dir = await makeSession(await tmp());
  for (const [args, re] of [
    [["2", "duplicate"], /needs --of/],
    [["2", "duplicate", "--of", "9"], /no such mark/],
    [["2", "duplicate", "--of", "2"], /cannot duplicate itself/],
    [["1", "fixed", "--of", "2"], /only goes with status duplicate/],
    [["9", "fixed"], /mark 0009 does not exist/],
    [["1", "done"], /status must be one of/],
    [["1", "fixed", "--commit", "xyz"], /commit must be a git sha/],
    [["1", "fixed", "--note"], /--note needs a value/],
  ]) {
    const r = snapper("triage", dir, ...args, "--by", "m");
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, re, args.join(" "));
  }
  assert.ok(!existsSync(join(dir, "marks", "0001", "triage.json")), "refusals write nothing");
  assert.ok(!existsSync(join(dir, "marks", "0002", "triage.json")));
  const ok = snapper("triage", dir, "2", "duplicate", "--of", "1", "--by", "m");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /duplicate of 0001 by m/);
  assert.equal((await json(join(dir, "marks", "0002", "triage.json"))).of, "0001");
});

test("triage: usage and missing session exit 2", async () => {
  assert.equal(snapper("triage").status, 2);
  assert.match(snapper("triage", "x", "1").stderr, /usage: snapper triage/);
  const dir = await makeSession(await tmp());
  const r = snapper("triage", join(dir, "nope"), "1", "open");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a session folder|does not exist/);
});
