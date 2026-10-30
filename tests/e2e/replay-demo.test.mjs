// G2 replay: record a scripted run of the demo through the page driver (Electron's Chromium), write a real session
// folder with the core writer, then `snapper replay` it (which spawns the Electron replay child) and check the output.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionWriter, serveStatic, tapeLinesFromFlush, pngSize } from "../../packages/core/index.mjs";
import { startPages } from "./helpers/electron-pages.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEMO = join(REPO, "examples", "demo");
const CLI = join(REPO, "bin", "snapper.mjs");
const KEYMAP = ["KeyA", "KeyD", "KeyW", "KeyS", "Space"];

let work, sessionDir, markFrame, recordedState;

const snapper = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO, timeout: 180000 });

/** Play a scripted run on the demo and return { tapeLines, markFrame, markState, end }. */
async function recordRun() {
  const server = await serveStatic(DEMO);
  const pages = await startPages();
  try {
    const sdk = await readFile(join(REPO, "packages", "sdk", "snapper.js"), "utf8");
    const page = await pages.open({
      width: 640, height: 360,
      initScripts: [`globalThis.__rec = { tape: [], send: [] };
      globalThis.__snapperBridge = {
        send(type, p) { __rec.send.push({ type, p }); },
        sendTape(f, m, n) { for (let i = 0; i < n; i++) __rec.tape.push([f[i], m[i]]); },
      };
${sdk}`],
    });
    await page.goto(`${server.url}/index.html?paused`);
    await page.waitForStepper(30000);
    await page.evaluate("(() => { globalThis.snapper.__host.pause(); return true; })()");
    const step = (n, codes) => page.evaluate(`globalThis.snapper.__host.step(${n}, ${JSON.stringify(codes)})`);
    await step(40, ["KeyD"]);
    await step(25, ["KeyD", "Space"]);
    await step(25, []);
    const mark = await page.evaluate("({ frame: globalThis.snapper.frame(), state: globalThis.snapper.__host.state() })");
    await step(5, []);
    await step(40, ["KeyA"]);
    await page.evaluate("(() => { globalThis.snapper.__host.flush(); return true; })()");
    const rec = await page.evaluate("globalThis.__rec.tape");
    const end = await page.evaluate("globalThis.snapper.frame()");
    return {
      tapeLines: tapeLinesFromFlush(rec.map(r => r[0]), rec.map(r => r[1]), rec.length),
      markFrame: mark.frame, markState: JSON.parse(mark.state), end,
    };
  } finally {
    await pages.stop();
    await server.close();
  }
}

before(async () => {
  work = await mkdtemp(join(tmpdir(), "snapper-replay-e2e-"));
  const run = await recordRun();
  markFrame = run.markFrame;
  recordedState = run.markState;
  const w = await createSessionWriter({ out: work, slug: "demo" });
  sessionDir = w.dir;
  w.line("session", { v: 1, id: w.id, game: "demo", url: "http://127.0.0.1:1/index.html", query: "", snapper: "1.0.0", startedAt: w.startedAtIso });
  await w.writeEnv({
    format: 1, snapper: "1.0.0", startedAt: w.startedAtIso,
    game: { slug: "demo", root: DEMO, url: "http://127.0.0.1:1/index.html", query: "" },
    host: { adapter: "test" }, display: { w: 640, h: 360, dpr: 1, hz: 60 }, window: { preset: "test", w: 640, h: 360, fullscreen: false },
    sdk: { present: true, version: "1.0.0", state: true, frame: true, stepper: true, keymap: KEYMAP, pauseParam: "paused", commands: ["reset", "teleport"] },
    config: {},
  });
  w.line("boot", { ok: true, ms: 100 });
  w.line("ready", { sdk: true, state: true, frame: true, stepper: true, commands: ["reset", "teleport"] });
  w.tape({ kind: "tape", v: 1, keymap: KEYMAP, pauseParam: "paused" });
  w.tapeMany(run.tapeLines);
  await w.makeMarkDir("0001");
  await w.writeMarkFile("0001", "state.json", run.markState);
  w.line("mark", { id: "0001", frame: markFrame, trigger: "smoke", dir: "marks/0001", summary: "scripted run", errors: 0, worstMs: 16.7 });
  w.line("end", { marks: 1, errors: 0, durationMs: 1000 });
  await w.flush();
});

after(async () => { if (work && !process.env.SNAPPER_KEEP) await rm(work, { recursive: true, force: true }); });

test("recorded run is sane", () => {
  assert.equal(markFrame, 89);
  assert.equal(recordedState.frame, 89);
  assert.ok(recordedState.player.x > 24, "player moved right");
});

