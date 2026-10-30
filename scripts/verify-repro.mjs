// Gate Z6 (v1.4, BRIEF-v1.4 §5.4): the no-Snapper repro.
//   node scripts/verify-repro.mjs [--session <demo session dir>]      (EVIDENCE=1 → private/evidence/v1.4/z6/)
// 1. A demo session (recorded with the demo smoke unless --session is given); `snapper export-repro <s> 0001 --inject`
//    (and 0005, the mark after the deliberate faults); `snapper serve` serves repro-game/.
// (a) a plain Electron window with NO Snapper (no SDK injection, no preload, no CDP: the Y3 harness) opens
//     index.html?paused&snapper-repro=1 → window.__snapperRepro.result.status "match" at the mark frame.
// (b) Microsoft Edge headless (when installed), its own throwaway profile: the same URL; the harness reads the page's
//     <pre id="snapper-repro"> over the DevTools protocol (Edge's --dump-dom prints nothing to a pipe on this machine,
//     tested 2026-10-21; the page itself runs with no Snapper host) → "REPRO: match"; a screenshot of it is the evidence.
// (c) a modified copy of the demo (SPEED 2 → 2.5) with the repro folder placed under it by the README's console method
//     (repro/ + the SDK tag + the driver tag) → "differs" with a first path under $.player.
// (e) Firefox headless (when installed), WebDriver BiDi, its own throwaway profile → "match" (bonus: the driver runs in Firefox).
// The packaged `snapper.cmd export-repro` with Node off PATH is in verify-exe.mjs (X3, part d).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { REPO, snapper, checklist, exists } from "./lib.mjs";
import { electronCommand, electronChildEnv } from "../packages/host/main/electron-bin.mjs";
import { wsBackend, listTargets } from "../packages/host/main/cdp.mjs";
import { injectTags } from "../packages/host/tools/export-repro.mjs";

const EVIDENCE = process.env.EVIDENCE === "1";
const EV = join(REPO, "private", "evidence", process.env.EVIDENCE_VERSION || "v1.4", "z6");
const OUT = join(REPO, "sessions", "z6");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const FIREFOX = "C:/Program Files/Mozilla Firefox/firefox.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const c = checklist("Z6 no-Snapper repro");
const record = { at: new Date().toISOString(), runs: {} };
const tmp = mkdtempSync(join(tmpdir(), "snapper-z6-"));

const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const flag = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

/** `snapper serve <dir>` as a child; resolves { url, stop() }. */
async function serve(dir) {
  const child = spawn(process.execPath, [join(REPO, "bin", "snapper.mjs"), "serve", dir], { env: { ...process.env, SNAPPER_SERVE_STDIN: "1" }, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  const url = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("snapper serve printed no URL")), 15000);
    child.stdout.on("data", d => { out += d; const m = /at (http:\/\/127\.0\.0\.1:\d+)\//.exec(out); if (m) { clearTimeout(t); res(m[1]); } });
    child.on("exit", code => rej(new Error(`snapper serve exited ${code}: ${out}`)));
  });
  return { url, stop: () => new Promise(r => { child.on("exit", r); child.stdin.end(); setTimeout(() => { try { child.kill(); } catch {} r(); }, 3000); }) };
}

