// `snapper attach <http://host:port | ws://…/devtools/page/…> …` (v1.4, BRIEF-v1.4 §2). Plain Node, like cli-play.mjs: resolves
// the target page and the config, spawns the attach host (Electron on the entry, SNAPPER_ATTACH_OPTS) and relays the result.
// The launcher imports buildAttachOptions and spawnAttach (CONTRACTS.md "W1").
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveConfig, slugify } from "../../core/index.mjs";
import { configFlags } from "./helpers.mjs";
import { electronCommand, electronChildEnv } from "./electron-bin.mjs";
import { listTargets, pickTarget } from "./cdp.mjs";

const err = msg => process.stderr.write(`snapper attach: ${msg}\n`);
const readResult = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/** %APPDATA%\Snapper, or SNAPPER_USER_DATA (the test hook the launcher uses too). */
export function userDataDir(env = process.env) {
  if (env.SNAPPER_USER_DATA) return resolve(env.SNAPPER_USER_DATA);
  return join(env.APPDATA || join(homedir(), ".config"), "Snapper");
}

/** Pure: a session slug from a page URL: hostname + path, slugified (the port is not part of it). */
export function slugFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return slugify(decodeURIComponent(u.pathname).replace(/\/index\.html?$/i, "").split("/").filter(Boolean).slice(-2).join("-")) || "page";
    return slugify(`${u.hostname}${u.pathname === "/" ? "" : u.pathname.replace(/\/index\.html?$/i, "")}`);
  } catch { return "page"; }
}

const hasScheme = s => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
const isWs = s => /^wss?:\/\//i.test(s);
/** `127.0.0.1:9222` / `localhost:9222` → `http://…`. */
export const normalizeEndpoint = s => (isWs(s) || hasScheme(s) ? String(s) : `http://${s}`);

/**
 * Resolve everything the attach host needs. Throws Error with a user-facing message. When the choice of page is ambiguous
 * (or there is none) the error carries `.targets` (the list: id, title, url) and `.exitCode = 2`.
 * Returns { endpoint, wsUrl, target: { id, url, title }, root, slug, out, config, smoke, reload, userData? }.
 */
export async function buildAttachOptions({ positional, flags = {} }, { fetchImpl } = {}) {
  const raw = positional?.[0];
  if (!raw) throw new Error("missing the debugging endpoint. usage: snapper attach <http://127.0.0.1:9222 | ws://…/devtools/page/…> [--target <url or title>] [--game-root <dir>]");
  const endpoint = normalizeEndpoint(raw);
  const lopts = fetchImpl ? { fetchImpl } : {};
  let wsUrl, target;
  if (isWs(endpoint)) {
    wsUrl = endpoint;
    target = { id: "", url: "", title: "" };
    try {                                                   // best effort: the page's url and title for the slug and env.json
      const u = new URL(endpoint);
      const list = await listTargets(`http://${u.host}`, lopts);
      const hit = list.find(t => t.webSocketDebuggerUrl === endpoint) || list.find(t => endpoint.endsWith(`/devtools/page/${t.id}`));
      if (hit) target = { id: hit.id, url: hit.url, title: hit.title };
    } catch { /* the socket itself is what matters */ }
  } else {
    const targets = await listTargets(endpoint, lopts);
    const pick = pickTarget(targets, flags.target && flags.target !== true ? String(flags.target) : undefined);
    if (pick.error) {
      const e = new Error(pick.error);
      e.targets = pick.list;
      e.exitCode = 2;
      throw e;
    }
    wsUrl = pick.target.webSocketDebuggerUrl;
    target = { id: pick.target.id, url: pick.target.url, title: pick.target.title };
  }

  let root = null;
  if (flags.gameRoot !== undefined) {
    if (flags.gameRoot === true) throw new Error("--game-root needs a folder");
    root = resolve(flags.gameRoot);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  }
  let fileConfig;
  if (flags.config && flags.config !== true) {
    try { fileConfig = JSON.parse(readFileSync(resolve(flags.config), "utf8")); }
    catch (e) { throw new Error(`cannot read --config ${flags.config}: ${e.message}`); }
  }
  const cflags = configFlags(flags, { resolve });            // throws on a bad --hotkeys value
  let resolved;
  try { resolved = resolveConfig({ root, flags: cflags, fileConfig }); }
  catch (e) { throw new Error(`cannot read snapper.config.json: ${e.message}`); }
  const slug = (resolved.config.slug || root) ? resolved.slug : slugFromUrl(target.url);
  let out = resolved.out;
  if (!out) out = join(userDataDir(), "attach-sessions");    // no game root: <userData>/attach-sessions/<slug>/<id>
  const smoke = flags.smoke && flags.smoke !== true ? resolve(flags.smoke) : null;
  if (flags.smoke === true) throw new Error("--smoke needs a script path");
  if (smoke && !existsSync(smoke)) throw new Error(`smoke script not found: ${smoke}`);
  return {
    endpoint: isWs(endpoint) ? endpoint : endpoint.replace(/\/+$/, ""), wsUrl, target, root: resolved.root, slug, out, config: resolved.config,
    smoke, reload: flags.noReload !== true,
  };
}

