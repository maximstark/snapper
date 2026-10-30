// The page driver of the replay runner (BRIEF-v1.2 §2, D-025): a hidden Electron window driven over CDP.
// Electron main process only (it imports "electron"); plain-Node code must reach it through a dynamic import.
//
// Why this shape (spike, sessions/spike-v12): a hidden window (show:false, backgroundThrottling:false) boots a game,
// reports its stepper and steps fine, but CDP Page.captureScreenshot HANGS on it, so page screenshots go through
// webContents.capturePage(). offscreen:true is the documented fallback for a game that misbehaves hidden.
import { BrowserWindow, screen } from "electron";
import { createComposer } from "../main/compose.mjs";

const MAX_PAGE_ERRORS = 10;
const MAX_CONSOLE = 200;
const STEPPER_PROBE = "(()=>{try{return globalThis.snapper.__host.ready().stepper===true}catch(e){return false}})()";

const argText = a => {
  if (!a) return "";
  if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  return a.unserializableValue ?? a.description ?? a.type ?? "";
};
const consoleText = args => (args || []).map(argText).join(" ");

/**
 * Create a driver: a hidden (or `headed`) BrowserWindow with the debugger attached and the Page and Runtime domains
 * enabled, on about:blank. The caller adds init scripts, then navigates. Call after app.whenReady().
 */
export async function createElectronDriver({ width = 1280, height = 720, headed = false, timeoutMs = 60000 } = {}) {
  const win = new BrowserWindow({
    show: headed, width, height, useContentSize: true, skipTaskbar: !headed, backgroundColor: "#000000", autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const pageErrors = [];
  const consoleLog = [];
  let composer = null, closed = false;

  const cdp = (method, params = {}) => wc.debugger.sendCommand(method, params);

  await win.loadURL("about:blank");
  wc.debugger.attach("1.3");
  wc.debugger.on("message", (_e, method, params) => {
    try {
      if (method === "Runtime.exceptionThrown") {
        const d = params?.exceptionDetails;
        if (pageErrors.length < MAX_PAGE_ERRORS) pageErrors.push(String(d?.exception?.description || d?.text || "uncaught exception"));
      } else if (method === "Runtime.consoleAPICalled") {
        const text = consoleText(params.args);
        if (consoleLog.length < MAX_CONSOLE) consoleLog.push({ type: params.type, text });
        if (params.type === "error" && pageErrors.length < MAX_PAGE_ERRORS) pageErrors.push(`console.error: ${text}`);
      }
    } catch {}
  });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  // Like the play host: a hidden window still gets key events and focus-dependent code runs.
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});

  const evaluate = async expression => {
    const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.exception?.value || d.text || "evaluate failed");
    }
    return r.result?.value;
  };

  const bounds = win.getBounds();
  const [cw, ch] = win.getContentSize();
  let dpr = 1;
  try { dpr = screen.getDisplayMatching(bounds).scaleFactor || 1; } catch {}

  return {
    engine: "electron",
    version: process.versions.chrome,
    dpr,
    size: { w: cw, h: ch },
    pageErrors,
    console: consoleLog,

    addInitScript: source => cdp("Page.addScriptToEvaluateOnNewDocument", { source }).then(() => {}),

    goto(url) {
      return new Promise((resolve, reject) => {
        let done = false, timer = null;
        const finish = (fn, v) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          wc.removeListener("did-finish-load", onLoad);
          wc.removeListener("did-fail-load", onFail);
          fn(v);
        };
        const onLoad = () => finish(resolve);
        const onFail = (_e, code, desc, failedUrl, isMainFrame) => {
          if (code === -3 || isMainFrame === false) return;
          finish(reject, new Error(`navigation to ${failedUrl || url} failed: ${desc} (${code})`));
        };
        wc.on("did-finish-load", onLoad);
        wc.on("did-fail-load", onFail);
        timer = setTimeout(() => finish(reject, new Error(`navigation to ${url} did not load within ${timeoutMs / 1000} s`)), timeoutMs);
        cdp("Page.navigate", { url }).then(
          r => { if (r?.errorText) finish(reject, new Error(`navigation to ${url} failed: ${r.errorText}`)); },
          e => finish(reject, e),
        );
      });
    },

    async waitForStepper(ms) {
      const end = Date.now() + ms;
      for (;;) {
        let ok = false;
        try { ok = (await evaluate(STEPPER_PROBE)) === true; } catch {}
        if (ok) return;
        if (Date.now() >= end) throw new Error(`no stepper within ${ms} ms`);
        await new Promise(r => setTimeout(r, 100));
      }
    },

    evaluate,

    async screenshot() {
      const img = await wc.capturePage();
      return img.toPNG();
    },

    async composeSheet(tiles, { columns = 6 } = {}) {
      if (!composer) composer = createComposer();
      const out = await composer.compose(tiles, 60000, { columns, tileW: 320 });
      return out?.sheet ?? null;
    },

    cdp,

    async close() {
      if (closed) return;
      closed = true;
      try { composer?.destroy(); } catch {}
      try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
      try { if (!win.isDestroyed()) win.destroy(); } catch {}
    },
  };
}