// (a) A throwaway Electron main: no preload, no SDK, no debugger; a visible window (rAF never throttled), a private userData.
const PLAIN_MAIN = `
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
app.setPath("userData", process.env.Z6_USERDATA);
const out = process.env.Z6_OUT, url = process.env.Z6_URL;
const result = { errors: [], repro: null, pre: null, bridge: null };
const finish = code => { try { writeFileSync(out, JSON.stringify(result)); } catch {} app.exit(code); };
app.whenReady().then(async () => {
  const win = new BrowserWindow({ x: 60, y: 60, width: 640, height: 360, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.on("console-message", (...a) => { const ev = a[0] || {}; const lvl = ev.level ?? a[1]; const msg = ev.message ?? a[2]; if (lvl === "error" || lvl === 3) result.errors.push(String(msg).slice(0, 300)); });
  win.showInactive();
  await win.loadURL(url).catch(e => result.errors.push("loadURL: " + e.message));
  for (let i = 0; i < 300; i++) {
    const r = await win.webContents.executeJavaScript("JSON.stringify({ r: window.__snapperRepro || null, pre: (document.getElementById('snapper-repro') || {}).textContent || null, bridge: typeof window.__snapperBridge, host: typeof window.__snapperHostBinding })");
    const v = JSON.parse(r);
    if (v.r && v.r.done) { result.repro = v.r; result.pre = v.pre; result.bridge = v.bridge + "/" + v.host; break; }
    await new Promise(res => setTimeout(res, 100));
  }
  finish(0);
}).catch(e => { result.errors.push("main: " + (e && e.message)); finish(4); });
setTimeout(() => finish(3), 60000);
`;

