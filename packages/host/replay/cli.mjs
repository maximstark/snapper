// snapper replay <session-dir> <mark-id> [--before 30] [--after 30] [--every 1] [--out <dir>] [--query '?...'] [--headed]
// Exit codes: 0 the replay ran (stateMatches may still be false), 2 refusal, 1 error.
// Runs in plain Node (or the exe in RUN_AS_NODE mode): refusals happen here, then the replay itself runs in an
// Electron child (replay/child.mjs on the single entry) that reports through a result file.
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeSummary } from "../../core/index.mjs";
import { electronCommand, electronChildEnv } from "../main/electron-bin.mjs";
import { Refusal } from "./runner.mjs";
import { prepareReplay } from "./inprocess.mjs";

const err = s => process.stderr.write(s.endsWith("\n") ? s : s + "\n");
const readResult = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

function intFlag(flags, name, def, min) {
  const v = flags[name];
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Refusal(`--${name} must be an integer >= ${min} (got "${v}")`);
  return n;
}

/**
 * Pure: parse and validate the CLI arguments into the JSON-serialisable options of the replay child,
 * { sessionDir (absolute), markId, before, after, every, out, query, headed }. Throws Refusal.
 */
export function replayChildOptions({ positional = [], flags = {} } = {}) {
  const [dirArg, markArg] = positional;
  if (!dirArg || markArg === undefined) {
    throw new Refusal("usage: snapper replay <session-dir> <mark-id> [--before 30] [--after 30] [--every 1] [--out <dir>] [--query '?...'] [--headed]");
  }
  const before = intFlag(flags, "before", 30, 0);
  const after = intFlag(flags, "after", 30, 0);
  const every = intFlag(flags, "every", 1, 1);
  if (flags.query === true) throw new Refusal("--query needs a value, e.g. --query \"?scene=stage&level=2-1\"");
  const query = typeof flags.query === "string" ? flags.query : undefined;
  const out = flags.out && flags.out !== true ? resolve(flags.out) : null;
  return { sessionDir: resolve(dirArg), markId: String(markArg), before, after, every, out, query, headed: !!flags.headed };
}

export async function run({ positional, flags = {} }) {
  try {
    const opts = replayChildOptions({ positional, flags });
    await prepareReplay(opts);                 // every refusal, before any Electron process starts

    const command = electronCommand();
    const resultFile = join(tmpdir(), `snapper-replay-result-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.json`);
    const env = electronChildEnv({ SNAPPER_REPLAY_OPTS: JSON.stringify(opts), SNAPPER_RESULT_FILE: resultFile });
    // windowsHide would also hide a --headed window (it sets SW_HIDE in the start-up info).
    const child = spawn(command.exe, command.args, { env, stdio: ["ignore", "ignore", "inherit"], windowsHide: !opts.headed });
    const code = await new Promise(res => {
      child.on("error", e => { err(`snapper replay: cannot start Electron (${command.exe}): ${e.message}`); res(null); });
      child.on("exit", (c, sig) => res(c ?? (sig ? 1 : 0)));
    });
    // Electron cannot delete its profile while it holds files; the child is gone now.
    try { if (child.pid) rmSync(join(tmpdir(), `snapper-replay-${child.pid}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    const result = readResult(resultFile);
    try { rmSync(resultFile, { force: true }); } catch {}
    if (code === null) return 1;

    if (!result) {
      err(`snapper replay: the replay process exited with code ${code} and reported no result`);
      return 1;
    }
    if (result.error) {
      err(`snapper replay: ${result.error}`);
      return result.refusal ? 2 : 1;
    }
    const { outDir, result: r } = result;
    try { await writeSummary(opts.sessionDir); } catch (e) { err(`replay: could not regenerate SESSION.md (${e.message})`); }
    if (!r.stateMatches) {
      err(`replay: stateMatches is FALSE (first diff ${r.firstDiff}) — this replay is NOT trustworthy; see ${outDir}`);
    }
    for (const w of r.warnings || []) err(`replay: warning: ${w}`);
    process.stdout.write(`${outDir}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      err(`snapper replay: ${e.message}`);
      return 2;
    }
    err(`snapper replay: ${e && e.stack || e}`);
    return 1;
  }
}
