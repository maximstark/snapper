// The `snapper check` process (v1.3): an Electron main process started by tools/check.mjs with SNAPPER_CHECK_OPTS (JSON)
// and SNAPPER_RESULT_FILE. entry.mjs imports this module at its top level, so the code below runs BEFORE Electron's
// `ready`; never await app.whenReady() here at the top level (it would deadlock). runCheckChild does it.
import { app, Menu } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInProcess } from "./inprocess.mjs";
import { Refusal } from "./runner.mjs";

// A throwaway profile of its own (set before ready, so %APPDATA%\Electron is never created); the parent deletes it.
const userData = join(tmpdir(), "snapper-check-" + process.pid);
try { mkdirSync(userData, { recursive: true }); app.setPath("userData", userData); } catch {}
// The check closes its windows before it is done; Electron must not quit on its own.
app.on("window-all-closed", () => {});

const writeResult = (file, value) => {
  try { if (file) writeFileSync(file, JSON.stringify(value)); } catch (e) { process.stderr.write(`check: cannot write the result file: ${e.message}\n`); }
};

/** Run the check described by SNAPPER_CHECK_OPTS. Returns the exit code (the summary's, or 2 refusal, 1 error); never throws. */
export async function runCheckChild() {
  const resultFile = process.env.SNAPPER_RESULT_FILE;
  try {
    const req = JSON.parse(process.env.SNAPPER_CHECK_OPTS || "{}");
    await app.whenReady();
    Menu.setApplicationMenu(null);
    const { rows, summary, checkFile } = await checkInProcess(req, {
      log: s => process.stderr.write("check: " + s + "\n"),
      onRow: r => { if (r.result !== "skipped") process.stderr.write(`check: ${r.session} ${r.mark} ${r.result}${r.firstDiff ? " " + (r.diffs?.length ? r.diffs.join(", ") : r.firstDiff) : ""}${r.message ? " " + r.message : ""}\n`); },
    });
    writeResult(resultFile, { rows, summary, checkFile });
    return summary.exit;
  } catch (e) {
    if (e instanceof Refusal) {
      writeResult(resultFile, { error: e.message, refusal: true });
      return 2;
    }
    writeResult(resultFile, { error: String(e && e.stack || e) });
    return 1;
  }
}
