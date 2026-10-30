// v1.4 `snapper import`: validation before writing, destinations, import.json, refusals, CLI exit codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeZip, readSession, sessionGameRoot } from "../../packages/core/index.mjs";
import { importSession } from "../../packages/host/tools/import.mjs";
import { makeSession, zipSession, CLI, REPO } from "../fixtures/team.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "snapper-import-"));
const ID = "2026-10-18T14-02-11";
const snapper = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO });

async function testerZip({ tester = "Ann", slug = "Demo Game" } = {}) {
  const base = await tmp();
  const dir = await makeSession(base, { slug: "demo-game", tester });
  const env = JSON.parse(await readFile(join(dir, "env.json"), "utf8"));
  env.game.slug = slug;
  await writeFile(join(dir, "env.json"), JSON.stringify(env));
  const zip = await zipSession(dir, join(await tmp(), `demo-${ID}.zip`));
  return { zip, dir };
}
const goodEnv = JSON.stringify({ format: 1, game: { slug: "g" } });
const goodSession = JSON.stringify({ kind: "session", v: 1, id: ID, game: "g" }) + "\n";
async function rawZip(entries) { const f = join(await tmp(), "raw.zip"); await writeZip(f, entries); return f; }

test("import --root: lands in <root>/.snapper/sessions/<slug>/<id>, import.json, SESSION.md + SESSION.html, copy line", async () => {
  const { zip } = await testerZip();
  const root = await tmp();
  const r = await importSession(zip, { root });
  assert.equal(r.id, ID);
  assert.equal(r.slug, "demo-game", "slug goes through slugify");
  assert.equal(r.tester, "Ann");
  assert.equal(r.dir, join(root, ".snapper", "sessions", "demo-game", ID));
  assert.equal(r.copyLine, `Read "${join(r.dir, "SESSION.md")}" and triage it with the snapper skill.`);
  const imp = JSON.parse(await readFile(join(r.dir, "import.json"), "utf8"));
  assert.equal(imp.v, 1);
  assert.equal(imp.from, `demo-${ID}.zip`);
  assert.equal(imp.root, root);
  assert.equal(imp.tester, "Ann");
  assert.ok(!Number.isNaN(Date.parse(imp.importedAt)));
  for (const f of ["session.jsonl", "env.json", "tape.jsonl", "SESSION.md", "SESSION.html", "marks/0001/shot.png", "marks/0001/before/sheet.png"]) {
    assert.ok(existsSync(join(r.dir, ...f.split("/"))), f);
  }
  assert.match(await readFile(join(r.dir, "SESSION.md"), "utf8"), /tester: Ann/);
  const s = await readSession(r.dir);
  assert.equal(s.marks.length, 2);
  // the importer's root serves replays of a session recorded elsewhere (env.game.root does not exist here)
  const env = JSON.parse(await readFile(join(r.dir, "env.json"), "utf8"));
  assert.equal(await sessionGameRoot(r.dir, { ...env, game: { ...env.game, root: join(root, "gone") } }), root);
});

test("import --out: <out>/<slug>/<id>, import.json root null", async () => {
  const { zip } = await testerZip({ tester: null });
  const out = await tmp();
  const r = await importSession(zip, { out });
  assert.equal(r.dir, join(out, "demo-game", ID));
  assert.equal(r.tester, null);
  const imp = JSON.parse(await readFile(join(r.dir, "import.json"), "utf8"));
  assert.equal(imp.root, null);
  assert.equal(imp.tester, null);
});

test("import honours the root's snapper.config.json out", async () => {
  const { zip } = await testerZip();
  const root = await tmp();
  await writeFile(join(root, "snapper.config.json"), JSON.stringify({ out: "playtests" }));
  const r = await importSession(zip, { root });
  assert.equal(r.dir, join(root, "playtests", "demo-game", ID));
});

test("import refuses to overwrite an existing id, and leaves it untouched", async () => {
  const { zip } = await testerZip();
  const root = await tmp();
  const r = await importSession(zip, { root });
  await writeFile(join(r.dir, "marker.txt"), "keep");
  await assert.rejects(importSession(zip, { root }), e => e.exitCode === 2 && /already exists/.test(e.message));
  assert.equal(await readFile(join(r.dir, "marker.txt"), "utf8"), "keep");
});

