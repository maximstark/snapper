// Y3 — engine demos (BRIEF-v1.3 §4.2, §7). For each of phaser, pixi, three:
//   - `play examples/<e> --smoke` exits 0, ok:true, >= 1 mark; the first mark's state.json carries the engine name,
//     player position and score; frame.png is a 320x180 PNG; `replay <session> 0001` says stateMatches true;
//   - the game boots and runs with NO Snapper present (a throwaway Electron window with no SDK, same static server);
//   - sizes: the demo folder (without vendor/) and the vendored lib files.
//   node scripts/verify-engines.mjs [--out <dir>]   (EVIDENCE=1 writes private/evidence/<EVIDENCE_VERSION or v1.3>/y3/)
// Writes sessions/y3/checks.json always.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, serveStatic } from "../packages/core/index.mjs";
import { electronCommand, electronChildEnv } from "../packages/host/main/electron-bin.mjs";
import { REPO, snapper, checklist, png, json, exists, EVIDENCE_ON, evidenceDir } from "./lib.mjs";

const argv = process.argv.slice(2);
const outArg = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : join(REPO, "sessions", "y3", "out");
const ENGINES = ["phaser", "pixi", "three"];
const c = checklist("Y3 engine demos");
const sizes = {};
const record = { gate: "Y3", startedAt: new Date().toISOString(), engines: {} };

async function dirBytes(dir, skip = () => false) {
  let total = 0, files = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (skip(e)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { const r = await dirBytes(p, skip); total += r.bytes; files += r.files; }
    else { total += (await stat(p)).size; files++; }
  }
  return { bytes: total, files };
}

// A throwaway Electron main: visible window (so rAF is not throttled), no preload, no SDK, a private userData.
const NO_SDK_MAIN = `
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
const url = process.env.NOSDK_URL, outFile = process.env.NOSDK_OUT;   // not argv: Electron treats a URL argument as something to open
app.setPath("userData", process.env.NOSDK_USERDATA);
const errors = [];
const finish = code => { try { writeFileSync(outFile, JSON.stringify(result)); } catch {} app.exit(code); };
const result = { errors, gone: null, hasSnapper: null, frame0: null, frame1: null };
// Electron waits for the entry module's top-level await before it emits ready: never await it at the top level.
app.whenReady().then(async () => {
const win = new BrowserWindow({ x: 40, y: 40, width: 640, height: 360, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
win.webContents.on("console-message", (...a) => {
  const ev = a[0] || {};
  const level = typeof ev.level === "string" || typeof ev.level === "number" ? ev.level : a[1];
  const message = typeof ev.message === "string" ? ev.message : a[2];
  if (level === "error" || level === 3) errors.push(String(message).slice(0, 300));
});
win.webContents.on("render-process-gone", (_e, d) => { result.gone = d && d.reason || "gone"; });
win.webContents.on("did-fail-load", (_e, code, desc) => { errors.push("did-fail-load " + code + " " + desc); });
win.showInactive();
await win.loadURL(url).catch(e => errors.push("loadURL: " + e.message));
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(1500);
const probe = () => win.webContents.executeJavaScript("({ snapper: typeof window.snapper, frame: window.__demoFrame, canvas: !!document.getElementById('screen') })");
const a = await probe();
await wait(1000);
const b = await probe();
result.hasSnapper = a.snapper !== "undefined";
result.frame0 = a.frame; result.frame1 = b.frame; result.canvas = a.canvas;
finish(0);
}).catch(e => { errors.push("main: " + (e && e.message)); finish(4); });
setTimeout(() => finish(3), 30000);
`;

