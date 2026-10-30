// End-to-end: tester mode (BRIEF-v1.4 §3.2) on a copy of examples/demo placed as <tmp>/kit/game.
// First run: the overlay asks the name (typed by the smoke), a mark with a note, then the outbox zip. Second run: no question.
// Opens real windows (a few seconds each). Run with: npm run test:e2e
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip, readZipEntry } from "@snapper/core";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI = join(ROOT, "bin", "snapper.mjs");

function play(args, timeoutMs = 150000) {
  return new Promise(res => {
    const child = spawn(process.execPath, [CLI, "play", ...args], { cwd: ROOT, env: { ...process.env, SNAPPER_NO_SHELL: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const to = setTimeout(() => child.kill(), timeoutMs);
    child.on("exit", code => { clearTimeout(to); res({ code, stdout, stderr }); });
  });
}
const json = p => JSON.parse(readFileSync(p, "utf8"));
const rows = t => t.split("\n").map(x => x.trim()).filter(Boolean);
const lineDocs = t => rows(t).map(l => JSON.parse(l));
const lines = p => lineDocs(readFileSync(p, "utf8"));

const ASK = [
  { wait: 1500 }, { type: "Ann" }, { key: "Enter" }, { wait: 1200 },
  { keys: ["KeyD", "Space"], hold: 600 }, { mark: "tester note: the jump feels floaty" }, { wait: 500 }, { end: true },
];
const NO_ASK = [
  { wait: 1500 }, { type: "zed" }, { key: "Enter" }, { wait: 800 },
  { keys: ["KeyD", "Space"], hold: 600 }, { mark: "second run mark" }, { wait: 500 }, { end: true },
];

test("tester mode: asks the name once, writes tester.json + env tester.name, zips the session into <kit>/outbox, never asks again", async t => {
  const tmp = mkdtempSync(join(tmpdir(), "snapper-tester-e2e-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const kit = join(tmp, "kit");
  const game = join(kit, "game");
  mkdirSync(kit, { recursive: true });
  cpSync(join(ROOT, "examples", "demo"), game, { recursive: true });
  writeFileSync(join(kit, "snapper.config.json"), JSON.stringify({ developer: "Ada", tester: true, slug: "demo" }));
  writeFileSync(join(tmp, "ask.json"), JSON.stringify(ASK));
  writeFileSync(join(tmp, "noask.json"), JSON.stringify(NO_ASK));

  // ---- first run
  const r1 = await play([game, "--tester", "--config", join(kit, "snapper.config.json"), "--smoke", join(tmp, "ask.json"), "--preset", "deck"]);
  assert.equal(r1.code, 0, r1.stderr);
  const outLines = rows(r1.stdout);
  const result1 = JSON.parse(outLines.at(-1));
  assert.equal(result1.ok, true);
  assert.ok(result1.marks >= 1);
  const outboxLine = outLines.find(l => l.startsWith("snapper: outbox "));
  assert.ok(outboxLine, `stdout has the outbox line: ${r1.stdout}`);
  assert.ok(outLines.indexOf(outboxLine) < outLines.length - 1, "the outbox line comes before the smoke JSON line");
  const zip1 = outboxLine.slice("snapper: outbox ".length);

  const tj = json(join(kit, "tester.json"));
  assert.equal(tj.name, "Ann");
  assert.ok(!Number.isNaN(Date.parse(tj.at)), "tester.json has an ISO at");

  const dir1 = result1.session;
  const env1 = json(join(dir1, "env.json"));
  assert.deepEqual(env1.tester, { name: "Ann" });
  assert.equal(env1.config.developer, "Ada");
  assert.equal(env1.config.tester, true);
  // the name was typed into the overlay: the game never saw those keys
  const tape1 = lines(join(dir1, "tape.jsonl")).filter(l => l.k);
  assert.ok(!tape1.some(l => l.k === "KeyA" || l.k === "KeyN"), "the name keys never reached the game");
  assert.ok(tape1.some(l => l.k === "KeyD"), "game keys after the prompt do");
  const mark = lines(join(dir1, "session.jsonl")).find(l => l.kind === "mark");
  assert.ok(mark, "a mark line");
  assert.match(readFileSync(join(dir1, "marks", mark.id, "note.txt"), "utf8"), /floaty/);

  // ---- the outbox zip
  const id1 = dir1.split(/[\\/]/).pop();
  assert.equal(zip1, join(kit, "outbox", `demo-${id1}.zip`));
  assert.ok(existsSync(zip1));
  const entries1 = await readZip(zip1);
  const names1 = entries1.map(e => e.name);
  assert.ok(names1.length > 5);
  assert.ok(names1.every(n => n.startsWith(id1 + "/")), "every entry is under <session id>/");
  for (const n of ["session.jsonl", "env.json", "SESSION.md", "SESSION.html", "tape.jsonl"]) assert.ok(names1.includes(`${id1}/${n}`), n);
  assert.ok(names1.includes(`${id1}/marks/${mark.id}/shot.png`));
  assert.ok(!names1.some(n => /outbox/.test(n) || n.endsWith(".zip")), "the outbox is never zipped into itself");
  const zEnv = JSON.parse((await readZipEntry(zip1, `${id1}/env.json`)).toString("utf8"));
  assert.equal(zEnv.tester.name, "Ann");
  const zSession = lineDocs((await readZipEntry(zip1, `${id1}/session.jsonl`)).toString("utf8"));
  assert.equal(zSession[0].kind, "session");
  assert.equal(zSession.at(-1).kind, "end", "zipped after the end line");
  assert.match((await readZipEntry(zip1, `${id1}/SESSION.md`)).toString("utf8"), /tester: Ann/);

  // ---- second run: no question, the same name
  const before = readFileSync(join(kit, "tester.json"), "utf8");
  const r2 = await play([game, "--tester", "--config", join(kit, "snapper.config.json"), "--smoke", join(tmp, "noask.json"), "--preset", "deck"]);
  assert.equal(r2.code, 0, r2.stderr);
  const l2 = rows(r2.stdout);
  const result2 = JSON.parse(l2.at(-1));
  assert.equal(result2.ok, true);
  assert.equal(readFileSync(join(kit, "tester.json"), "utf8"), before, "tester.json is untouched");
  const dir2 = result2.session;
  assert.deepEqual(json(join(dir2, "env.json")).tester, { name: "Ann" }, "env.json tester.name comes from tester.json");
  const tape2 = lines(join(dir2, "tape.jsonl")).filter(l => l.k);
  assert.ok(tape2.some(l => l.k === "KeyZ" && l.d === 1), "typing \"zed\" reached the game: there was no name prompt");
  const zip2 = l2.find(l => l.startsWith("snapper: outbox ")).slice("snapper: outbox ".length);
  assert.notEqual(zip2, zip1);
  assert.deepEqual(readdirSync(join(kit, "outbox")).sort(), [zip1, zip2].map(p => basename(p)).sort());
  const id2 = basename(dir2);
  assert.ok((await readZip(zip2)).every(e => e.name.startsWith(id2 + "/")));
});

test("play without --tester behaves as before: no tester.json, no outbox, no env.tester, no outbox line", async t => {
  const tmp = mkdtempSync(join(tmpdir(), "snapper-notester-e2e-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const kit = join(tmp, "kit");
  mkdirSync(kit, { recursive: true });
  cpSync(join(ROOT, "examples", "demo"), join(kit, "game"), { recursive: true });
  writeFileSync(join(tmp, "s.json"), JSON.stringify([{ wait: 1500 }, { keys: ["KeyD"], hold: 300 }, { mark: "plain" }, { end: true }]));
  const r = await play([join(kit, "game"), "--smoke", join(tmp, "s.json"), "--preset", "deck"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!/outbox/.test(r.stdout));
  assert.ok(!existsSync(join(kit, "tester.json")) && !existsSync(join(kit, "outbox")));
  assert.equal(json(join(JSON.parse(rows(r.stdout).at(-1)).session, "env.json")).tester, undefined);
});
