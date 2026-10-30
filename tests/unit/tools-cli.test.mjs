// W3 tools: summary, list, skill install, doctor, replay refusals (no browser needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionA } from "../fixtures/session-a.mjs";
import { firstDiff } from "../../packages/host/replay/runner.mjs";
import { makeCheckpoint, writeCheckpoint } from "../../packages/core/index.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO, "bin", "snapper.mjs");
const tmp = () => mkdtemp(join(tmpdir(), "snapper-tools-"));
const snapper = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO });

async function gameWithSession(opts) {
  const root = await tmp();
  const dir = join(root, ".snapper", "sessions", "moonflexforceabilities-v3", "2026-10-18T14-02-11");
  await mkdir(dir, { recursive: true });
  await buildSessionA(dir, opts);
  return { root, dir };
}

test("summary: regenerates SESSION.md and prints its path", async () => {
  const { dir } = await gameWithSession();
  const r = snapper("summary", dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), [join(dir, "SESSION.md"), join(dir, "SESSION.html")]);
  assert.ok(existsSync(join(dir, "SESSION.html")), "v1.4: SESSION.html next to SESSION.md");
  const md = await readFile(join(dir, "SESSION.md"), "utf8");
  assert.match(md, /^# Snapper session 2026-10-18T14-02-11/);
  assert.match(md, /swan clips through the sluice/);
  assert.equal(snapper("summary", join(dir, "nope")).status, 2);
  assert.equal(snapper("summary").status, 2);
});

test("list: newest first, one line each, --json", async () => {
  const { root, dir } = await gameWithSession();
  const older = join(root, ".snapper", "sessions", "moonflexforceabilities-v3", "2026-10-17T09-00-00");
  await mkdir(older, { recursive: true });
  await buildSessionA(older, { garbage: false });
  // make the older one live: drop its end line
  const lines = (await readFile(join(older, "session.jsonl"), "utf8")).split("\n").filter(l => l && !l.includes('"kind":"end"'));
  await writeFile(join(older, "session.jsonl"), lines.join("\n") + "\n");

  const r = snapper("list", root);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split("\n");
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^2026-10-18T14-02-11 {2}moonflexforceabilities-v3 {2}marks 2 {2}errors 2 {2}12 m 04 s {2}/);
  assert.ok(rows[0].endsWith(dir) && !rows[0].includes("(live)"));
  assert.match(rows[1], /^2026-10-17T09-00-00/);
  assert.match(rows[1], /\(live\)/);

  const j = JSON.parse(snapper("list", root, "--json").stdout);
  assert.equal(j.length, 2);
  assert.equal(j[0].id, "2026-10-18T14-02-11");
  assert.equal(j[0].marks, 2);
  assert.equal(j[1].live, true);

  const empty = await tmp();
  assert.match(snapper("list", empty).stdout, /no sessions/);
  assert.equal(snapper("list", join(empty, "missing")).status, 2);
});

test("list: honours snapper.config.json out", async () => {
  const root = await tmp();
  await writeFile(join(root, "snapper.config.json"), JSON.stringify({ out: "playtests" }));
  const dir = join(root, "playtests", "g", "2026-10-18T10-00-00");
  await mkdir(dir, { recursive: true });
  await buildSessionA(dir);
  const j = JSON.parse(snapper("list", root, "--json").stdout);
  assert.equal(j.length, 1);
  assert.equal(j[0].path, dir);
});

test("skill install: copies the skill, replaces files, refuses a missing root", async () => {
  const root = await tmp();
  const r = snapper("skill", "install", root);
  assert.equal(r.status, 0, r.stderr);
  const dest = join(root, ".claude", "skills", "snapper", "SKILL.md");
  assert.ok(existsSync(dest));
  const src = await readFile(join(REPO, "packages", "skill", "snapper", "SKILL.md"), "utf8");
  assert.equal(await readFile(dest, "utf8"), src);
  assert.match(src, /^---\nname: snapper\ndescription: Triage a Snapper playtest session: read SESSION\.md, inspect marks at full resolution, replay deterministic marks, fix with a repro\.\n---/);
  assert.ok(src.split("\n").length < 150);
  assert.match(r.stdout, /SKILL\.md/);
  await writeFile(dest, "stale");
  assert.equal(snapper("skill", "install", root).status, 0);
  assert.equal(await readFile(dest, "utf8"), src);
  assert.equal(snapper("skill", "install", join(root, "missing")).status, 2);
  assert.equal(snapper("skill", "install").status, 2);
  assert.equal(snapper("skill", "bogus", root).status, 2);
});

test("doctor: one line per check, ok or MISSING with a hint", () => {
  const r = snapper("doctor");
  const lines = r.stdout.trim().split("\n");
  for (const name of ["snapper 1.4.1", "node ", "electron", "packaged", "git", "sdk", "--coi"]) {
    assert.ok(lines.some(l => l.includes(name)), `doctor mentions ${name}: ${r.stdout}`);
  }
  const coi = lines.find(l => l.includes("--coi"));
  assert.match(coi, /^ok {5} {2}coi: .*Godot 4.*SharedArrayBuffer.*off by default.*require-corp/, "doctor says when to use --coi");
  for (const l of lines.slice(0, -1)) {
    assert.match(l, /^(ok {5}|MISSING) {2}/);
    if (l.startsWith("MISSING")) assert.match(l, /-> fix: /);
  }
  assert.equal(r.status, lines.some(l => l.startsWith("MISSING")) ? 1 : 0);
});