test("replay: stateMatches true, frames, sheet, replay.md", async () => {
  const r = snapper("replay", sessionDir, "0001");
  assert.equal(r.status, 0, r.stderr);
  const outDir = join(sessionDir, "marks", "0001", "replay");
  assert.equal(r.stdout.trim().split("\n").pop(), outDir);

  const rj = JSON.parse(await readFile(join(outDir, "replay.json"), "utf8"));
  assert.equal(rj.stateMatches, true, JSON.stringify(rj.firstDiff));
  assert.equal(rj.firstDiff, undefined);
  assert.equal(rj.mark, "0001");
  assert.equal(rj.frameAt, 89);
  assert.equal(rj.before, 30);
  assert.equal(rj.after, 30);
  assert.equal(rj.every, 1);
  assert.match(rj.chromium, /^\d+\./);
  assert.deepEqual(rj.warnings, []);
  assert.equal(rj.frames.length, 61);
  assert.equal(rj.frames[0].frame, 59);
  assert.equal(rj.frames[60].frame, 119);
  assert.equal(rj.frames.find(f => f.frame === 89).state.player.x, recordedState.player.x);

  const files = await readdir(outDir);
  assert.equal(files.filter(f => /^f\d{6}\.png$/.test(f)).length, 61);
  assert.ok(files.includes("f000089.png") && files.includes("sheet.png") && files.includes("replay.md") && files.includes("replay.json"));
  const size = pngSize(await readFile(join(outDir, "f000089.png")));
  assert.deepEqual([size.w ?? size.width, size.h ?? size.height], [320, 180]);
  const sheet = pngSize(await readFile(join(outDir, "sheet.png")));
  assert.ok((sheet.w ?? sheet.width) >= 6 * 320);

  const md = await readFile(join(outDir, "replay.md"), "utf8");
  assert.match(md, /stateMatches: true/);
  assert.match(md, /Chromium \d+\./);
  assert.match(md, /Dumped frames: 59\.\.119/);
  assert.doesNotMatch(md, /NOT TRUSTWORTHY/);

  const summary = await readFile(join(sessionDir, "SESSION.md"), "utf8");
  assert.match(summary, /Replay: done · stateMatches true/);
});

test("replay: options --before/--after/--every/--out", async () => {
  const out = join(work, "custom-out");
  const r = snapper("replay", sessionDir, "1", "--before", "5", "--after", "5", "--every", "2", "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").pop(), out);
  const rj = JSON.parse(await readFile(join(out, "replay.json"), "utf8"));
  assert.equal(rj.stateMatches, true);
  assert.deepEqual(rj.frames.map(f => f.frame), [84, 86, 88, 89, 90, 92, 94]);
  assert.deepEqual((await readdir(out)).filter(f => f.endsWith(".png")).sort(),
    ["f000084.png", "f000086.png", "f000088.png", "f000089.png", "f000090.png", "f000092.png", "f000094.png", "sheet.png"]);
});

test("replay: a tampered state.json gives stateMatches false, a firstDiff and a loud replay.md", async () => {
  const statePath = join(sessionDir, "marks", "0001", "state.json");
  const original = await readFile(statePath, "utf8");
  const tampered = JSON.parse(original);
  tampered.player.x += 5;
  await writeFile(statePath, JSON.stringify(tampered, null, 2));
  try {
    const r = snapper("replay", sessionDir, "0001", "--before", "3", "--after", "3");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /stateMatches is FALSE/);
    const outDir = join(sessionDir, "marks", "0001", "replay");
    const rj = JSON.parse(await readFile(join(outDir, "replay.json"), "utf8"));
    assert.equal(rj.stateMatches, false);
    assert.equal(rj.firstDiff, "$.player.x");
    assert.equal(rj.frames.length, 7);
    const md = await readFile(join(outDir, "replay.md"), "utf8");
    assert.match(md, /stateMatches: FALSE/);
    assert.match(md, /NOT TRUSTWORTHY/);
    assert.match(md, /\$\.player\.x/);
    assert.match(md, new RegExp(`recorded ${tampered.player.x} · replayed ${recordedState.player.x}`));
    // the old 61-frame dump was replaced, not mixed in
    assert.equal((await readdir(outDir)).filter(f => /^f\d{6}\.png$/.test(f)).length, 7);
    assert.match(await readFile(join(sessionDir, "SESSION.md"), "utf8"), /stateMatches false \(first diff \$\.player\.x\)/);
  } finally {
    await writeFile(statePath, original);
  }
});

test("replay: perf differences alone do not break the match", async () => {
  const statePath = join(sessionDir, "marks", "0001", "state.json");
  const original = await readFile(statePath, "utf8");
  const s = JSON.parse(original);
  s.perf = { fps: 1, frameMs: 999 };
  await writeFile(statePath, JSON.stringify(s));
  try {
    const r = snapper("replay", sessionDir, "0001", "--before", "2", "--after", "2");
    assert.equal(r.status, 0, r.stderr);
    const rj = JSON.parse(await readFile(join(sessionDir, "marks", "0001", "replay", "replay.json"), "utf8"));
    assert.equal(rj.stateMatches, true);
  } finally {
    await writeFile(statePath, original);
  }
});
