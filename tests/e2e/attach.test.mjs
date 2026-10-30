// End-to-end: `snapper attach` to a second, plain Electron (tests/fixtures/attach-target) that shows a page with remote debugging on.
// Opens real windows (a few seconds each). Run with: npm run test:e2e
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pngStats, decodePng, parseJsonl, serveStatic } from "@snapper/core";
import { startElectronTarget } from "../fixtures/attach-target/start.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI = join(ROOT, "bin", "snapper.mjs");
const FX = join(ROOT, "tests", "fixtures", "attach-target");

function snapper(args, timeoutMs = 150000) {
  return new Promise(res => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
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

/** Serve `root`, start the second Electron on it, run `fn(target, serverUrl)`, then stop everything. */
async function withTarget(root, fn) {
  const srv = await serveStatic(root);
  const target = await startElectronTarget({ url: `${srv.url}/index.html` });
  try { return await fn(target, srv.url); }
  finally { await target.stop(); await srv.close(); }
}

test("attach: the demo in a second Electron: a mark, env, shot, SDK state, perf, before sheet; replay matches", async t => {
  const out = mkdtempSync(join(tmpdir(), "snapper-attach-e2e-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await withTarget(join(ROOT, "examples", "demo"), async target => {
    const r = await snapper(["attach", target.endpoint, "--game-root", "examples/demo", "--out", out, "--smoke", join(FX, "smoke-fast.json")]);
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(lastLine(r.stdout));
    assert.equal(result.ok, true);
    assert.ok(result.marks >= 1);
    const dir = sessionDir(out);
    assert.equal(result.session, dir);

    const env = json(join(dir, "env.json"));
    assert.equal(env.host.adapter, "cdp");
    assert.equal(env.host.attach.reloaded, true);
    assert.equal(env.host.attach.endpoint, target.endpoint);
    assert.equal(env.host.attach.browser, target.browser);
    assert.equal(env.gpu, null);
    assert.equal(env.window.w, 1280);
    assert.equal(env.window.h, 720);
    assert.equal(env.sdk.stepper, true);

    const { lines } = parseJsonl(readFileSync(join(dir, "session.jsonl"), "utf8"));
    assert.equal(lines.at(-1).kind, "end");
    const mark = lines.find(l => l.kind === "mark");
    assert.equal(mark.replayable, undefined);
    const m = join(dir, "marks", mark.id);
    const shot = pngStats(readFileSync(join(m, "shot.png")));
    assert.ok(shot.nonBlack > 0.5 && shot.distinct > 2, `shot.png is not black (${shot.nonBlack})`);
    const state = json(join(m, "state.json"));
    assert.ok(Number.isInteger(state.frame) && state.player, "state.json comes from the SDK");
    assert.ok(json(join(m, "perf.json")).intervalsMs.length > 10);
    const perf = json(join(m, "perf.json"));
    assert.equal(perf.host.adapter, "cdp");
    assert.equal(typeof perf.host.hideRoundTripMs, "number");
    assert.ok(existsSync(join(m, "before", "sheet.png")));
    assert.ok(existsSync(join(m, "frame.png")));

    const rep = await snapper(["replay", dir, mark.id]);
    assert.equal(rep.code, 0, rep.stderr);
    assert.equal(json(join(m, "replay", "replay.json")).stateMatches, true);
  });
});

test("attach: hotkeys are the page's own keydown events; the overlay never appears in a shot; the game never sees the note typing", async t => {
  const out = mkdtempSync(join(tmpdir(), "snapper-attach-e2e-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await withTarget(join(ROOT, "tests", "fixtures", "host-page"), async target => {
    const r = await snapper(["attach", target.endpoint, "--game-root", "tests/fixtures/host-page", "--out", out, "--smoke", join(FX, "smoke-hostpage.json")]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(lastLine(r.stdout)).ok, true);
    const dir = sessionDir(out);
    const { lines } = parseJsonl(readFileSync(join(dir, "session.jsonl"), "utf8"));
    const marks = lines.filter(l => l.kind === "mark");
    const triggers = new Set(marks.map(m => m.trigger));
    for (const tr of ["smoke", "error", "exception", "hotkey"]) assert.ok(triggers.has(tr), `trigger ${tr}`);

    for (const m of marks) {
      // the overlay chip sits top-right: that strip of the page is flat colour, so the shot must be too
      const s = decodePng(readFileSync(join(dir, "marks", m.id, "shot.png")));
      const seen = new Set();
      for (let y = 0; y < 60; y++) for (let x = s.w - 460; x < s.w; x++) { const o = (y * s.w + x) * 4; seen.add(`${s.data[o]},${s.data[o + 1]},${s.data[o + 2]}`); }
      assert.equal(seen.size, 1, `${m.id}/shot.png top-right strip is flat (overlay absent), saw ${[...seen].slice(0, 4)}`);
    }

    const hotkey = marks.find(m => m.trigger === "hotkey");
    assert.equal(readFileSync(join(dir, "marks", hotkey.id, "note.txt"), "utf8").trim(), "hello");
    assert.ok(lines.some(l => l.kind === "note" && l.mark === hotkey.id && l.text === "hello"));

    const last = marks.at(-1);
    const log = json(join(dir, "marks", last.id, "log.json")).map(e => e.text);
    assert.ok(log.includes("keydown KeyA") && log.includes("keydown KeyB"), "page saw its own keys");
    for (const c of ["KeyH", "KeyL", "KeyO", "Enter", "F8"]) assert.ok(!log.includes(`keydown ${c}`), `page must not see ${c}`);
    assert.equal(log.filter(x => x === "host-page: deliberate console.error").length, 1, "typing 'e' did not reach the page");

    // the ring frames have the overlay blanked
    const sheet = decodePng(readFileSync(join(dir, "marks", last.id, "before", "sheet.png")));
    let black = 0, blue = 0;
    for (let y = 0; y < 5; y++) for (let x = 320 - 80; x < 320; x++) { const o = (y * sheet.w + x) * 4; if (sheet.data[o + 2] > 120) blue++; else if (sheet.data[o] < 8 && sheet.data[o + 2] < 8) black++; }
    assert.ok(black > blue, `sheet tile 0 top-right is blanked (black ${black}, page-coloured ${blue})`);

    // tape: header first, then the recorded keys; the hotkey key itself is not game input
    const tape = parseJsonl(readFileSync(join(dir, "tape.jsonl"), "utf8")).lines;
    assert.equal(tape[0].kind, "tape");
    assert.ok(tape.some(l => l.k === "KeyA" && l.d === 1));
    assert.ok(!tape.some(l => l.k === "F8"), "the hotkey was not recorded as game input");

    // the page was not left changed: the tab is still open (the host never closes it)
    const { listTargets } = await import("../../packages/host/main/cdp.mjs");
    assert.equal((await listTargets(target.endpoint)).length, 1);
  });
});

test("attach: an ambiguous endpoint prints the page list and exits 2; --target picks one", async () => {
  const srv = await serveStatic(join(ROOT, "tests", "fixtures", "host-page"));
  const target = await startElectronTarget({ url: `${srv.url}/index.html`, url2: `${srv.url}/index.html?second` });
  try {
    const { listTargets } = await import("../../packages/host/main/cdp.mjs");
    const list = await listTargets(target.endpoint);
    assert.equal(list.length, 2);
    const r = await snapper(["attach", target.endpoint]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /2 pages are open/);
    assert.ok(r.stdout.includes("?second") && r.stdout.includes(list[0].id), r.stdout);
    const none = await snapper(["attach", target.endpoint, "--target", "no-such-page"]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /matches no page/);
  } finally { await target.stop(); await srv.close(); }
});

test("attach: the quit file (Ctrl+C) and a vanished browser both end the session cleanly, folder intact", async t => {
  const { buildAttachOptions, spawnAttach } = await import("../../packages/host/main/cli-attach.mjs");
  const out = mkdtempSync(join(tmpdir(), "snapper-attach-e2e-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const check = dir => {
    const { lines } = parseJsonl(readFileSync(join(dir, "session.jsonl"), "utf8"));
    assert.equal(lines.at(-1).kind, "end", "end line");
    assert.ok(existsSync(join(dir, "SESSION.md")), "SESSION.md");
    assert.ok(existsSync(join(dir, "env.json")) && existsSync(join(dir, "tape.jsonl")));
    return lines;
  };
  await withTarget(join(ROOT, "tests", "fixtures", "host-page"), async (target, url) => {
    // Ctrl+C: the quit file
    let dir = null;
    const opts = await buildAttachOptions({ positional: [target.endpoint], flags: { gameRoot: "tests/fixtures/host-page", out } });
    const p = spawnAttach(opts, { onSession: d => { dir = d; } });
    for (let i = 0; i < 200 && !dir; i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(dir, "the host reported its session folder");
    await new Promise(r => setTimeout(r, 2500));
    p.quit();
    const res = await Promise.race([p.done, new Promise(r => setTimeout(() => r(null), 30000))]);
    assert.ok(res, "the host exited after the quit file");
    assert.equal(res.code, 0);
    check(dir);
    assert.equal((await (await import("../../packages/host/main/cdp.mjs")).listTargets(target.endpoint)).length, 1, "the tab is still open");
    void url;
  });
  // the browser disappears under a running attach
  const srv = await serveStatic(join(ROOT, "tests", "fixtures", "host-page"));
  const target = await startElectronTarget({ url: `${srv.url}/index.html` });
  try {
    let dir = null;
    const opts = await buildAttachOptions({ positional: [target.endpoint], flags: { gameRoot: "tests/fixtures/host-page", out } });
    const p = spawnAttach(opts, { onSession: d => { dir = d; } });
    for (let i = 0; i < 200 && !dir; i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(dir);
    await new Promise(r => setTimeout(r, 4500));                // past the 3 s no-SDK ready fallback, so the boot line exists
    await target.stop();
    const res = await Promise.race([p.done, new Promise(r => setTimeout(() => r(null), 30000))]);
    assert.ok(res, "the host exited when the socket dropped");
    assert.equal(res.code, 0);
    const lines = check(dir);
    assert.ok(lines.some(l => l.kind === "boot"));
  } finally { await target.stop(); await srv.close(); }
});