async function runNoSdk(root, tmp) {
  const srv = await serveStatic(root);
  const main = join(tmp, "nosdk-main.mjs");
  await writeFile(main, NO_SDK_MAIN);
  const resultFile = join(tmp, `nosdk-${Date.now()}.json`);
  const userData = await mkdtemp(join(tmp, "nosdk-userdata-"));
  try {
    const { exe } = electronCommand();
    const code = await new Promise(res => {
      const child = spawn(exe, [main], {
        env: electronChildEnv({ NOSDK_USERDATA: userData, NOSDK_URL: srv.url + "/index.html", NOSDK_OUT: resultFile, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" }),
        stdio: ["ignore", "ignore", "inherit"], windowsHide: false,
      });
      const timer = setTimeout(() => child.kill(), 45000);
      child.on("exit", code => { clearTimeout(timer); res(code); });
    });
    const result = await json(resultFile);
    return { code, result };
  } finally {
    await srv.close();
  }
}

const tmp = await mkdtemp(join(tmpdir(), "snapper-y3-"));
try {
  for (const e of ENGINES) {
    const root = join(REPO, "examples", e);
    process.stdout.write(`\n== ${e}\n`);
    const rec = (record.engines[e] = {});

    // static shape
    for (const f of ["index.html", "game.js", "core.js", "smoke.json", "snapper.config.json", "LICENSE"]) {
      if (!await exists(join(root, f))) c.check(`${e}: ${f} exists`, false);
    }
    const cfg = await json(join(root, "snapper.config.json"));
    c.check(`${e}: snapper.config.json slug "${e}"`, cfg?.slug === e, JSON.stringify(cfg));
    const vendorFiles = (await readdir(join(root, "vendor"))).sort();
    const vendorSizes = {};
    for (const f of vendorFiles) vendorSizes[f] = (await stat(join(root, "vendor", f))).size;
    c.check(`${e}: vendor/ has a LICENSE file and every file < 2 MB`,
      vendorFiles.some(f => /^LICENSE/.test(f)) && Object.values(vendorSizes).every(n => n < 2 * 1024 * 1024), JSON.stringify(vendorSizes));
    const demo = await dirBytes(root, ent => ent.isDirectory() && ent.name === "vendor");
    const libBytes = Object.entries(vendorSizes).filter(([f]) => !/^LICENSE/.test(f)).reduce((n, [, v]) => n + v, 0);
    sizes[e] = { demoBytesWithoutVendor: demo.bytes, demoFiles: demo.files, vendor: vendorSizes, vendorLibBytes: libBytes };
    process.stdout.write(`   size: demo ${demo.bytes} B in ${demo.files} files (no vendor), vendored lib ${libBytes} B\n`);

    // no SDK: the game runs on its own
    const ns = await runNoSdk(root, tmp);
    rec.noSdk = ns.result;
    const r = ns.result;
    c.check(`${e}: runs with no Snapper (no SDK present, no console errors, no crash, frame advances)`,
      ns.code === 0 && r && r.hasSnapper === false && r.canvas && r.errors.length === 0 && !r.gone
        && Number.isInteger(r.frame0) && r.frame1 > r.frame0 && r.frame0 > 0,
      r ? `exit ${ns.code} sdk ${r.hasSnapper} frame ${r.frame0} -> ${r.frame1} errors ${JSON.stringify(r.errors)} gone ${r.gone}` : `exit ${ns.code}, no result`);

    // play the smoke under the host
    const run = await snapper(["play", `examples/${e}`, "--smoke", `examples/${e}/smoke.json`, "--out", outArg], { echo: false });
    c.check(`${e}: play --smoke exits 0 with ok:true`, run.code === 0 && run.last?.ok === true, `exit ${run.code} ${run.lastLine.slice(0, 160)} ${run.code ? run.stderr.trim().slice(-300) : ""}`);
    const dir = run.last?.session;
    if (!dir || !(await exists(dir))) { c.check(`${e}: session folder exists`, false, String(dir)); continue; }
    rec.session = dir;
    const s = await readSession(dir);
    const rd = s.ready || {};
    c.check(`${e}: ready sdk, state, frame, stepper all true`, rd.sdk && rd.state && rd.frame && rd.stepper, JSON.stringify(rd));
    c.check(`${e}: boot ok, >= 1 mark, no error lines`, s.boot?.ok === true && s.marks.length >= 1 && !s.marks.some(m => m.errors > 0), `boot ${JSON.stringify(s.boot)} marks ${s.marks.length} (${s.marks.map(m => m.trigger).join(",")})`);
    const first = s.marks[0];
    if (!first) continue;
    const md = join(dir, ...first.dir.split("/"));
    const st = await json(join(md, "state.json"));
    rec.state = st;
    c.check(`${e}: state.json has engine "${e}", a version, player x/y, score`,
      st?.engine === e && typeof st.engineVersion === "string" && st.engineVersion.length > 0
        && Number.isFinite(st.player?.x) && Number.isFinite(st.player?.y) && Number.isInteger(st.score) && Number.isInteger(st.frame) && st.frame > 0,
      st ? `engine ${st.engine} ${st.engineVersion} frame ${st.frame} player ${st.player?.x},${st.player?.y} score ${st.score}` : "missing");
    c.check(`${e}: state.json keeps volatile numbers under perf only`, st?.perf && typeof st.perf.fps === "number" && !("fps" in st) && !("frameMs" in st));
    const fr = await png(join(md, "frame.png"));
    c.check(`${e}: frame.png is a 320×180 PNG, not blank`, fr.size?.w === 320 && fr.size?.h === 180 && fr.stats?.distinct > 2 && fr.stats?.nonBlack > 0.5,
      fr.error || `${fr.size?.w}×${fr.size?.h} distinct ${fr.stats?.distinct} nonBlack ${fr.stats?.nonBlack?.toFixed(3)}`);
    const shot = await png(join(md, "shot.png"));
    c.check(`${e}: shot.png non-black`, shot.stats?.nonBlack > 0.5, shot.error || `${shot.size?.w}×${shot.size?.h}`);

    // replay mark 0001
    const rep = await snapper(["replay", dir, first.id], { echo: false, timeoutMs: 180000 });
    c.check(`${e}: replay ${first.id} exits 0`, rep.code === 0, `exit ${rep.code} ${rep.stderr.trim().slice(-300)}`);
    const rj = await json(join(md, "replay", "replay.json"));
    c.check(`${e}: replay.json stateMatches true`, rj?.stateMatches === true, rj ? `stateMatches ${rj.stateMatches}${rj.firstDiff ? ` firstDiff ${rj.firstDiff}` : ""} warnings ${JSON.stringify(rj.warnings)}` : "missing");
    rec.replay = rj ? { stateMatches: rj.stateMatches, warnings: rj.warnings, chromium: rj.chromium } : null;
    rec.markDir = md;
  }
  record.sizes = sizes;
} finally {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
}

const ok = c.report();
const body = () => JSON.stringify({ ...record, finishedAt: new Date().toISOString(), ok, checks: c.items }, null, 2) + "\n";
const local = join(REPO, "sessions", "y3");
await mkdir(local, { recursive: true });
await writeFile(join(local, "checks.json"), body());
if (EVIDENCE_ON) {
  const dir = evidenceDir("v1.3", "y3");
  await mkdir(dir, { recursive: true });
  const slim = { ...record, engines: Object.fromEntries(Object.entries(record.engines).map(([k, v]) => [k, { state: v.state, replay: v.replay, noSdk: v.noSdk }])) };
  await writeFile(join(dir, "checks.json"), JSON.stringify({ ...slim, finishedAt: new Date().toISOString(), ok, checks: c.items }, null, 2) + "\n");
  await writeFile(join(dir, "sizes.json"), JSON.stringify(sizes, null, 2) + "\n");
  for (const e of ENGINES) {
    const md = record.engines[e]?.markDir;
    if (md && await exists(join(md, "frame.png"))) await copyFile(join(md, "frame.png"), join(dir, `frame-${e}.png`));
  }
  process.stdout.write(`evidence: ${dir}\n`);
}
process.exit(ok ? 0 : 1);
