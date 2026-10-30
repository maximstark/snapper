// `snapper play <url|dir> …` — resolves the config, spawns the play host (Electron on the entry, SNAPPER_OPTS) and relays the result.
import { spawn } from "node:child_process";
import { existsSync, statSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveConfig, findResumeSource, listCheckpointsWithMarks, resolveAt, readCheckpoint, readJson, readTape, samePath, sessionIdOf,
} from "../../core/index.mjs";
import { configFlags } from "./helpers.mjs";
import { electronCommand, electronChildEnv } from "./electron-bin.mjs";

const err = msg => process.stderr.write(`snapper play: ${msg}\n`);
const readResult = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/** Resolve everything the Electron process needs. Throws Error with a user-facing message. */
export function buildOptions({ positional, flags }) {
  const target = positional[0];
  if (!target) throw new Error("missing <url|dir>. usage: snapper play <url|dir> [--preset …] [--smoke script.json]");
  const isUrl = /^(https?|file):\/\//i.test(target);
  let root, targetOpt;
  if (isUrl) {
    if (!flags.gameRoot || flags.gameRoot === true) throw new Error("--game-root <dir> is required when <target> is a URL");
    root = resolve(flags.gameRoot);
    targetOpt = { kind: "url", value: target };
  } else {
    const dir = resolve(target);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
    if (!existsSync(join(dir, "index.html"))) throw new Error(`no index.html in ${dir}`);
    root = flags.gameRoot && flags.gameRoot !== true ? resolve(flags.gameRoot) : dir;
    targetOpt = { kind: "dir", value: dir };
  }
  let fileConfig;
  if (flags.config && flags.config !== true) {
    try { fileConfig = JSON.parse(readFileSync(resolve(flags.config), "utf8")); }
    catch (e) { throw new Error(`cannot read --config ${flags.config}: ${e.message}`); }
  }
  const cflags = configFlags(flags, { resolve });          // throws on a bad --hotkeys value (message is user-facing)
  let resolved;
  try { resolved = resolveConfig({ root, flags: cflags, fileConfig }); }
  catch (e) { throw new Error(`cannot read snapper.config.json: ${e.message}`); }
  const smoke = flags.smoke && flags.smoke !== true ? resolve(flags.smoke) : null;
  if (flags.smoke === true) throw new Error("--smoke needs a script path");
  if (smoke && !existsSync(smoke)) throw new Error(`smoke script not found: ${smoke}`);
  return {
    target: targetOpt, root: resolved.root, slug: resolved.slug, out: resolved.out, config: resolved.config,
    fullscreen: flags.fullscreen === true || resolved.config.fullscreen === true, smoke,
  };
}

/**
 * `--resume <session-dir>|last [--at exit|<name>|<markId>|f<frame>]` (D-021). Resolves the source session and
 * checkpoint, refuses a different game root, and takes the query from the checkpoint's segment (D-022; `--query` overrides).
 * Mutates and returns opts (opts.resume, opts.config.query). Throws Error with a user-facing message.
 */
