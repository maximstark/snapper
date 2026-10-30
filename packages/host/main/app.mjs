// Snapper host: Electron main process (ESM). Started by cli-play.mjs with SNAPPER_OPTS (JSON) and
// SNAPPER_RESULT_FILE in the environment. See BRIEF §4.1 and D-008, D-012 … D-017.
// v1.4: the capture pipeline moved to capture.mjs (shared with the attach host, which reaches a page over a CDP WebSocket).
// This file keeps what is play-only: the window and its preload, the static server, the throwaway profile, the keyboard
// hotkeys (before-input-event), Electron's navigation events, the GPU query and the close sequence.
import { app, BrowserWindow, screen, ipcMain, Menu, shell } from "electron";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir, release, version as osVersion } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSessionWriter, serveStatic, gitInfo, PRESETS, SNAPPER_VERSION, addQueryParam, zipDir,
} from "../../core/index.mjs";
import {
  readTesterFile, writeTesterFile, outboxName, testerHint, testerNameTitle, sendLine, TESTER_NOTE_TITLE,
} from "./helpers.mjs";
import { createComposer } from "./compose.mjs";
import { loadResume } from "./resume.mjs";
import { isPackaged } from "./electron-bin.mjs";
import { debuggerBackend } from "./cdp.mjs";
import { createCapture } from "./capture.mjs";

const OPTS = JSON.parse(process.env.SNAPPER_OPTS || "{}");
const RESULT_FILE = process.env.SNAPPER_RESULT_FILE || null;
const QUIT_FILE = RESULT_FILE ? RESULT_FILE + ".quit" : null;    // cli-play writes it on Ctrl+C (D-021)
const dbg = msg => { if (process.env.SNAPPER_DEBUG) try { process.stderr.write(`[dbg] ${msg}
`); } catch {} };
const warn = msg => { try { process.stderr.write(`[snapper] ${msg}\n`); } catch {} };

let lastResult = null;                                     // what the pipeline wrote last (tester mode adds `outbox` to it)
const writeResult = obj => {
  lastResult = obj;
  if (!RESULT_FILE) return;
  try { writeFileSync(RESULT_FILE, JSON.stringify(obj)); } catch {}
};

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");   // smokes run behind other windows
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const userData = join(tmpdir(), `snapper-host-${process.pid}`);
try { mkdirSync(userData, { recursive: true }); app.setPath("userData", userData); } catch {}

process.on("uncaughtException", err => { warn(`uncaught in main: ${err && err.stack || err}`); });
process.on("unhandledRejection", err => { warn(`unhandled rejection in main: ${err && err.stack || err}`); });

main().catch(err => {
  warn(`fatal: ${err && err.stack || err}`);
  writeResult({ session: null, ok: false, marks: 0, error: String(err && err.message || err) });
  app.exit(1);
});

