// The launcher window (BRIEF-v1.2 §4, BRIEF-v1.3 §1): what Snapper.exe shows with no arguments. Main-process side.
// Imported from entry.mjs, so nothing here may await app.whenReady() at module top level (startLauncher does).
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, shell } from "electron";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG, SNAPPER_VERSION, TRIAGE_STATUSES, detectIntegration, lastSdkSeen, listCheckpointsWithMarks, readSession, readTriage,
  resolveConfig, sessionIdOf, writeTriage,
} from "../../core/index.mjs";
import { buildOptions, resolveResume, spawnPlay } from "../main/cli-play.mjs";
import { examplesDir } from "../main/electron-bin.mjs";
import { listSessions } from "../tools/list.mjs";
import { installSkill } from "../tools/skill.mjs";
import {
  attachFor, captureFlags, checkEndpoint, commandLine, copyForClaudeText, fieldsFor, fieldsProblem, markLabel, mergeSettings, normRoot,
  pruneCapture, rememberAttach, rememberRoot, resetCapture, setupModel,
} from "./settings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SNAPPER_OUT || "";                 // test hook: keeps test sessions out of a game's real folder
const LAYOUT_FILE = process.env.SNAPPER_LAUNCHER_LAYOUT || "";  // test hook: where the page's control positions go
const USER_DATA = process.env.SNAPPER_USER_DATA || "";     // test hook: userData (settings.json, logs, demo-sessions) instead of %APPDATA%/Snapper
const CHECK_SESSIONS = 3;                                   // the Check button's "--sessions N"
const DEMO_ORDER = ["demo", "phaser", "pixi", "three"];

let settings = mergeSettings(null);
let win = null;
let game = null;        // { session } while a game child runs
let replaying = false;
let checking = false;

const settingsFile = () => join(app.getPath("userData"), "settings.json");
const demoOut = () => join(app.getPath("userData"), "demo-sessions");

function loadSettings() {
  try { settings = mergeSettings(JSON.parse(readFileSync(settingsFile(), "utf8"))); } catch { settings = mergeSettings(null); }
}
function saveSettings() {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    const tmp = settingsFile() + ".tmp";
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
    renameSync(tmp, settingsFile());
  } catch (e) { push({ type: "error", message: `could not save settings: ${e.message}` }); }
}

const push = ev => { if (win && !win.isDestroyed()) win.webContents.send("snapper:event", ev); };
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const str = (v, what) => { if (typeof v !== "string" || v.includes("\0")) throw new Error(`bad ${what}`); return v; };

/** A bundled example folder (examplesDir() and below): its sessions go to <userData>/demo-sessions, it is never remembered. */
function isBundled(root) {
  const r = normRoot(resolve(String(root || "."))).toLowerCase(), base = normRoot(examplesDir()).toLowerCase();
  return !!root && (r === base || r.startsWith(base + "/"));
}
/** Where a root's sessions live: demo-sessions for a bundled example, the SNAPPER_OUT hook, else the game's own folder (null). */
const outFor = root => (isBundled(root) ? demoOut() : OUT || null);

/** The game's own capture values (its snapper.config.json over the defaults, no flags): what the capture fields show. */
function effectiveFor(root) {
  let c = DEFAULT_CONFIG;
  try { if (root && isDir(root)) c = resolveConfig({ root: resolve(root) }).config; } catch {}
  return { hotkey: c.hotkeys?.mark ?? DEFAULT_CONFIG.hotkeys.mark, padHoldMs: c.padMarkHoldMs, ringSeconds: c.ringSeconds, bare: c.bare === true };
}
/** Everything the page needs to show a root. */
function rootInfo(root) {
  const r = normRoot(root);
  const bundled = isBundled(r);
  return { root: r, fields: bundled ? fieldsFor(null, r) : fieldsFor(settings, r), effective: effectiveFor(r), recent: settings.recent, bundled, attach: attachFor(bundled ? null : settings, r) };
}