/**
 * Start the attach host (an Electron child on the entry, SNAPPER_ATTACH_OPTS + SNAPPER_RESULT_FILE set) for `opts`
 * (buildAttachOptions). Shared by `snapper attach` and the launcher, like spawnPlay.
 *   stdio:     the child's stdio (the CLI inherits stderr; the launcher pipes it)
 *   onSession: called once with the session folder as soon as the child reports it
 * Returns { child, resultFile, command: { exe, args }, quit(), kill(), done: Promise<{ code, result }> }.
 */
export function spawnAttach(opts, { stdio = ["ignore", "ignore", "inherit"], onSession = null } = {}) {
  const command = electronCommand();
  const resultFile = join(tmpdir(), `snapper-result-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.json`);
  const env = electronChildEnv({ SNAPPER_ATTACH_OPTS: JSON.stringify(opts), SNAPPER_RESULT_FILE: resultFile });
  const child = spawn(command.exe, command.args, { env, stdio, windowsHide: false });
  let reported = false;
  const report = r => { if (r?.session && !reported) { reported = true; try { onSession?.(r.session); } catch {} } };
  const poll = setInterval(() => report(readResult(resultFile)), 200);
  const done = new Promise(res => {
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      try { if (child.pid) rmSync(join(tmpdir(), `snapper-attach-${child.pid}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
      const result = readResult(resultFile);
      report(result);
      try { rmSync(resultFile, { force: true }); rmSync(resultFile + ".quit", { force: true }); } catch {}
      res({ code, result });
    };
    child.on("error", e => { err(`cannot start Electron (${command.exe}): ${e.message}`); finish(1); });
    child.on("exit", (c, sig) => finish(c ?? (sig ? 1 : 0)));
  });
  return {
    child, resultFile, command, done,
    /** Ask the host to detach and finish normally (it saves the exit state). */
    quit() { try { writeFileSync(resultFile + ".quit", "quit\n"); } catch {} },
    kill() { try { child.kill(); } catch {} },
  };
}

export async function run(args) {
  let opts;
  try { opts = await buildAttachOptions(args); }
  catch (e) {
    err(e.message);
    if (e.targets) for (const t of e.targets) process.stdout.write(`${t.id}\t${t.title || "(no title)"}\t${t.url}\n`);
    return e.exitCode || 2;
  }
  let p;
  try {
    p = spawnAttach(opts, { onSession: dir => process.stdout.write(`snapper: session ${dir}\n`) });
  } catch (e) { err(e.message); return 1; }
  // Ctrl+C: ask the host to detach and write the end of the session (a quit file); a second Ctrl+C, or no exit within 20 s, kills it.
  let sigs = 0, hardKill = null;
  const onSig = () => {
    if (++sigs === 1) {
      p.quit();
      err("detaching: saving the exit state (Ctrl+C again to kill)");
      hardKill = setTimeout(() => p.kill(), 20000);
    } else p.kill();
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  const { code, result } = await p.done;
  clearTimeout(hardKill);
  process.off("SIGINT", onSig);
  process.off("SIGTERM", onSig);

  let exit = code;
  if (opts.smoke) {
    const out = { session: result?.session ?? null, ok: !!(result && result.ok === true && code === 0), marks: result?.marks ?? 0 };
    if (result?.failures?.length) for (const f of result.failures) err(`smoke failure: ${f}`);
    process.stdout.write(JSON.stringify(out) + "\n");
    exit = out.ok ? 0 : (code || 1);
  } else if (result?.session) {
    process.stdout.write(`snapper: SESSION.md at ${join(result.session, "SESSION.md")}\n`);
  }
  return exit;
}