async function main() {
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const config = OPTS.config;
  const hk = config.hotkeys;

  // ------------------------------------------------------------------ game URL (static server in this process)
  let server = null, baseUrl;
  if (OPTS.target.kind === "dir") {
    server = await serveStatic(OPTS.target.value, { coi: config.crossOriginIsolated === true });   // --coi (v1.3)
    baseUrl = `${server.url}/index.html`;
  } else baseUrl = OPTS.target.value;
  let query = config.query || "";

  // ------------------------------------------------------------------ resume (D-021): source tape + checkpoint, boot paused
  // D-022: the restore boots with the query of the segment the checkpoint is in (or the explicit --query override).
  let RES = null;
  if (OPTS.resume) {
    RES = await loadResume(OPTS.resume);
    query = RES.query;
  }
  let fullUrl = baseUrl + (query && baseUrl.includes("?") && query.startsWith("?") ? "&" + query.slice(1) : query);
  if (RES) fullUrl = addQueryParam(fullUrl, RES.pauseParam || "paused");
  const resumedFrom = RES ? { session: RES.sessionId, checkpoint: RES.checkpoint, frame: RES.frame } : null;

  // ------------------------------------------------------------------ window
  const primary = screen.getPrimaryDisplay();
  let presetName = config.preset in PRESETS ? config.preset : "1080p";
  if (presetName !== config.preset) warn(`unknown preset "${config.preset}", using 1080p`);
  const size = PRESETS[presetName] || { w: primary.size.width, h: primary.size.height };
  const startFullscreen = presetName === "native" || !!OPTS.fullscreen;

  const sdkPath = fileURLToPath(new URL("../../sdk/snapper.js", import.meta.url));
  const sdkSource = existsSync(sdkPath) ? readFileSync(sdkPath, "utf8") : null;
  if (!sdkSource) warn("packages/sdk/snapper.js not found: running without the SDK");

  const winBounds = { width: size.w, height: size.h };
  const hzGuess = screen.getDisplayNearestPoint({ x: 0, y: 0 }).displayFrequency || primary.displayFrequency || 0;
  const preloadOpts = {
    hotkeys: hk, padMark: config.padMark, padMarkHoldMs: config.padMarkHoldMs, fpsDropMs: config.fpsDropMs,
    fpsDropRun: config.fpsDropRun, expectedMs: hzGuess ? 1000 / hzGuess : 0,
    bare: config.bare === true,                          // v1.3: no overlay chip, no 250 ms timer, no F9 panel
  };
  const bare = config.bare === true;
  const win = new BrowserWindow({
    ...winBounds, useContentSize: true, backgroundColor: "#000000", autoHideMenuBar: true, show: true,
    fullscreen: startFullscreen, title: `Snapper · ${OPTS.slug}`,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/preload.cjs", import.meta.url)),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      additionalArguments: [`--snapper-opts=${encodeURIComponent(JSON.stringify(preloadOpts))}`],
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.removeMenu();
  const wc = win.webContents;
  const disp = screen.getDisplayMatching(win.getBounds());
  const displayHz = disp.displayFrequency || null;
  const [cw, ch] = win.getContentSize();

  // ------------------------------------------------------------------ session
  const writer = await createSessionWriter({ out: OPTS.out, slug: OPTS.slug });
  writeResult({ session: writer.dir, ok: null, marks: 0 });
  const git = gitInfo(OPTS.root);
  writer.line("session", {
    v: 1, id: writer.id, game: OPTS.slug, url: baseUrl, query, snapper: SNAPPER_VERSION, startedAt: writer.startedAtIso,
    ...(resumedFrom ? { resumedFrom } : {}),
  }, 0);
  await writer.writeEnv({
    format: 1, snapper: SNAPPER_VERSION, startedAt: writer.startedAtIso,
    game: { slug: OPTS.slug, root: OPTS.root, url: baseUrl, query, ...(RES?.queryOverride ? { queryOverride: true } : {}), git },
    host: {
      adapter: "electron", electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
      platform: process.platform, arch: process.arch, os: `${osVersion()} ${release()}`,
      packaged: isPackaged(), exe: process.execPath, bare,
    },
    display: { w: disp.size.width, h: disp.size.height, dpr: disp.scaleFactor, hz: displayHz },
    window: { preset: presetName, w: cw, h: ch, fullscreen: startFullscreen },
    gpu: null,
    gamepads: [],
    sdk: { present: false },
    config,
    ...(resumedFrom ? { resumedFrom: { ...resumedFrom, dir: RES.session } } : {}),
  });
  dbg("env written");

  // ------------------------------------------------------------------ tester mode (v1.4, BRIEF-v1.4 §3.2)
  // The kit folder is the parent of the game root: <kit>/game, <kit>/tester.json, <kit>/outbox/. Nothing here touches the network.
  const tester = config.tester === true;
  const developer = typeof config.developer === "string" && config.developer.trim() ? config.developer.trim() : "the developer";
  const kitDir = dirname(OPTS.root);
  let testerName = null, nameWanted = false, readyAt = 0;
  if (tester) {
    const t = readTesterFile(kitDir);
    if (t) { testerName = t.name; writer.patchEnv({ tester: { name: testerName } }); }
    else nameWanted = true;                                  // asked after ready; Esc skips and the next run asks again
  }
  const HINT_MS = 10000;
  const askName = () => { if (nameWanted) page.send("name", { title: testerNameTitle(developer) }); };
  const sendHint = () => {
    const left = HINT_MS - (Date.now() - readyAt);
    if (left < 500) return;
    const text = testerHint(hk.mark);
    if (bare) page.send("toast", { text, ms: left }); else page.send("hint", { text, ms: left });
  };
  function onTesterName(text) {
    if (!tester || !nameWanted) return;
    nameWanted = false;
    let doc = null;
    try { doc = writeTesterFile(kitDir, text); } catch (err) { warn(`cannot write tester.json: ${err.message}`); }
    if (doc) { testerName = doc.name; writer.patchEnv({ tester: { name: testerName } }); }
  }
  /** Zip the finished session into <kit>/outbox and tell the tester where it is. Never throws. */
  async function packOutbox() {
    let file = null;
    try {
      const outDir = join(kitDir, "outbox");
      mkdirSync(outDir, { recursive: true });
      file = join(outDir, outboxName(OPTS.slug, writer.id));
      await zipDir(writer.dir, file, { prefix: `${writer.id}/`, exclude: rel => rel === "outbox" || rel.startsWith("outbox/") });
    } catch (err) {
      warn(`cannot write the outbox zip: ${err && err.message || err}`);
      file = null;
    }
    if (file && lastResult) writeResult({ ...lastResult, outbox: file });
    const text = file ? sendLine(developer, relative(kitDir, file)) : `Could not pack your session. Send this folder to ${developer}: ${writer.dir}`;
    page.send("mode", 0);
    page.send("toast", { text, ms: 6000 });
    if (!OPTS.smoke) await new Promise(r => setTimeout(r, 2200));
    if (file && !OPTS.smoke && process.env.SNAPPER_NO_SHELL !== "1") { try { shell.showItemInFolder(file); } catch {} }
    return file;
  }
  app.getGPUInfo("basic").then(info => {
    const dev = (info.gpuDevice || []).find(d => d.active) || (info.gpuDevice || [])[0] || {};
    const gl = info.auxAttributes?.glRenderer;
    const name = gl || dev.deviceString || (dev.vendorId ? `vendor 0x${dev.vendorId.toString(16)} device 0x${(dev.deviceId || 0).toString(16)}` : null);
    if (name) writer.patchEnv({ gpu: String(name) });
  }).catch(() => {});

  // ------------------------------------------------------------------ the CDP interface (the debugger of this window)
  // The Page domain only answers once a document exists, so commit about:blank first (the game URL is
  // still loaded after the debugger and the SDK injection are in place).
  dbg("cdp attach");
  await wc.loadURL("about:blank");
  const cdp = debuggerBackend(wc);

  // ------------------------------------------------------------------ the capture pipeline (capture.mjs)
  const composer = createComposer();
  composer.warm();
  let capture = null;
  const page = {
    /** host → preload (the overlay, the asks). False when the window is gone. */
    send(kind, data) {
      try { if (wc.isDestroyed()) return false; wc.send("snapper:m", kind, data); return true; } catch { return false; }
    },
  };
  capture = createCapture({
    cdp, page, writer, config, composer, displayHz, warn, dbg, res: RES, adapter: "electron", baseUrl, query,
    smokePath: OPTS.smoke || null, writeResult,
    hooks: {
      focus: () => { try { wc.focus(); } catch {} },
      setMuted: m => { try { wc.setAudioMuted(m); } catch {} },
      fullscreen: () => win.setFullScreen(!win.isFullScreen()),
      endSession: () => win.close(),
      ...(tester ? {
        noteTitle: TESTER_NOTE_TITLE,
        onReady: () => { readyAt = Date.now(); sendHint(); askName(); },
        onHello: () => { if (readyAt) { sendHint(); askName(); } },     // the page script restarted (F5): show them again
        onPageKind: (kind, d) => { if (kind === "tester-name") onTesterName(String(d && d.text || "")); },
      } : {}),
    },
  });
  const host = capture.host;
  host.wc = wc; host.win = win;

  // preload / bridge messages
  ipcMain.on("snapper:tape", (e, frames, masks, count) => {
    if (e.sender !== wc) return;
    capture.onTape(frames, masks, count);
  });
  ipcMain.on("snapper:p", (e, kind, data) => {
    if (e.sender !== wc) return;
    capture.onPage(kind, data);
  });

  // ------------------------------------------------------------------ hotkeys (before-input-event)
  /** Host hotkeys by KeyboardEvent.code. True when the key belongs to the host (the page must not see it). */
  function hostKey(code, { control = false, alt = false } = {}) {
    const names = Object.keys(hk).filter(n => hk[n] === code);
    if (names.length && !control && !alt) { capture.hotkey(names[0]); return true; }
    if (code === "F12") { wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: "detach" }); return true; }
    if (code === "F5" || (control && code === "KeyR")) { wc.reload(); return true; }
    return false;
  }
  host.hostKey = hostKey;
  host.isHostKey = code => Object.values(hk).includes(code) || code === "F12" || code === "F5";
  wc.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && !input.isAutoRepeat && hostKey(input.code, { control: input.control, alt: input.alt })) event.preventDefault();
    else if (input.type === "keyUp" && (Object.values(hk).includes(input.code) || input.code === "F12" || input.code === "F5")) event.preventDefault();
  });

  // ------------------------------------------------------------------ navigation (Electron's events feed the pipeline)
  wc.on("did-start-navigation", details => {
    if (!details.isMainFrame || details.isSameDocument) return;
    capture.nav.start(details.url);
  });
  wc.on("did-finish-load", () => capture.nav.finish());
  wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    capture.nav.fail(desc, code, url);
  });
  wc.on("render-process-gone", (_e, d) => capture.nav.gone(d.reason, d.exitCode));
  wc.setWindowOpenHandler(() => ({ action: "deny" }));

  // ------------------------------------------------------------------ close
  win.on("close", e => {
    if (capture.finalizing) return;
    e.preventDefault();
    capture.finalize().then(async ok => {
      if (tester) { try { await packOutbox(); } catch (err) { warn(`outbox: ${err && err.message || err}`); } }
      composer.destroy();
      server?.close().catch?.(() => {});
      try { win.destroy(); } catch {}
      try { rmSync(userData, { recursive: true, force: true }); } catch {}
      app.exit(ok ? 0 : 1);
    });
  });

  // Ctrl+C in the terminal: cli-play writes QUIT_FILE; a signal reaching Electron directly does the same.
  const quit = why => { if (!capture.finalizing) { warn(`closing (${why}): saving the exit state`); try { win.close(); } catch {} } };
  if (QUIT_FILE) setInterval(() => { if (existsSync(QUIT_FILE)) quit("Ctrl+C"); }, 200).unref?.();
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) { try { process.on(sig, () => quit(sig)); } catch {} }

  // ------------------------------------------------------------------ start: CDP before the game loads
  capture.connect();
  await host.cdp("Page.enable");
  await host.cdp("Runtime.enable");
  await host.cdp("Log.enable");
  await host.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  if (sdkSource) await host.cdp("Page.addScriptToEvaluateOnNewDocument", { source: sdkSource });
  if (!bare) await capture.startScreencast();

  dbg("cdp enabled");
  capture.setLive(true);
  wc.loadURL(fullUrl).catch(() => { /* did-fail-load handles it */ });
}