export async function resolveResume(opts, flags = {}) {
  if (flags.resume === undefined) return opts;
  if (flags.at === true) throw new Error("--at needs a value: exit, a state name (0002), mark-0003, or f<frame>");
  const base = join(opts.out, opts.slug);
  const src = await findResumeSource(base, flags.resume);
  if (src.error) throw new Error(`--resume: ${src.error}`);
  const env = await readJson(join(src.dir, "env.json"));
  if (!env) throw new Error(`--resume: cannot read ${join(src.dir, "env.json")}`);
  const srcRoot = env.game?.root;
  if (!samePath(srcRoot, opts.root)) {
    throw new Error(`--resume: the source session was played from game root ${srcRoot}, not ${opts.root}; resume it with that game`);
  }
  const srcQuery = env.game?.query ?? "";
  // D-022: --query with --resume is the explicit segment query (for sessions recorded before reload markers
  // carried one); without it the restore uses the checkpoint's segment query (resume.mjs loadResume).
  const queryOverride = typeof flags.query === "string" ? flags.query : null;
  if (queryOverride !== null) {
    process.stderr.write(`snapper play: warning: --query "${queryOverride}" overrides the segment query on --resume (source session query "${srcQuery}"); the restore's state compare says whether it was right\n`);
  }
  opts.config.query = queryOverride ?? srcQuery;
  const list = await listCheckpointsWithMarks(src.dir);
  const at = resolveAt(list, flags.at);
  if (at.error) throw new Error(`--resume ${src.dir}: ${at.error}`);
  const stepper = env.sdk?.stepper;
  const tape = await readTape(src.dir);
  const pauseParam = tape.header?.pauseParam || env.sdk?.pauseParam || "paused";
  const keymap = tape.header?.keymap?.length ? tape.header.keymap : env.sdk?.keymap || [];
  if (!stepper || !keymap.length) throw new Error(`--resume: the source session's game registered no stepper; its states are not restorable`);
  let checkpoint, frame, compareWith = null;
  if (at.checkpoint) {
    const cp = await readCheckpoint(src.dir, at.checkpoint.name);
    if (!cp) throw new Error(`--resume: cannot read checkpoint ${at.checkpoint.name} in ${src.dir}`);
    if (cp.restorable === false) throw new Error(`--resume: state ${cp.name} is not restorable (${cp.reason || "no stepper"})`);
    if (!Number.isInteger(cp.frame) || cp.frame < 0) throw new Error(`--resume: state ${cp.name} carries no game frame`);
    checkpoint = cp.name; frame = cp.frame; compareWith = cp.name;
  } else {
    checkpoint = `f${at.frame}`; frame = at.frame; compareWith = at.exact?.name ?? null;
  }
  opts.resume = {
    session: src.dir, sessionId: sessionIdOf(src.dir), checkpoint, frame, compareWith,
    base: at.base?.name ?? checkpoint, pauseParam, keymap, envQuery: srcQuery, queryOverride,
  };
  return opts;
}

/**
 * Start the play host (an Electron child on the entry, SNAPPER_OPTS set) for resolved `opts` (buildOptions +
 * resolveResume). Shared by `snapper play` and the launcher (BRIEF-v1.2 §4), so both behave identically.
 *   stdio:     the child's stdio (the CLI inherits stderr; the launcher pipes it)
 *   onSession: called once with the session folder as soon as the child reports it
 * Returns { child, resultFile, command: { exe, args }, quit(), kill(), done: Promise<{ code, result }> }.
 * `done` resolves after the child exited, its throwaway profile and the result files were removed.
 */
export function spawnPlay(opts, { stdio = ["ignore", "ignore", "inherit"], onSession = null } = {}) {
  const command = electronCommand();
  const resultFile = join(tmpdir(), `snapper-result-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.json`);
  const env = electronChildEnv({ SNAPPER_OPTS: JSON.stringify(opts), SNAPPER_RESULT_FILE: resultFile });
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
      // Electron's throwaway profile (app.mjs sets userData to this): it cannot delete it while it still holds files.
      try { if (child.pid) rmSync(join(tmpdir(), `snapper-host-${child.pid}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
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
    /** Ask the window to close normally (it saves the exit state, D-021). */
    quit() { try { writeFileSync(resultFile + ".quit", "quit\n"); } catch {} },
    kill() { try { child.kill(); } catch {} },
  };
}

export async function run(args) {
  let opts;
  try { opts = await resolveResume(buildOptions(args), args.flags); } catch (e) { err(e.message); return 2; }

  let p;
  try {
    p = spawnPlay(opts, { onSession: dir => process.stdout.write(`snapper: session ${dir}\n`) });
  } catch (e) { err(e.message); return 1; }
  // Ctrl+C: ask the window to close (it saves the exit state, D-021) through a quit file; a second Ctrl+C,
  // or no exit within 20 s, kills it.
  let sigs = 0, hardKill = null;
  const onSig = () => {
    if (++sigs === 1) {
      p.quit();
      err("closing: saving the exit state (Ctrl+C again to kill)");
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
  if (result?.outbox) process.stdout.write(`snapper: outbox ${result.outbox}
`);     // tester mode (v1.4): the zip to send
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