test("firstDiff: paths, key order, perf skipped, arrays", () => {
  assert.equal(firstDiff({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), null);
  assert.deepEqual(firstDiff({ player: { x: 1 } }, { player: { x: 2 } }), { path: "$.player.x", recorded: 1, replayed: 2 });
  assert.equal(firstDiff({ v: [1, 2, 3] }, { v: [1, 2, 4] }).path, "$.v[2]");
  assert.equal(firstDiff({ v: [1] }, { v: [1, 2] }).path, "$.v[1]");
  assert.equal(firstDiff({ a: 1, perf: { fps: 60 } }, { a: 1, perf: { fps: 3 } }, ["perf"]), null);
  assert.equal(firstDiff({ a: 1, n: { perf: 1 } }, { a: 1, n: { perf: 2 } }, ["perf"]).path, "$.n.perf");
  assert.equal(firstDiff({ a: 1 }, { a: 1, b: 2 }).path, "$.b");
});

test("replay: refusals exit 2 with a clear message, no browser launched", async () => {
  const { dir } = await gameWithSession({ garbage: false });
  const missing = snapper("replay", dir, "0099");
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /mark "0099" does not exist/);
  assert.match(missing.stderr, /0001, 0002/);

  assert.equal(snapper("replay", dir).status, 2);
  assert.equal(snapper("replay", join(dir, "nope"), "1").status, 2);
  assert.equal(snapper("replay", dir, "1", "--before", "x").status, 2);

  // a mark with no game frame
  await appendFile(join(dir, "session.jsonl"), JSON.stringify({ kind: "mark", t: 80000, id: "0003", frame: -1, trigger: "boot", dir: "marks/0003", summary: "boot", errors: 0, worstMs: 0 }) + "\n");
  const noFrame = snapper("replay", dir, "3");
  assert.equal(noFrame.status, 2);
  assert.match(noFrame.stderr, /carries no game frame/);

  // no frame lines in the tape
  const tapePath = join(dir, "tape.jsonl");
  const tape = await readFile(tapePath, "utf8");
  await writeFile(tapePath, tape.split("\n")[0] + "\n" + JSON.stringify({ t: 5, k: "KeyD", d: 1 }) + "\n");
  const noLines = snapper("replay", dir, "0001");
  assert.equal(noLines.status, 2);
  assert.match(noLines.stderr, /no frame lines/);
  await writeFile(tapePath, tape);

  // no stepper
  const sp = join(dir, "session.jsonl");
  const sess = await readFile(sp, "utf8");
  await writeFile(sp, sess.replace('"stepper":true', '"stepper":false'));
  const noStepper = snapper("replay", dir, "0001");
  assert.equal(noStepper.status, 2);
  assert.match(noStepper.stderr, /no stepper/);
});

test("list: saved states add `states N (exit fN)` to the row and checkpoints/exitFrame to --json", async () => {
  const { root, dir } = await gameWithSession({ garbage: false });
  const other = join(root, ".snapper", "sessions", "moonflexforceabilities-v3", "2026-10-17T09-00-00");
  await mkdir(other, { recursive: true });
  await buildSessionA(other, { garbage: false });
  const cp = (name, kind, frame, t) => writeCheckpoint(dir, makeCheckpoint({ name, kind, frame, t, restorable: true, state: {} }));
  await cp("0001", "manual", 300, 1000);
  await cp("mark-0001", "mark", 450, 2000);
  await cp("exit", "exit", 12345, 3000);
  await writeCheckpoint(other, makeCheckpoint({ name: "0001", kind: "manual", frame: 99, t: 1, restorable: true, state: {} }));

  const rows = snapper("list", root).stdout.trim().split("\n");
  assert.match(rows[0], /^2026-10-18T14-02-11 {2}moonflexforceabilities-v3 {2}marks 2 {2}errors 2 {2}12 m 04 s {2}states 3 \(exit f12345\) {2}/);
  assert.ok(rows[0].endsWith(dir));
  assert.match(rows[1], /^2026-10-17T09-00-00 .* {2}states 1 {2}/, "no exit state: just the count");
  assert.ok(!rows[1].includes("(exit"));

  const j = JSON.parse(snapper("list", root, "--json").stdout);
  assert.equal(j[0].checkpoints, 3);
  assert.equal(j[0].exitFrame, 12345);
  assert.equal(j[1].checkpoints, 1);
  assert.equal(j[1].exitFrame, null);

  // a session without states keeps the old row format and reports zero
  const plain = await gameWithSession({ garbage: false });
  const prow = snapper("list", plain.root).stdout.trim();
  assert.ok(!prow.includes("states"));
  const pj = JSON.parse(snapper("list", plain.root, "--json").stdout);
  assert.deepEqual([pj[0].checkpoints, pj[0].exitFrame], [0, null]);
});