async function plainElectron(url, name) {
  const main = join(tmp, "plain-main.mjs");
  await writeFile(main, PLAIN_MAIN);
  const outFile = join(tmp, `${name}.json`);
  const userData = mkdtempSync(join(tmp, "ud-"));
  const { exe } = electronCommand();
  const code = await new Promise(res => {
    const child = spawn(exe, [main], { env: electronChildEnv({ Z6_USERDATA: userData, Z6_URL: url, Z6_OUT: outFile, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" }), stdio: ["ignore", "ignore", "inherit"] });
    const t = setTimeout(() => child.kill(), 90000);
    child.on("exit", code => { clearTimeout(t); res(code); });
  });
  let result = null;
  try { result = JSON.parse(await readFile(outFile, "utf8")); } catch {}
  return { code, result };
}

/** (b) Edge headless with its own profile, read over CDP. */
async function edgeRun(url) {
  const port = await freePort();
  const prof = mkdtempSync(join(tmp, "edge-"));
  const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=960,540", url], { stdio: "ignore" });
  const out = { version: null, repro: null, pre: null, shot: null, error: null };
  let cdp = null;
  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i++) { await sleep(250); try { page = (await listTargets(`http://127.0.0.1:${port}`)).find(t => t.url.startsWith(url.split("?")[0])); } catch {} }
    if (!page) throw new Error("Edge listed no page with the repro URL");
    cdp = await wsBackend(page.webSocketDebuggerUrl);
    try { out.version = (await cdp.send("Browser.getVersion")).product; } catch {}
    for (let i = 0; i < 300; i++) {
      const r = await cdp.send("Runtime.evaluate", { expression: "JSON.stringify({ r: window.__snapperRepro || null, pre: (document.getElementById('snapper-repro') || {}).textContent || null, bridge: typeof window.__snapperBridge })", returnByValue: true });
      const v = JSON.parse(r.result.value);
      if (v.r && v.r.done) { out.repro = v.r; out.pre = v.pre; out.bridge = v.bridge; break; }
      await sleep(100);
    }
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    out.shot = Buffer.from(shot.data, "base64");
    try { await cdp.send("Browser.close"); } catch {}
  } catch (e) { out.error = e.message; }
  finally {
    try { await cdp?.detach(); } catch {}
    await new Promise(r => { if (edge.exitCode !== null) return r(); edge.on("exit", r); setTimeout(() => { try { edge.kill(); } catch {} r(); }, 5000); });
    await sleep(1000);
    try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
  return out;
}

/** (e) Firefox headless over WebDriver BiDi, its own profile. */
async function firefoxRun(url) {
  const port = await freePort();
  const prof = mkdtempSync(join(tmp, "ff-"));
  const ff = spawn(FIREFOX, ["-headless", "-no-remote", "-profile", prof, "--remote-debugging-port", String(port), "about:blank"], { stdio: "ignore" });
  const out = { version: null, repro: null, error: null };
  let ws = null;
  try {
    for (let i = 0; i < 60 && !ws; i++) {
      await sleep(500);
      try { ws = await new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}/session`); w.onopen = () => res(w); w.onerror = () => rej(new Error("ws")); }); } catch {}
    }
    if (!ws) throw new Error("no WebDriver BiDi endpoint");
    let id = 0;
    const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const sess = await send("session.new", { capabilities: {} });
    out.version = `${sess.result?.capabilities?.browserName} ${sess.result?.capabilities?.browserVersion}`;
    const ctx = (await send("browsingContext.getTree", {})).result.contexts[0].context;
    await send("browsingContext.navigate", { context: ctx, url, wait: "complete" });
    for (let i = 0; i < 300; i++) {
      const r = await send("script.evaluate", { expression: "JSON.stringify(window.__snapperRepro || null)", target: { context: ctx }, awaitPromise: false });
      const v = r.result?.result?.value ? JSON.parse(r.result.result.value) : null;
      if (v?.done) { out.repro = v; break; }
      await sleep(100);
    }
    await send("browser.close", {});
  } catch (e) { out.error = e.message; }
  finally {
    try { ws?.close(); } catch {}
    await new Promise(r => { if (ff.exitCode !== null) return r(); ff.on("exit", r); setTimeout(() => { try { ff.kill(); } catch {} r(); }, 5000); });
    await sleep(1000);
    try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
  return out;
}

try {
  // 1. the session and the export
  let session = flag("--session");
  if (!session) {
    const rec = await snapper(["play", "examples/demo", "--smoke", "examples/demo/smoke.json", "--out", join(OUT, "rec")], { echo: false });
    c.check("a demo session recorded with the demo smoke", rec.code === 0 && rec.last?.ok === true, `exit ${rec.code} ${rec.lastLine.slice(0, 160)}`);
    session = rec.last?.session;
  }
  if (!session || !(await exists(join(session, "session.jsonl")))) throw new Error(`no session: ${session}`);
  record.session = session;

  for (const mark of ["0001", "0005"]) {
    const ex = await snapper(["export-repro", session, mark, "--inject"], { echo: false });
    const dir = ex.lastLine.trim();
    c.check(`${mark}: export-repro --inject exits 0 and prints the folder`, ex.code === 0 && existsSync(join(dir, "tape.json")), `exit ${ex.code} ${dir} ${ex.code ? ex.stderr.slice(-300) : ""}`);
    const files = ["snapper-sdk.js", "driver.js", "tape.json", "expected.json", "README.md", "repro-game/index.html", "repro-game/repro/driver.js", "repro-game/repro/tape.json"];
    const missing = files.filter(f => !existsSync(join(dir, ...f.split("/"))));
    c.check(`${mark}: the folder holds ${files.join(", ")}`, !missing.length, missing.length ? `missing ${missing}` : "all present");
    const sdkSame = (await readFile(join(dir, "snapper-sdk.js"), "utf8")) === (await readFile(join(REPO, "packages", "sdk", "snapper.js"), "utf8"));
    c.check(`${mark}: snapper-sdk.js is the SDK byte for byte`, sdkSame);
    const html = await readFile(join(dir, "repro-game", "index.html"), "utf8");
    c.check(`${mark}: repro-game/index.html loads the SDK and the driver before the game's module`,
      html.indexOf('src="repro/snapper-sdk.js"') >= 0 && html.indexOf('src="repro/driver.js"') < html.indexOf('src="./game.js"'), "");
    const tape = JSON.parse(await readFile(join(dir, "tape.json"), "utf8"));
    const srv = await serve(join(dir, "repro-game"));
    const url = `${srv.url}/index.html${tape.openQuery}`;
    const run = (record.runs[mark] = { dir, markFrame: tape.markFrame, url });
    try {
      // (a)
      const a = await plainElectron(url, `plain-${mark}`);
      run.electron = a.result;
      const ra = a.result?.repro?.result;
      c.check(`(a) ${mark}: a plain Electron window with no Snapper host says match at frame ${tape.markFrame}`,
        a.code === 0 && ra?.status === "match" && ra.frame === tape.markFrame && a.result.bridge === "undefined/undefined" && /^REPRO: match at frame \d+/.test(a.result.pre || ""),
        a.result ? `status ${ra?.status} frame ${ra?.frame} pre "${a.result.pre}" bridge/binding ${a.result.bridge} errors ${JSON.stringify(a.result.errors)}${ra?.message ? " " + ra.message : ""}` : `exit ${a.code}, no result`);
      // (b)
      if (existsSync(EDGE)) {
        const b = await edgeRun(url);
        run.edge = { version: b.version, repro: b.repro, pre: b.pre, bridge: b.bridge, error: b.error };
        c.check(`(b) ${mark}: Edge headless prints REPRO: match in the page`, b.repro?.result?.status === "match" && /^REPRO: match at frame/.test(b.pre || "") && b.bridge === "undefined",
          `${b.version} pre "${b.pre}" bridge ${b.bridge}${b.error ? " error " + b.error : ""}`);
        if (EVIDENCE && b.shot && mark === "0001") { await mkdir(EV, { recursive: true }); await writeFile(join(EV, "edge-headless-0001.png"), b.shot); }
      } else c.check(`(b) ${mark}: Edge headless`, true, "SKIPPED: Edge not installed");
      // (e)
      if (existsSync(FIREFOX)) {
        const e = await firefoxRun(url);
        run.firefox = e;
        c.check(`(e) ${mark}: Firefox headless (WebDriver BiDi) says match`, e.repro?.result?.status === "match" && e.repro.result.frame === tape.markFrame,
          `${e.version} ${e.repro?.line ?? ""}${e.error ? " error " + e.error : ""}`);
      }
    } finally { await srv.stop(); }
    if (EVIDENCE && mark === "0001") {
      await mkdir(EV, { recursive: true });
      for (const f of ["README.md", "tape.json", "expected.json"]) await copyFile(join(dir, f), join(EV, `0001-${f}`));
    }
  }

  // (c) a changed copy, the console method: repro/ under the root, the SDK and driver tags, open ?paused&snapper-repro=1
  const changed = join(tmp, "demo-changed");
  await cp(join(REPO, "examples", "demo"), changed, { recursive: true, filter: s => !s.includes(".snapper") });
  const gsrc = await readFile(join(changed, "game.js"), "utf8");
  await writeFile(join(changed, "game.js"), gsrc.replace("SPEED = 2,", "SPEED = 2.5,"));
  await cp(record.runs["0001"].dir, join(changed, "repro"), { recursive: true, filter: s => !s.includes("repro-game") });
  await writeFile(join(changed, "index.html"), injectTags(await readFile(join(changed, "index.html"), "utf8")));
  const srvC = await serve(changed);
  try {
    const tape = JSON.parse(await readFile(join(changed, "repro", "tape.json"), "utf8"));
    const cRun = await plainElectron(`${srvC.url}/index.html${tape.openQuery}`, "plain-changed");
    const rc = cRun.result?.repro?.result;
    record.runs.changed = cRun.result;
    c.check("(c) the demo with SPEED 2 → 2.5 differs, first path under $.player", rc?.status === "differs" && /^\$\.player\./.test(rc.diffs?.[0] || ""),
      `status ${rc?.status} diffs ${JSON.stringify(rc?.diffs)} pre "${cRun.result?.pre}"`);
  } finally { await srvC.stop(); }
  c.check("examples/demo unchanged (no repro/ and no .snapper written into it)", !existsSync(join(REPO, "examples", "demo", "repro")) && !existsSync(join(REPO, "examples", "demo", ".snapper")));
} catch (e) {
  c.check("verify-repro ran to the end", false, e && e.stack || String(e));
} finally {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}

const ok = c.report();
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "checks.json"), JSON.stringify({ ...record, checks: c.items }, null, 2) + "\n");
if (EVIDENCE) { await mkdir(EV, { recursive: true }); await writeFile(join(EV, "checks.json"), JSON.stringify({ ...record, checks: c.items }, null, 2) + "\n"); }
process.exit(ok ? 0 : 1);
