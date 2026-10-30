// Demo end-to-end (Electron's Chromium through the replay page driver): stepper determinism, frame provider,
// commands, no-SDK run. Pages are hidden Electron windows served by tests/e2e/helpers/driver-server.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStatic, pngSize, dataUrlToBuffer } from "../../packages/core/index.mjs";
import { startPages, NULL_BRIDGE } from "./helpers/electron-pages.mjs";

const here = p => fileURLToPath(new URL(p, import.meta.url));
const SDK = readFileSync(here("../../packages/sdk/snapper.js"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server, pages;

before(async () => {
  server = await serveStatic(here("../../examples/demo"));
  pages = await startPages();
});
after(async () => { await pages?.stop(); await server?.close(); });

async function openPaused(extraQuery = "") {
  const page = await pages.open({ initScripts: [NULL_BRIDGE, SDK], width: 640, height: 360 });
  await page.goto(`${server.url}/index.html?paused${extraQuery}`);
  await page.waitForStepper();
  return page;
}
const script = page => page.evaluate(`(() => {
  const h = window.snapper.__host;
  h.step(30, ["KeyD", "Space"]);
  h.step(60, ["KeyD"]);
  const last = h.step(20, []);
  const st = JSON.parse(h.state());
  delete st.perf;
  return { last, state: JSON.stringify(st), snapperFrame: window.snapper.frame() };
})()`);

test("ready reports state, frame, stepper and the two commands", async () => {
  const page = await openPaused();
  const r = await page.evaluate("window.snapper.__host.ready()");
  assert.equal(r.sdk, true); assert.equal(r.state, true); assert.equal(r.frame, true); assert.equal(r.stepper, true);
  assert.deepEqual(r.commands, ["reset", "teleport"]);
  assert.deepEqual(r.keymap, ["KeyA", "KeyD", "KeyW", "KeyS", "Space"]);
  assert.equal(r.pauseParam, "paused");
  assert.equal(r.seed, 1234);
  assert.equal(await page.evaluate("window.snapper.frame()"), -1, "paused boot ticks nothing");
  assert.deepEqual(await page.errors(), []);
  await page.close();
});

test("stepping the same input script in two fresh pages gives identical state", async () => {
  const a = await openPaused(), b = await openPaused();
  const ra = await script(a), rb = await script(b);
  assert.equal(ra.state, rb.state);
  assert.equal(ra.last, 109, "110 steps = frames 0..109; __host.step returns snapper.frame()");
  assert.equal(ra.snapperFrame, 109);
  const st = JSON.parse(ra.state);
  assert.equal(st.frame, 109);
  assert.ok(st.player.x > 100, "the box moved right");
  await a.close(); await b.close();
});

test("live keyboard is ignored during step()", async () => {
  const a = await openPaused(), b = await openPaused();
  // Prove the live key really reaches page b (a real CDP key event), then that step() ignores it.
  await b.evaluate("(() => { window.__keys = []; window.addEventListener('keydown', e => window.__keys.push(e.code), true); return true; })()");
  await b.key("KeyA", "down");
  await sleep(100);
  assert.ok((await b.evaluate("window.__keys")).includes("KeyA"), "the dispatched KeyA reached the page");
  const ra = await script(a), rb = await script(b);
  await b.key("KeyA", "up");
  assert.equal(ra.state, rb.state);
  await a.close(); await b.close();
});

test("__host.frame() is the internal 320x180 PNG", async () => {
  const page = await openPaused();
  await page.evaluate("window.snapper.__host.step(10, ['KeyD'])");
  const url = await page.evaluate("window.snapper.__host.frame()");
  assert.match(url, /^data:image\/png;base64,/);
  assert.deepEqual(pngSize(dataUrlToBuffer(url)), { w: 320, h: 180 });
  await page.close();
});

test("commands: teleport and reset (re-seed) work through __host.command", async () => {
  const page = await openPaused("&seed=99");
  const out = await page.evaluate(`(() => {
    const h = window.snapper.__host;
    h.step(5, []);
    const tp = h.command("teleport", "100,50");
    const afterTp = JSON.parse(h.state()).player;
    const bad = h.command("teleport", "nope");
    h.step(40, ["KeyD"]);
    const reset = h.command("reset");
    const st = JSON.parse(h.state());
    return { tp, afterTp, bad, reset, st, list: h.commandList() };
  })()`);
  assert.deepEqual(JSON.parse(out.tp), { x: 100, y: 50 });
  assert.equal(out.afterTp.x, 100);
  assert.match(JSON.parse(out.bad).error, /teleport needs/);
  assert.equal(out.st.frame, -1);
  assert.equal(out.st.seed, 99);
  assert.equal(out.list[1].arg, "text");
  await page.close();
});

test("the demo runs 2 s of play with NO SDK and logs no errors", async () => {
  // A live game loop needs a shown window: a hidden one throttles rAF to ~10 Hz while the canvas is drawn (the stepper
  // does not care, it never waits for a frame).
  const page = await pages.open({ width: 640, height: 360, headed: true });
  await page.goto(`${server.url}/index.html`);
  assert.equal(await page.evaluate("typeof window.snapper"), "undefined");
  await page.key("KeyD", "down"); await page.key("Space", "down");
  await sleep(2000);
  await page.key("KeyD", "up"); await page.key("Space", "up");
  const problems = (await page.console()).filter(c => c.type === "error" || c.type === "warning");
  assert.deepEqual(problems, []);
  assert.deepEqual(await page.errors(), []);
  const px = await page.evaluate("document.getElementById('screen').getContext('2d').getImageData(0, 0, 320, 180).data.some((v, i) => i % 4 !== 3 && v > 0)");
  assert.equal(px, true, "canvas is drawn");
  await page.close();
});

test("with the live loop and the SDK, a fault key throws but the game keeps stepping", async () => {
  const page = await pages.open({ initScripts: [NULL_BRIDGE, SDK], width: 640, height: 360, headed: true });
  await page.goto(`${server.url}/index.html`);
  await sleep(500);
  const f0 = await page.evaluate("window.snapper.frame()");
  await page.press("KeyX");
  await sleep(500);
  const f1 = await page.evaluate("window.snapper.frame()");
  const errors = (await page.errors()).filter(e => !e.startsWith("console.error:"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /deliberate exception/);
  assert.ok(f1 > f0 + 10, `loop kept running (${f0} -> ${f1})`);
  await page.close();
});