function listDemos() {
  let names = [];
  try { names = readdirSync(examplesDir(), { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(examplesDir(), e.name, "index.html"))).map(e => e.name); } catch {}
  names.sort((a, b) => {
    const ia = DEMO_ORDER.indexOf(a), ib = DEMO_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return names.map(slug => ({ slug, name: slug, path: normRoot(join(examplesDir(), slug)) }));
}

/** Keep the last 10 play logs; return an open append fd for a new one (or "ignore" if the folder is unusable). */
function openPlayLog() {
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    const old = readdirSync(dir).filter(f => /^play-.*\.log$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 9))) rmSync(join(dir, f), { force: true });
    const file = join(dir, `play-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    return { fd: openSync(file, "a"), file };
  } catch { return { fd: "ignore", file: null }; }
}
const tailOf = (file, n = 12) => {
  try { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-n).join("\n"); } catch { return ""; }
};

/** Play, or Resume when `resume` = { session, at }. Returns { ok, command, root } | { error }. */
async function startGame(fields, resume = null) {
  if (game) return { error: "a game is already running" };
  if (checking) return { error: "a check is running; wait for it to finish" };
  const root = String(fields?.root || "").trim();
  if (!root) return { error: "pick a game folder first" };
  const problem = fieldsProblem(fields);
  if (problem) return { error: problem };
  const r = normRoot(root);
  const bundled = isBundled(r);
  const eff = effectiveFor(r);
  const f = pruneCapture(fields, eff);
  const out = outFor(r) || undefined;
  const flags = captureFlags(f, eff);
  const url = resume ? "" : f.url;
  const args = { root: r, url, preset: fields.preset, fullscreen: !!fields.fullscreen, query: fields.query || "", flags, out };
  let opts;
  try {
    const cli = { preset: args.preset, fullscreen: args.fullscreen || undefined, query: args.query || undefined, out, ...flags };
    if (url) cli.gameRoot = r;
    if (resume) { cli.resume = resume.session; cli.at = resume.at || "exit"; delete cli.query; }
    opts = buildOptions({ positional: [url || root], flags: cli });
    if (resume) opts = await resolveResume(opts, cli);
  } catch (e) { return { error: e.message }; }
  const command = resume ? commandLine("resume", { ...args, session: resume.session, at: resume.at || "exit" }) : commandLine("play", args);

  if (!bundled) {
    settings = rememberRoot(settings, r, f);
    saveSettings();
  }
  const log = openPlayLog();
  let p;
  try {
    p = spawnPlay(opts, { stdio: ["ignore", "ignore", log.fd], onSession: dir => { if (game) game.session = sessionIdOf(dir); push({ type: "play-session", id: sessionIdOf(dir) }); } });
  } catch (e) {
    if (typeof log.fd === "number") closeSync(log.fd);
    return { error: `cannot start the game: ${e.message}` };
  }
  if (typeof log.fd === "number") closeSync(log.fd);       // the child holds its own handle
  game = { session: null };
  p.done.then(({ code }) => {
    game = null;
    push({ type: "play-end", code, stderr: code ? tailOf(log.file) : "" });
  });
  return { ok: true, command, root: r };
}

/** A module of another worker, loaded on demand so the launcher opens and its other buttons work while it is missing. */
async function lazy(spec, what) {
  try { return await import(spec); }
  catch (e) { throw new Error(`${what} is not available in this build (${String(e?.message || e).split("\n")[0]})`); }
}
/** A named export of core, else of one of its source files (a worker may not have re-exported it yet). */
async function coreFn(name, file) {
  let mod = await import("../../core/index.mjs");
  if (typeof mod[name] === "function") return mod[name];
  try { mod = await import(`../../core/src/${file}`); } catch {}
  if (typeof mod[name] !== "function") throw new Error(`${name} is not available in this build`);
  return mod[name];
}

/** Attach to a page of a Chromium started with --remote-debugging-port. Returns { ok, command, root } | { error, targets? }. */
async function startAttach(fields) {
  if (game) return { error: game.attach ? "already attached; Detach first" : "a game is already running" };
  if (checking) return { error: "a check is running; wait for it to finish" };
  const root = String(fields?.root || "").trim();
  if (!root) return { error: "pick a game folder first: Attach records into the game's own sessions folder" };
  const r = normRoot(root);
  if (!isDir(r)) return { error: `game folder not found: ${r}` };
  const ep = checkEndpoint(fields?.endpoint);
  if (ep.error) return { error: ep.error };
  const target = typeof fields?.target === "string" ? fields.target.trim() : "";
  const eff = effectiveFor(r);
  const f = pruneCapture(fields, eff);
  const flags = captureFlags(f, eff);
  const out = outFor(r) || undefined;
  const cli = { gameRoot: r, out };
  if (target) cli.target = target;
  if (flags.hotkeys) cli.hotkeys = flags.hotkeys;
  if (flags.bare) cli.bare = true;
  const command = commandLine("attach", { endpoint: ep.endpoint, target, root: r, flags, out });
  let mod, opts;
  try { mod = await lazy("../main/cli-attach.mjs", "Attach mode"); } catch (e) { return { error: e.message }; }
  try { opts = await mod.buildAttachOptions({ positional: [ep.endpoint], flags: cli }); }
  catch (e) { return { error: e?.message || String(e), ...(Array.isArray(e?.targets) ? { targets: e.targets.map(t => ({ id: t.id, title: t.title, url: t.url })) } : {}) }; }
  if (!isBundled(r)) {
    settings = rememberAttach(rememberRoot(settings, r, f), r, { endpoint: ep.endpoint, target });
    saveSettings();
  }
  const log = openPlayLog();
  let p;
  try {
    p = mod.spawnAttach(opts, { stdio: ["ignore", "ignore", log.fd], onSession: dir => { if (game) game.session = sessionIdOf(dir); push({ type: "play-session", id: sessionIdOf(dir), attach: true }); } });
  } catch (e) {
    if (typeof log.fd === "number") closeSync(log.fd);
    return { error: `cannot attach: ${e.message}` };
  }
  if (typeof log.fd === "number") closeSync(log.fd);
  game = { session: null, attach: true, handle: p };
  p.done.then(({ code }) => {
    game = null;
    push({ type: "play-end", attach: true, code, stderr: code ? tailOf(log.file) : "" });
  });
  return { ok: true, command, root: r };
}

/** Import a tester's session zip into the current root's sessions folder. */
async function importZip(zipPath, rootArg) {
  const p = normRoot(str(zipPath, "path"));
  if (!/\.zip$/i.test(p)) throw new Error(`not a .zip file: ${p}`);
  const root = normRoot(typeof rootArg === "string" && rootArg.trim() ? rootArg : settings.lastRoot);
  if (!root) throw new Error("pick the game folder first: an imported session lands in its sessions folder");
  if (!isDir(root)) throw new Error(`game folder not found: ${root}`);
  if (isBundled(root)) throw new Error("pick your own game folder first; the bundled demos are inside the Snapper install");
  if (!existsSync(p)) throw new Error(`not found: ${p}`);
  const mod = await lazy("../tools/import.mjs", "Import");
  // The session lands in this root's sessions folder (or the redirected one: SNAPPER_OUT, a bundled demo's), and
  // import.json records the root so a replay of the tester's session serves this game.
  const out = outFor(root);
  const res = await mod.importSession(p, out ? { root, out } : { root });
  settings = rememberRoot(settings, root, fieldsFor(settings, root)); saveSettings();
  return { ...rootInfo(root), imported: { dir: res.dir, id: res.id, tester: res.tester ?? null } };
}

async function runReplay(sessionDir, markId) {
  if (replaying) return { error: "a replay is already running" };
  if (checking) return { error: "a check is running; wait for it to finish" };
  const command = commandLine("replay", { session: sessionDir, markId });
  let mod;
  try { mod = await import("../replay/inprocess.mjs"); }
  catch (e) { return { error: `the replay engine could not be loaded: ${e.message}` }; }
  replaying = true;
  mod.replayInProcess({ sessionDir, markId }, { log: line => push({ type: "replay-log", line: String(line) }) }).then(
    ({ outDir, result }) => {
      replaying = false;
      push({ type: "replay-done", sessionDir, markId, outDir, stateMatches: result?.stateMatches === true, firstDiff: result?.firstDiff ?? null, diffs: result?.diffs ?? [], warnings: result?.warnings ?? [] });
    },
    e => { replaying = false; push({ type: "replay-error", message: e?.message || String(e) }); },
  );
  return { ok: true, command };
}

/** Check (the newest CHECK_SESSIONS sessions) or, with `session`, Accept the given marks of one session. */
async function runCheck({ root, session = "", marks = null, accept = false }) {
  if (game) return { error: "a game is running; close it before checking" };
  if (replaying) return { error: "a replay is running; wait for it to finish" };
  if (checking) return { error: "a check is already running" };
  const r = normRoot(str(root, "game folder"));
  if (!r || !isDir(r)) return { error: `game folder not found: ${r}` };
  if (session && !isDir(session)) return { error: `session folder not found: ${session}` };
  const out = outFor(r);
  const req = session ? { root: r, session, marks, accept: true, out } : { root: r, sessions: CHECK_SESSIONS, out };
  const command = commandLine("check", { root: r, session, sessions: session ? 0 : CHECK_SESSIONS, marks, accept: !!session, out });
  let mod;
  try {
    mod = await import("../replay/inprocess.mjs");
    if (typeof mod.checkInProcess !== "function") throw new Error("checkInProcess is not exported");
  } catch (e) { return { error: `the check engine could not be loaded: ${e.message}` }; }
  checking = true;
  mod.checkInProcess(req, { log: line => push({ type: "check-log", line: String(line) }), onRow: row => push({ type: "check-row", row }) }).then(
    res => {
      checking = false;
      push({ type: "check-done", rows: res?.rows ?? [], summary: res?.summary ?? null, checkFile: res?.checkFile ?? null, accepted: !!session, session, marks });
    },
    e => { checking = false; push({ type: "check-error", message: e?.message || String(e) }); },
  );
  return { ok: true, command };
}

const readRecipe = () => readFileSync(join(HERE, "recipe.txt"), "utf8");

/** Mark pickers: `label` per mark, joined to checkpoints by mark id. */
async function markLabels(dir) {
  const s = await readSession(dir, { marks: false });
  return Promise.all(s.marks.map(async m => {
    let status = "";
    try { status = (await readTriage(dir, String(m.id)))?.status ?? ""; } catch {}
    return { id: String(m.id), frame: m.frame ?? null, trigger: m.trigger ?? "", summary: m.summary ?? "", note: m.note ?? "", status, label: markLabel({ ...m, status }) };
  }));
}

function registerIpc() {
  const h = (name, fn) => ipcMain.handle(`snapper:${name}`, async (_e, ...a) => {
    try { return await fn(...a); } catch (e) { return { error: e?.message || String(e) }; }
  });
  h("getState", () => ({
    version: SNAPPER_VERSION, ...rootInfo(settings.lastRoot), playing: game ? game.session || "starting" : null, attached: !!game?.attach, replaying, checking, layoutHook: !!LAYOUT_FILE,
  }));
  h("browse", async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], defaultPath: settings.lastRoot || undefined });
    return r.canceled || !r.filePaths[0] ? null : normRoot(r.filePaths[0]);
  });
  h("setRoot", root => {
    const r = normRoot(str(root, "game folder"));
    if (r && isDir(r) && !isBundled(r)) { settings = rememberRoot(settings, r, fieldsFor(settings, r)); saveSettings(); }
    return rootInfo(r);
  });
  h("dropPath", p => {
    str(p, "path");
    let r = normRoot(p);
    if (!r) throw new Error("nothing was dropped");
    if (!existsSync(r)) throw new Error(`not found: ${r}`);
    if (!isDir(r)) r = normRoot(dirname(r));
    if (!isDir(r)) throw new Error(`not a folder: ${r}`);
    if (!isBundled(r)) { settings = rememberRoot(settings, r, fieldsFor(settings, r)); saveSettings(); }
    return rootInfo(r);
  });
  h("saveFields", f => {
    const out = { recent: settings.recent };
    if (f?.root && isDir(normRoot(f.root)) && !isBundled(f.root)) {
      const problem = fieldsProblem(f);
      if (problem) out.warn = problem;
      settings = rememberRoot(settings, f.root, pruneCapture(f, effectiveFor(normRoot(f.root))));
      if (typeof f.endpoint === "string" && !checkEndpoint(f.endpoint).error) {
        settings = rememberAttach(settings, f.root, { endpoint: f.endpoint, ...(typeof f.target === "string" && f.target ? { target: f.target } : {}) });
      }
      saveSettings();
      out.recent = settings.recent;
    }
    return out;
  });
  h("resetCapture", root => {
    const r = normRoot(str(root, "game folder"));
    if (r && isDir(r) && !isBundled(r)) { settings = rememberRoot(settings, r, resetCapture(fieldsFor(settings, r))); saveSettings(); }
    return rootInfo(r);
  });
  h("listSessions", root => listSessions(str(root, "game folder"), { out: outFor(normRoot(root)) }).then(r => ({ rows: r.rows, out: r.out })));
  h("checkpoints", async dir => {
    const labels = new Map((await markLabels(dir)).map(m => [m.id, m.label]));
    const list = await listCheckpointsWithMarks(dir);
    return { list: list.map(c => ({ name: c.name, kind: c.kind, frame: c.frame, restorable: c.restorable, label: c.markId != null ? labels.get(String(c.markId)) ?? "" : "" })) };
  });
  h("marks", async dir => ({ marks: await markLabels(str(dir, "session folder")) }));
  h("play", fields => startGame(fields));
  h("resume", (session, at, fields) => startGame(fields, { session, at }));
  h("replay", (dir, markId) => runReplay(str(dir, "session folder"), str(markId, "mark")));
  h("demos", () => ({ list: listDemos() }));
  h("tryDemo", slug => {
    const d = listDemos().find(x => x.slug === str(slug, "demo"));
    if (!d) throw new Error(`no such demo: ${slug}`);
    return startGame({ root: d.path, preset: "1080p", fullscreen: false, query: "" });
  });
  h("setupClaude", async root => {
    const r = normRoot(str(root, "game folder"));
    if (!r || !isDir(r)) throw new Error(`game folder not found: ${r || "(none)"}`);
    if (isBundled(r)) throw new Error("this is a bundled demo inside the Snapper install; set up your own game folder instead");
    const { dest, files } = await installSkill(r);
    const integration = detectIntegration(r);
    const sdkSeen = await lastSdkSeen(r, { out: outFor(r) });
    return {
      ok: true, dest, installed: files, recipe: readRecipe(), command: commandLine("skill", { root: r }),
      integration: { found: integration.found, candidates: integration.candidates }, sdkSeen, model: setupModel(integration, sdkSeen),
    };
  });
  h("copyForClaude", (sessionDir, markId) => {
    const dir = str(sessionDir, "session folder");
    if (!isDir(dir)) throw new Error(`session folder not found: ${dir}`);
    const text = copyForClaudeText(dir, typeof markId === "string" ? markId : "");
    clipboard.writeText(text);
    return { ok: true, text };
  });
  h("copyText", kind => {
    if (kind !== "recipe") throw new Error(`cannot copy "${kind}"`);
    const text = readRecipe();
    clipboard.writeText(text);
    return { ok: true, text };
  });
  h("attachTargets", async endpoint => {
    const ep = checkEndpoint(endpoint);
    if (ep.error) throw new Error(ep.error);
    const { listTargets } = await import("../main/cdp.mjs");
    return { targets: (await listTargets(ep.endpoint)).map(t => ({ id: t.id, title: t.title, url: t.url })) };
  });
  h("attach", fields => startAttach(fields && typeof fields === "object" ? fields : {}));
  h("detach", () => {
    if (!game?.attach) return { error: "not attached" };
    game.handle.quit();
    return { ok: true };
  });
  h("importZip", (p, root) => importZip(p, root));
  h("openReport", async dir => {
    const d = str(dir, "session folder");
    if (!isDir(d)) throw new Error(`session folder not found: ${d}`);
    const writeReport = await coreFn("writeReport", "report.mjs");
    const file = await writeReport(d);
    const err = await shell.openPath(String(file));
    return err ? { error: err } : { ok: true, path: file };
  });
  h("copyIssue", async (dir, markId) => {
    const d = str(dir, "session folder"), m = str(markId, "mark");
    if (!/^\d{4,}$/.test(m)) throw new Error(`not a mark id: ${m}`);
    const buildIssue = await coreFn("buildIssue", "issue.mjs");
    const issue = await buildIssue(d, m, {});
    clipboard.writeText(issue.markdown);
    return { ok: true, text: issue.markdown };
  });
  h("setTriage", async (dir, markId, status, of) => {
    const d = str(dir, "session folder"), m = str(markId, "mark"), st = str(status, "status");
    if (!/^\d{4,}$/.test(m)) throw new Error(`not a mark id: ${m}`);
    if (!TRIAGE_STATUSES.includes(st)) throw new Error(`status must be one of ${TRIAGE_STATUSES.join(", ")}`);
    const patch = { status: st, by: userInfo().username || "launcher" };
    if (st === "duplicate") { const o = typeof of === "string" ? of.trim() : ""; if (o) patch.of = o; }
    const { doc } = await writeTriage(d, m, patch);
    return { ok: true, triage: doc };
  });
  h("check", root => runCheck({ root }));
  h("accept", (root, sessionDir, markId) => {
    if (!/^\d{4,}$/.test(str(markId, "mark"))) throw new Error(`not a mark id: ${markId}`);
    return runCheck({ root, session: str(sessionDir, "session folder"), marks: [markId], accept: true });
  });
  h("openPath", async p => { const err = existsSync(p) ? await shell.openPath(p) : `not found: ${p}`; return err ? { error: err } : { ok: true }; });
  ipcMain.on("snapper:layout", (_e, elements) => {
    if (!LAYOUT_FILE || !win || win.isDestroyed()) return;
    try {
      const b = win.getContentBounds();
      const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
      writeFileSync(LAYOUT_FILE, JSON.stringify({ window: { x: b.x, y: b.y, width: b.width, height: b.height }, scale, elements }, null, 1));
    } catch {}
  });
}

function restoredBounds() {
  const b = settings.bounds;
  if (!b) return {};
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const onScreen = screen.getAllDisplays().some(d => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height);
  return onScreen ? b : { width: b.width, height: b.height };
}

export async function startLauncher() {
  // One settings home for the dev launcher (`electron entry.mjs`, whose default name is "Electron") and the packaged
  // Snapper.exe: %APPDATA%/Snapper, or SNAPPER_USER_DATA (test hook: drive scripts must not touch the real settings).
  // Set before `ready` (entry.mjs calls this synchronously from its top level).
  try {
    const home = USER_DATA ? resolve(USER_DATA) : join(app.getPath("appData"), "Snapper");
    if (USER_DATA) mkdirSync(home, { recursive: true });
    app.setPath("userData", home);
  } catch {}
  await app.whenReady();
  Menu.setApplicationMenu(null);
  loadSettings();
  registerIpc();
  const icon = join(HERE, "icon.png");
  win = new BrowserWindow({
    width: 820, height: Math.min(900, screen.getPrimaryDisplay().workAreaSize.height - 40), minWidth: 520, minHeight: 420, ...restoredBounds(),
    resizable: true, autoHideMenuBar: true, backgroundColor: "#15171c", title: "Snapper",
    ...(existsSync(icon) ? { icon } : {}),
    webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.on("close", () => { if (!win.isMinimized() && !win.isMaximized()) { settings.bounds = mergeSettings({ bounds: win.getNormalBounds() }).bounds; saveSettings(); } });
  win.on("closed", () => { win = null; if (game?.attach) { try { game.handle.quit(); } catch {} } app.quit(); });
  app.on("window-all-closed", () => app.quit());
  await win.loadFile(join(HERE, "index.html"));
}
