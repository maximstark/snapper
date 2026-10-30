// Snapper attach host (v1.4, BRIEF-v1.4 §2): Electron main process with NO game window. The page lives in a Chromium the user
// started with --remote-debugging-port; this process reaches it over a CDP WebSocket (cdp.mjs wsBackend) and runs the same
// capture pipeline as the play host (capture.mjs). Started by entry.mjs when SNAPPER_ATTACH_OPTS is set (cli-attach.mjs).
//
// What it does to the user's browser, exactly (TRUST.md "Attach mode"):
//   CDP domains Page, Runtime, Log (+ Browser.getVersion once); Runtime.addBinding "__snapperHostBinding";
//   Page.addScriptToEvaluateOnNewDocument x2 (the page script, the SDK); Page.startScreencast (not with --bare);
//   Page.reload once (not with --no-reload); Page.captureScreenshot per mark; Runtime.evaluate for the SDK reads and the overlay.
//   With --smoke only: Emulation.setFocusEmulationEnabled and Input.dispatchKeyEvent / Page.navigate (the script's own steps).
// It never changes browser flags, never closes the tab or the browser, and on the way out sends the page script a `dispose`.
import { app, Menu } from "electron";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir, release, version as osVersion } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionWriter, gitInfo, SNAPPER_VERSION } from "../../core/index.mjs";
import { createComposer } from "./compose.mjs";
import { isPackaged } from "./electron-bin.mjs";
import { wsBackend, browserVersion } from "./cdp.mjs";
import { createCapture } from "./capture.mjs";
import { NO_RELOAD_REASON, NO_ROOT_REASON, chromiumOf, splitPageUrl, markLineExtrasFor, hzFromIntervals } from "./attach-util.mjs";
import { ATTACH_BINDING, buildAttachScript, pageMessageExpression, parseBindingPayload } from "./attach-inject.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dbg = msg => { if (process.env.SNAPPER_DEBUG) try { process.stderr.write(`[dbg] ${msg}\n`); } catch {} };
const warn = msg => { try { process.stderr.write(`[snapper] ${msg}\n`); } catch {} };

const PAGE_INFO_EXPR = `(()=>{try{return JSON.stringify({href:location.href,title:document.title,sw:screen.width,sh:screen.height,dpr:devicePixelRatio,iw:innerWidth,ih:innerHeight,ua:navigator.userAgent,state:document.readyState})}catch(e){return null}})()`;
const HZ_EXPR = `new Promise(function(res){var a=[],last=0,n=0;function f(t){if(last)a.push(t-last);last=t;if(++n<40)requestAnimationFrame(f);else res(JSON.stringify(a))}requestAnimationFrame(f)})`;

