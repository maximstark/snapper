// Replay entry points shared by the CLI parent (plain Node: prepareReplay), the replay child (child.mjs) and the
// launcher (replayInProcess, inside an Electron main process). No static Electron import: the driver is imported
// dynamically, only by replayInProcess.
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { readSession, readTape, segmentForMark, writeSummary, atomicWrite, gitInfo, SNAPPER_VERSION } from "../../core/index.mjs";
import { replayMark, Refusal } from "./runner.mjs";
import { planCheck, finishCheck, publicRow } from "../tools/check.mjs";

/**
 * Validate a replay request and load what the runner needs. Plain Node. Throws Refusal (exit 2 in the CLI) for
 * everything the user must fix, before any Electron process is started.
 * req: { sessionDir, markId, before = 30, after = 30, every = 1, out = null, query }.
 */
export async function prepareReplay({ sessionDir: dirArg, markId, before = 30, after = 30, every = 1, out = null, query } = {}) {
  const sessionDir = resolve(String(dirArg));
  if (!existsSync(sessionDir)) throw new Refusal(`session folder not found: ${sessionDir}`);
  const session = await readSession(sessionDir);
  if (!session.header && !session.lines.length) throw new Refusal(`not a session folder (no session.jsonl lines): ${sessionDir}`);
  const wanted = String(markId).trim();
  const n = /^\d+$/.test(wanted) ? Number(wanted) : NaN;
  const mark = session.marks.find(m => m.id === wanted || (Number.isFinite(n) && Number(m.id) === n));
  if (!mark) {
    const ids = session.marks.map(m => m.id).join(", ") || "none";
    throw new Refusal(`mark "${markId}" does not exist in ${sessionDir} (marks: ${ids})`);
  }
  const stepper = session.ready?.stepper ?? session.env?.sdk?.stepper;
  if (!stepper) throw new Refusal(`mark ${mark.id} is not replayable: the session's game registered no stepper (see SESSION.md, "SDK:")`);
  if (mark.replayable === false) throw new Refusal(`mark ${mark.id} is not replayable: ${mark.replayableReason || "the session was attached without a reload, so the game booted without Snapper (see SESSION.md)"}`);
  const tape = await readTape(sessionDir);
  if (!segmentForMark(tape.lines, mark)) throw new Refusal(`mark ${mark.id} is not replayable: tape.jsonl has no frame lines`);
  if (!Number.isInteger(mark.frame) || mark.frame < 0) throw new Refusal(`mark ${mark.id} is not replayable: it carries no game frame (frame ${mark.frame})`);
  if (query === true || (query !== undefined && query !== null && typeof query !== "string")) {
    throw new Refusal("--query needs a value, e.g. --query \"?scene=stage&level=2-1\"");
  }
  return {
    sessionDir, session, tape, mark, before, after, every,
    out: out ? resolve(String(out)) : null,
    query: query ?? undefined,
  };
}

/**
 * Run a replay inside the current Electron main process (call after app.whenReady()). Returns { outDir, result }.
 * req is the object prepareReplay takes; the launcher passes { sessionDir, markId, before, after, every, out, query }.
 */
export async function replayInProcess(req, { headed = false, log = () => {} } = {}) {
  const prepared = await prepareReplay(req);
  const win = prepared.session.env?.window || {};
  const { createElectronDriver } = await import("./driver-electron.mjs");
  const driver = await createElectronDriver({
    width: Math.round(win.w) || 1280, height: Math.round(win.h) || 720, headed,
  });
  let outDir, result;
  try {
    ({ outDir, result } = await replayMark(driver, { ...prepared, log }));
  } finally {
    await driver.close();
  }
  try { await writeSummary(prepared.sessionDir); } catch (e) { log(`could not regenerate SESSION.md (${e.message})`); }
  return { outDir, result };
}

/**
 * `snapper check` inside the current Electron main process (call after app.whenReady(); v1.3). Plans (a Refusal for a bad
 * root / no sessions), replays every replayable mark of the selected sessions on the CURRENT code of req.root with one
 * hidden driver window per session (the game booted once per tape segment, stepped from mark to mark), compares with the
 * expectation, optionally accepts (writes marks/NNNN/expected.json only), writes check.json.
 * req: the object tools/check.mjs checkArgs makes. onRow(row) is called as each row is known (skipped rows first).
 * Resolves { rows, summary, checkFile }.
 */
export async function checkInProcess(req, { log = () => {}, onRow = () => {} } = {}) {
  const t0 = Date.now();
  const plan = await planCheck(req);
  const rows = [];
  const push = row => { rows.push(row); try { onRow(publicRow(row)); } catch {} };
  for (const r of plan.rows) push(r);
  const jobs = plan.sessions.filter(s => s.items.length);
  let createElectronDriver = null;
  if (jobs.length) ({ createElectronDriver } = await import("./driver-electron.mjs"));
  const { checkSession } = await import("./check-runner.mjs");
  const git = req.accept ? gitInfo(req.root) : null;

  for (const sp of jobs) {
    const win = sp.session.env?.window || {};
    const rowOf = (it, extra) => ({ ...it.row, ...extra, _ord: it.ord });
    let driver = null;
    const seen = new Set();
    try {
      driver = await createElectronDriver({ width: Math.round(win.w) || 1280, height: Math.round(win.h) || 720 });
      await checkSession(driver, sp, {
        root: req.root, query: req.query, log,
        onResult: async (it, out) => {
          seen.add(it.ord);
          const extra = out.result === "error" ? { result: "error", message: out.message }
            : out.result === "differs" ? { result: "differs", firstDiff: out.firstDiff, diffs: out.diffs?.length ? out.diffs : [out.firstDiff] } : { result: "match" };
          if (req.accept && out.state !== undefined) {
            try {
              const dir = join(sp.dir, ...(it.mark.dir || `marks/${it.markId}`).split("/"));
              const doc = {
                state: out.state, frame: it.frame, acceptedAt: new Date().toISOString(),
                git: git ? { sha: git.sha, dirty: git.dirty } : null, host: SNAPPER_VERSION,
              };
              await atomicWrite(join(dir, "expected.json"), JSON.stringify(doc, null, 2) + "\n");
              extra.accepted = true;
            } catch (e) { log(`could not write expected.json for ${sp.id}/${it.markId}: ${e.message}`); }
          }
          push(rowOf(it, extra));
        },
      });
    } catch (e) {
      // the driver or the runner broke: every mark of this session not yet reported is an error
      const m = String((e && e.message) || e).split("\n")[0].slice(0, 300);
      for (const it of sp.items) if (!seen.has(it.ord)) push(rowOf(it, { result: "error", message: m }));
    } finally {
      if (driver) await driver.close().catch(() => {});
    }
  }
  return await finishCheck(req, plan, rows, t0);
}
