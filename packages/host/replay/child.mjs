// The replay process (BRIEF-v1.2 §2): an Electron main process started by replay/cli.mjs with SNAPPER_REPLAY_OPTS
// (JSON) and SNAPPER_RESULT_FILE. entry.mjs imports this module at its top level, so the code below runs BEFORE
// Electron's `ready`; never await app.whenReady() here at the top level (it would deadlock). runReplayChild does it.
import { app, Menu } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayInProcess } from "./inprocess.mjs";
import { Refusal } from "./runner.mjs";

// A throwaway profile of its own, so this process never collides with a running launcher or play host. The parent
// (cli.mjs) deletes the folder after the child exits.
const userData = join(tmpdir(), "snapper-replay-" + process.pid);
try { mkdirSync(userData, { recursive: true }); app.setPath("userData", userData); } catch {}
// The replay closes its windows before it is done; Electron must not quit on its own.
app.on("window-all-closed", () => {});

const writeResult = (file, value) => {
  try { if (file) writeFileSync(file, JSON.stringify(value)); } catch (e) { process.stderr.write(`replay: cannot write the result file: ${e.message}\n`); }
};

/** Run the replay described by SNAPPER_REPLAY_OPTS. Returns the exit code (0 ran, 2 refusal, 1 error); never throws. */
export async function runReplayChild() {
  const resultFile = process.env.SNAPPER_RESULT_FILE;
  try {
    const opts = JSON.parse(process.env.SNAPPER_REPLAY_OPTS || "{}");
    await app.whenReady();
    Menu.setApplicationMenu(null);
    const { outDir, result } = await replayInProcess(opts, {
      headed: !!opts.headed,
      log: s => process.stderr.write("replay: " + s + "\n"),
    });
    writeResult(resultFile, { outDir, result });
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      writeResult(resultFile, { error: e.message, refusal: true });
      return 2;
    }
    writeResult(resultFile, { error: String(e && e.stack || e) });
    return 1;
  }
}