export async function startAttach() {
  const OPTS = JSON.parse(process.env.SNAPPER_ATTACH_OPTS || "{}");
  const RESULT_FILE = process.env.SNAPPER_RESULT_FILE || null;
  const QUIT_FILE = RESULT_FILE ? RESULT_FILE + ".quit" : null;
  const writeResult = obj => { if (RESULT_FILE) try { writeFileSync(RESULT_FILE, JSON.stringify(obj)); } catch {} };

  // A throwaway profile for this process (the hidden compose window); the user's browser is never touched.
  const userData = join(tmpdir(), `snapper-attach-${process.pid}`);
  try { mkdirSync(userData, { recursive: true }); app.setPath("userData", userData); } catch {}
  process.on("uncaughtException", err => { warn(`uncaught in main: ${err && err.stack || err}`); });
  process.on("unhandledRejection", err => { warn(`unhandled rejection in main: ${err && err.stack || err}`); });
  app.on("window-all-closed", () => { /* no game window: stay alive until the session ends */ });

  try { await main(); }
  catch (err) {
    warn(`attach failed: ${err && err.message || err}`);
    writeResult({ session: null, ok: false, marks: 0, error: String(err && err.message || err), failures: [String(err && err.message || err)] });
    try { rmSync(userData, { recursive: true, force: true }); } catch {}
    app.exit(1);
  }

  async function main() {
    await app.whenReady();
    Menu.setApplicationMenu(null);
    const config = OPTS.config;
    const hk = config.hotkeys;
    const bare = config.bare === true;
    const reload = OPTS.reload !== false;

    // ---------------------------------------------------------------- connect
    const cdp = await wsBackend(OPTS.wsUrl);
    const call = (method, params) => { dbg("cdp> " + method); return cdp.send(method, params); };   // the host's own calls; the pipeline logs its own (capture.mjs)
    dbg("socket open");
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Log.enable");

    // ---------------------------------------------------------------- what the page and the browser are
    const evalValue = async (expression, ms = 5000, extra = {}) => {
      try {
        const r = await Promise.race([cdp.send("Runtime.evaluate", { expression, returnByValue: true, ...extra }), sleep(ms).then(() => null)]);
        return r && !r.exceptionDetails ? r.result.value : null;
      } catch { return null; }
    };
    let info = null;
    try { info = JSON.parse(await evalValue(PAGE_INFO_EXPR)); } catch {}
    info ||= { href: OPTS.target?.url || "", title: OPTS.target?.title || "", sw: null, sh: null, dpr: 1, iw: null, ih: null, ua: "", state: "" };
    let product = null, userAgent = info.ua || "";
    try {
      const v = await call("Browser.getVersion");
      product = v.product || null;
      userAgent = v.userAgent || userAgent;
    } catch { /* a page-level socket may not answer Browser.*: /json/version does */ }
    if (!product) {
      try {
        const u = new URL(OPTS.endpoint);
        const v = await browserVersion(`http://${u.host}`);
        product = v?.Browser || null;
        userAgent ||= v?.["User-Agent"] || "";
      } catch {}
    }
    let displayHz = null;
    try { displayHz = hzFromIntervals(JSON.parse(await evalValue(HZ_EXPR, 3000, { awaitPromise: true }))); } catch {}

    const { url: gameUrl, query } = splitPageUrl(info.href);
    const target = { url: info.href || OPTS.target?.url || "", title: info.title || OPTS.target?.title || "" };

    // ---------------------------------------------------------------- session
    const writer = await createSessionWriter({ out: OPTS.out, slug: OPTS.slug });
    writeResult({ session: writer.dir, ok: null, marks: 0 });
    writer.line("session", { v: 1, id: writer.id, game: OPTS.slug, url: gameUrl, query, snapper: SNAPPER_VERSION, startedAt: writer.startedAtIso }, 0);
    await writer.writeEnv({
      format: 1, snapper: SNAPPER_VERSION, startedAt: writer.startedAtIso,
      game: { slug: OPTS.slug, root: OPTS.root || null, url: gameUrl, query, git: OPTS.root ? gitInfo(OPTS.root) : null },
      host: {
        adapter: "cdp", chromium: chromiumOf(product), node: process.versions.node,
        platform: process.platform, arch: process.arch, os: `${osVersion()} ${release()}`,
        packaged: isPackaged(), bare,
        attach: { endpoint: OPTS.endpoint, target, browser: product, userAgent, reloaded: reload },
      },
      display: { w: info.sw, h: info.sh, dpr: info.dpr, hz: displayHz },
      window: { w: info.iw, h: info.ih },
      gpu: null,                                          // chrome://gpu is not reachable over CDP
      gamepads: [],
      sdk: { present: false },
      config,
    });
    dbg("env written");

    // ---------------------------------------------------------------- the pipeline
    const sdkPath = fileURLToPath(new URL("../../sdk/snapper.js", import.meta.url));
    const sdkSource = existsSync(sdkPath) ? readFileSync(sdkPath, "utf8") : null;
    if (!sdkSource) warn("packages/sdk/snapper.js not found: running without the SDK");
    const pageOpts = {
      hotkeys: hk, padMark: config.padMark, padMarkHoldMs: config.padMarkHoldMs, fpsDropMs: config.fpsDropMs,
      fpsDropRun: config.fpsDropRun, expectedMs: displayHz ? 1000 / displayHz : 0, bare,
      attach: true, inPageHotkeys: true,
    };
    const pageScript = buildAttachScript(pageOpts);

    const composer = createComposer();
    composer.warm();
    let capture = null, ending = null;
    const page = {
      /** host → page script: Runtime.evaluate of __snapperPage.msg(kind, data). */
      send(kind, data) {
        if (cdp.closed) return false;
        cdp.send("Runtime.evaluate", { expression: pageMessageExpression(kind, data), silent: true }).catch(() => {});
        return true;
      },
    };
    const scriptIds = [];
    const end = why => {
      if (ending) return ending;
      if (why) warn(`ending (${why}): saving the session`);
      ending = (async () => {
        const ok = await capture.finalize();
        composer.destroy();
        try { rmSync(userData, { recursive: true, force: true }); } catch {}
        app.exit(ok ? 0 : 1);
      })();
      return ending;
    };
    capture = createCapture({
      cdp, page, writer, config, composer, displayHz, warn, dbg, res: null, adapter: "cdp", baseUrl: gameUrl, query,
      smokePath: OPTS.smoke || null, writeResult,
      markLineExtras: markLineExtrasFor({ reload, root: OPTS.root, url: gameUrl }),
      hooks: {
        endSession: () => end("smoke finished"),
        onClosed: reason => { if (!capture.finalizing) end(`browser connection closed: ${reason}`); },
        async beforeDetach() {
          if (cdp.closed) return;
          await call("Runtime.evaluate", { expression: pageMessageExpression("dispose"), silent: true }).catch(() => {});
          for (const id of scriptIds) await call("Page.removeScriptToEvaluateOnNewDocument", { identifier: id }).catch(() => {});
          if (OPTS.smoke) await call("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
        },
      },
    });

    // page → host: the binding (one JSON string per call)
    cdp.on("Runtime.bindingCalled", p => {
      if (!p || p.name !== ATTACH_BINDING) return;
      const m = parseBindingPayload(p.payload);
      if (!m) return;
      if (m.type === "tape") capture.onTape(m.frames, m.masks, m.count);
      else capture.onPage(m.kind, m.data);
    });
    // the binding is per execution context: re-add it when the contexts were cleared (a reload, a navigation)
    cdp.on("Runtime.executionContextsCleared", () => { cdp.send("Runtime.addBinding", { name: ATTACH_BINDING }).catch(() => {}); });
    // the browser's navigation events feed the pipeline
    cdp.on("Page.frameNavigated", p => {
      const f = p && p.frame;
      if (!f || f.parentId) return;
      capture.nav.start(f.url);
      if (f.unreachableUrl) capture.nav.fail("the page could not be loaded", "unreachable", f.unreachableUrl);
    });
    cdp.on("Page.loadEventFired", () => capture.nav.finish());

    // Ctrl+C: cli-attach writes the quit file; a signal reaching Electron directly does the same
    if (QUIT_FILE) setInterval(() => { if (existsSync(QUIT_FILE)) end("Ctrl+C"); }, 200).unref?.();
    for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) { try { process.on(sig, () => end(sig)); } catch {} }

    // ---------------------------------------------------------------- inject
    // Subscribe after the domains are enabled: Runtime.enable and Log.enable replay what the page logged before we came.
    capture.connect();
    await call("Runtime.addBinding", { name: ATTACH_BINDING });          // BEFORE the script that calls it
    scriptIds.push((await call("Page.addScriptToEvaluateOnNewDocument", { source: pageScript })).identifier);
    if (sdkSource) scriptIds.push((await call("Page.addScriptToEvaluateOnNewDocument", { source: sdkSource })).identifier);
    if (OPTS.smoke) await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});   // smoke keys reach an unfocused page
    if (!bare) await capture.startScreencast();
    capture.setLive(true);
    dbg("injected");
    if (reload) {
      // The game's boot already ran without the SDK: reload once so registerState/registerStepper run; the tape starts there.
      await call("Page.reload", {});
    } else {
      // Passive capture: into the document that is open now (no reload, so providers the game registered earlier are missing).
      await call("Runtime.evaluate", { expression: pageScript, silent: true });
      if (sdkSource) await call("Runtime.evaluate", { expression: sdkSource, silent: true });
      capture.nav.adoptCurrent();
    }
  }
}