test("import validation: bad first line, wrong kind, v 2, missing env.json, env format 2, no session, two sessions", async () => {
  const root = await tmp();
  const cases = [
    ["not json", [{ name: `${ID}/session.jsonl`, data: "this is not json\n" }, { name: `${ID}/env.json`, data: goodEnv }], /does not start with a JSON line/],
    ["wrong kind", [{ name: `${ID}/session.jsonl`, data: JSON.stringify({ kind: "boot", v: 1 }) + "\n" }, { name: `${ID}/env.json`, data: goodEnv }], /not \{"kind":"session"\}/],
    ["v 2", [{ name: `${ID}/session.jsonl`, data: JSON.stringify({ kind: "session", v: 2, id: ID }) + "\n" }, { name: `${ID}/env.json`, data: goodEnv }], /session v 1 only/],
    ["no env.json", [{ name: `${ID}/session.jsonl`, data: goodSession }], /no env\.json/],
    ["env format 2", [{ name: `${ID}/session.jsonl`, data: goodSession }, { name: `${ID}/env.json`, data: JSON.stringify({ format: 2 }) }], /format 2/],
    ["env not json", [{ name: `${ID}/session.jsonl`, data: goodSession }, { name: `${ID}/env.json`, data: "{" }], /env\.json is not valid JSON/],
    ["no session", [{ name: "readme.txt", data: "hi" }], /no session folder/],
    ["two sessions", [
      { name: "a/session.jsonl", data: goodSession }, { name: "a/env.json", data: goodEnv },
      { name: "b/session.jsonl", data: goodSession }, { name: "b/env.json", data: goodEnv },
    ], /holds 2 sessions/],
    ["root + folder", [{ name: "session.jsonl", data: goodSession }, { name: "env.json", data: goodEnv }, { name: "b/session.jsonl", data: goodSession }], /holds 2 sessions/],
    ["too deep", [{ name: "x/y/session.jsonl", data: goodSession }, { name: "x/y/env.json", data: goodEnv }], /nested too deep/],
  ];
  for (const [label, entries, re] of cases) {
    const zip = await rawZip(entries);
    await assert.rejects(importSession(zip, { root }), e => e.exitCode === 2 && re.test(e.message), label);
  }
  assert.ok(!existsSync(join(root, ".snapper")), "nothing was written by any refusal");
  const notZip = join(await tmp(), "x.zip");
  await writeFile(notZip, "this is not a zip");
  await assert.rejects(importSession(notZip, { root }), e => e.exitCode === 2 && /not a readable zip/.test(e.message));
  await assert.rejects(importSession(join(root, "nope.zip"), { root }), e => e.exitCode === 2 && /zip not found/.test(e.message));
});

test("import accepts a zip with the session at the root (no top-level folder)", async () => {
  const zip = await rawZip([{ name: "session.jsonl", data: goodSession }, { name: "env.json", data: goodEnv }, { name: "marks/0001/shot.png", data: "png" }]);
  const out = await tmp();
  const r = await importSession(zip, { out });
  assert.equal(r.id, ID);
  assert.ok(existsSync(join(r.dir, "marks", "0001", "shot.png")));
});

test("import refuses unsafe entry names before writing anything", async () => {
  const zip = await rawZip([{ name: "ab/session.jsonl", data: goodSession }, { name: "ab/env.json", data: goodEnv }, { name: "ab/c.txt", data: "evil" }]);
  // patch "ab/c.txt" → "../c.txt" in both headers (same length)
  const buf = await readFile(zip);
  let from = 0, patched = 0;
  for (;;) {
    const at = buf.indexOf("ab/c.txt", from);
    if (at < 0) break;
    buf.write("../c.txt", at, "utf8"); from = at + 8; patched++;
  }
  assert.equal(patched, 2);
  await writeFile(zip, buf);
  const out = await tmp();
  await assert.rejects(importSession(zip, { out }), e => e.exitCode === 2 && /unsafe entry name/.test(e.message));
  assert.deepEqual(await readdir(out), [], "nothing extracted");
  assert.ok(!existsSync(join(out, "..", "c.txt")));
});

test("import: --root and/or --out (both: out is the sessions folder, root is recorded in import.json)", async () => {
  const { zip } = await testerZip();
  await assert.rejects(importSession(zip, {}), e => e.exitCode === 2);
  await assert.rejects(importSession(zip, { root: join(await tmp(), "missing"), out: await tmp() }), e => e.exitCode === 2 && /game root not found/.test(e.message));
  const root = await tmp(), out = await tmp();
  const both = await importSession(zip, { root, out });
  assert.ok(both.dir.startsWith(out), both.dir);
  assert.equal(JSON.parse(await readFile(join(both.dir, "import.json"), "utf8")).root, resolve(root));
  await assert.rejects(importSession(zip, { root: join(await tmp(), "missing") }), e => e.exitCode === 2 && /game root not found/.test(e.message));
});

test("CLI import: prints the folder and the Copy-for-Claude line; usage and refusals exit 2", async () => {
  const { zip } = await testerZip();
  const root = await tmp();
  const r = snapper("import", zip, "--root", root);
  assert.equal(r.status, 0, r.stderr);
  const [dest, copy] = r.stdout.trim().split(/\r?\n/);
  assert.equal(dest, join(root, ".snapper", "sessions", "demo-game", ID));
  assert.equal(copy, `Read "${join(dest, "SESSION.md")}" and triage it with the snapper skill.`);
  assert.equal(snapper("import", zip, "--root", root).status, 2, "second import: id exists");
  assert.equal(snapper("import", zip).status, 2, "neither --root nor --out");
  assert.equal(snapper("import").status, 2);
  assert.equal(snapper("import", zip, "--root", root, "--out", join(root, "elsewhere")).status, 0, "both: --out is the sessions folder");
});
