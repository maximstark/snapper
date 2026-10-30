// End-to-end: the Electron host plays a page under a smoke script and writes a complete session.
// Opens real windows (a few seconds each). Run with: npm run test:e2e
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pngStats, pngSize, decodePng, parseJsonl } from "@snapper/core";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI = join(ROOT, "bin", "snapper.mjs");

function play(args, timeoutMs = 120000) {
  return new Promise(res => {
    const child = spawn(process.execPath, [CLI, "play", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const to = setTimeout(() => child.kill(), timeoutMs);
    child.on("exit", code => { clearTimeout(to); res({ code, stdout, stderr }); });
  });
}

const json = p => JSON.parse(readFileSync(p, "utf8"));
const lastLine = s => s.trim().split(/\r?\n/).pop();

function sessionDir(out) {
  const slugDir = readdirSync(out).map(n => join(out, n))[0];
  return join(slugDir, readdirSync(slugDir)[0]);
}

function markFolderComplete(dir, id) {
  const m = join(dir, "marks", id);
  for (const f of ["shot.png", "state.json", "inputs.json", "log.json", "perf.json", "before/index.json", "before/sheet.png"]) {
    assert.ok(existsSync(join(m, f)), `${id}/${f} exists`);
  }
  const shot = pngStats(readFileSync(join(m, "shot.png")));
  assert.ok(shot.nonBlack > 0.5 && shot.distinct > 2, `${id}/shot.png is not black (nonBlack ${shot.nonBlack})`);
  const index = json(join(m, "before", "index.json"));
  assert.ok(Array.isArray(index));
  for (const e of index) assert.ok(existsSync(join(m, "before", e.file)), `${e.file} exists`);
  assert.ok(pngSize(readFileSync(join(m, "before", "sheet.png"))).w >= 320);
  const inputs = json(join(m, "inputs.json"));
  assert.ok(Array.isArray(inputs.wall) && Array.isArray(inputs.frames));
  assert.ok(Array.isArray(json(join(m, "log.json"))));
  const perf = json(join(m, "perf.json"));
  assert.ok(perf.intervalsMs.length > 10, "perf has intervals");
  return { shot, inputs, perf, index };
}

test("host: fixture page smoke session is complete, overlay-free, and note typing stays out of the page", async t => {
  const out = mkdtempSync(join(tmpdir(), "snapper-host-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const r = await play(["tests/fixtures/host-page", "--smoke", "tests/fixtures/host-page/smoke.json", "--preset", "deck", "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  const result = JSON.parse(lastLine(r.stdout));
  assert.equal(result.ok, true);
  assert.ok(result.marks >= 5);

  const dir = sessionDir(out);
  assert.equal(result.session, dir);
  const { lines } = parseJsonl(readFileSync(join(dir, "session.jsonl"), "utf8"));
  assert.equal(lines[0].kind, "session");
  assert.equal(lines.at(-1).kind, "end");
  for (const k of ["boot", "ready", "mark", "end"]) assert.ok(lines.some(l => l.kind === k), `has ${k}`);
  assert.equal(lines.find(l => l.kind === "boot").ok, true);
  const marks = lines.filter(l => l.kind === "mark");
  const triggers = new Set(marks.map(m => m.trigger));
  for (const tr of ["smoke", "error", "exception", "hotkey"]) assert.ok(triggers.has(tr), `trigger ${tr}`);

  let withWall = 0;
  for (const m of marks) {
    const c = markFolderComplete(dir, m.id);
    if (c.inputs.wall.length) withWall++;
    // The overlay chip sits top-right: that strip of the page is flat colour, so the shot must be too.
    const s = decodePng(readFileSync(join(dir, "marks", m.id, "shot.png")));
    const seen = new Set();
    for (let y = 0; y < 60; y++) for (let x = s.w - 460; x < s.w; x++) { const o = (y * s.w + x) * 4; seen.add(`${s.data[o]},${s.data[o + 1]},${s.data[o + 2]}`); }
    assert.equal(seen.size, 1, `${m.id}/shot.png top-right strip is flat (overlay absent), saw ${[...seen].slice(0, 4)}`);
  }
  assert.ok(withWall >= 2, "wall lines recorded in inputs.json");

  // The hotkey mark opened the note box; "hello" was typed into it and Enter saved it.
  const hotkey = marks.find(m => m.trigger === "hotkey");
  assert.equal(readFileSync(join(dir, "marks", hotkey.id, "note.txt"), "utf8").trim(), "hello");
  assert.ok(lines.some(l => l.kind === "note" && l.mark === hotkey.id && l.text === "hello"));

  // ... and the page never saw those keys (it logs every keydown; typing "hello" would also have fired KeyE's console.error).
  const last = marks.at(-1);
  const log = json(join(dir, "marks", last.id, "log.json")).map(e => e.text);
  assert.ok(log.includes("keydown KeyA") && log.includes("keydown KeyB"), "page saw its own keys");
  for (const c of ["KeyH", "KeyL", "KeyO"]) assert.ok(!log.includes(`keydown ${c}`), `page must not see ${c} typed into the note box`);
  assert.equal(log.filter(x => x === "host-page: deliberate console.error").length, 1, "typing 'e' did not reach the page");
  assert.ok(!log.includes("keydown Enter"), "Enter confirming the note did not reach the page");

  // The ring-buffer frames have the overlay blanked: top-right of the first sheet tile is black, not the page colour.
  const sheet = decodePng(readFileSync(join(dir, "marks", last.id, "before", "sheet.png")));
  let black = 0, blue = 0;
  for (let y = 0; y < 5; y++) for (let x = 320 - 80; x < 320; x++) { const o = (y * sheet.w + x) * 4; if (sheet.data[o + 2] > 120) blue++; else if (sheet.data[o] < 8 && sheet.data[o + 2] < 8) black++; }
  assert.ok(black > blue, `sheet tile 0 top-right is blanked (black ${black}, page-coloured ${blue})`);

  // tape: header first, then wall lines.
  const tape = parseJsonl(readFileSync(join(dir, "tape.jsonl"), "utf8")).lines;
  assert.equal(tape[0].kind, "tape");
  assert.ok(tape.some(l => l.k === "KeyA" && l.d === 1));

  const md = readFileSync(join(dir, "SESSION.md"), "utf8");
  assert.ok(md.startsWith("# Snapper session"));
  assert.ok(json(join(dir, "env.json")).host.chromium);
});

const demoReady = existsSync(join(ROOT, "packages/sdk/snapper.js")) && existsSync(join(ROOT, "examples/demo/smoke.json"));
test("host: demo smoke (SDK) writes state, frame.png, tape frames and the five triggers", { skip: !demoReady && "SDK or demo not present" }, async t => {
  const out = mkdtempSync(join(tmpdir(), "snapper-host-demo-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const r = await play(["examples/demo", "--smoke", "examples/demo/smoke.json", "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(lastLine(r.stdout)).ok, true);
  const dir = sessionDir(out);
  const { lines } = parseJsonl(readFileSync(join(dir, "session.jsonl"), "utf8"));
  const ready = lines.find(l => l.kind === "ready");
  assert.deepEqual([ready.sdk, ready.state, ready.frame, ready.stepper], [true, true, true, true]);
  const marks = lines.filter(l => l.kind === "mark");
  const byTrigger = Object.fromEntries(marks.map(m => [m.trigger, m]));
  for (const tr of ["smoke", "error", "exception", "fps", "assert"]) assert.ok(byTrigger[tr], `mark ${tr}`);
  for (const m of marks) {
    markFolderComplete(dir, m.id);
    assert.ok(m.frame >= 0, `${m.id} has a game frame`);
    const fp = join(dir, "marks", m.id, "frame.png");
    assert.deepEqual(pngSize(readFileSync(fp)), { w: 320, h: 180 });
    const state = json(join(dir, "marks", m.id, "state.json"));
    assert.ok(state.frame !== undefined || state.error === undefined, "state.json has state");
    const inputs = json(join(dir, "marks", m.id, "inputs.json"));
    assert.ok(inputs.frames.length > 0, `${m.id} inputs.json has frame lines`);
  }
  assert.ok(json(join(dir, "marks", byTrigger.fps.id, "perf.json")).max >= 250);
  const errLog = json(join(dir, "marks", byTrigger.error.id, "log.json")).map(e => e.text).join("\n");
  assert.match(errLog, /demo: deliberate console\.error/);
  const tape = parseJsonl(readFileSync(join(dir, "tape.jsonl"), "utf8")).lines;
  assert.ok(tape[0].keymap.length > 0 && tape.some(l => Number.isInteger(l.f) && Number.isInteger(l.m)));
});

test("host: smoke {eval} runs page code, awaits promises, and reports a throw, a rejection and a timeout as failures (D-023)", async t => {
  const out = mkdtempSync(join(tmpdir(), "snapper-eval-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const script = join(out, "eval-smoke.json");
  writeFileSync(script, JSON.stringify([
    { wait: 800 },
    { eval: "1+1" },
    { eval: "Promise.resolve(2)" },
    { eval: "new Promise(r => setTimeout(() => r(3), 150))" },
    { eval: "(() => { throw new Error('nope') })()" },
    { eval: "Promise.reject(new Error('rejected-nope'))" },
    { eval: "new Promise(() => {})", ms: 300 },
    { end: true },
  ]));
  const r = await play(["tests/fixtures/host-page", "--smoke", script, "--preset", "deck", "--out", join(out, "s")]);
  const result = JSON.parse(lastLine(r.stdout));
  assert.equal(result.ok, false);
  const fails = r.stderr.split(/\r?\n/).filter(l => l.startsWith("snapper play: smoke failure:"));
  assert.equal(fails.length, 3, r.stderr);
  assert.ok(/nope/.test(fails[0]) && /step 4/.test(fails[0]), fails[0]);
  assert.ok(/rejected-nope/.test(fails[1]), fails[1]);
  assert.ok(/timed out/.test(fails[2]), fails[2]);
});
