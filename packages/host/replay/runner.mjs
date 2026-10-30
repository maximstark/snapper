// Replay runner (BRIEF 4.4, D-011, D-013, D-014; engine-neutral since v1.2). Drives a page driver (driver-electron.mjs:
// Electron's own Chromium) through snapper.__host: positions the game by the SDK's last tick, steps the recorded input
// mask frame by frame around the mark, dumps frames and state, compares the state at the mark.
// No engine import here: plain Node can load this file (the CLI does, for Refusal and firstDiff).
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  serveStatic, segmentForMark, maskAt, codesOf, stepExpression,
  dataUrlToBuffer, stateLine, fmtT, firstDiff, compareState, compareStateAll, stepTo, chooseQuery, sessionGameRoot,
} from "../../core/index.mjs";

const SDK_PATH = fileURLToPath(new URL("../../sdk/snapper.js", import.meta.url));
const READY_TIMEOUT_MS = 60000;
const MAX_SHEET_TILES = 120;

/** Thrown for things the user must fix; the CLI maps it to exit 2. */
export class Refusal extends Error {}

// firstDiff moved to core (shared with the resume flow, D-021); re-exported for existing callers.
export { firstDiff };

const show = v => {
  const s = v === undefined ? "(missing)" : JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
};

const pad6 = n => String(Math.max(0, n)).padStart(6, "0");

/** "60..120" style compact list of frame numbers. */
function compactFrames(frames) {
  if (!frames.length) return "(none)";
  const out = [];
  let start = frames[0], prev = frames[0], step = null;
  const flush = () => out.push(start === prev ? `${start}` : `${start}..${prev}${step > 1 ? ` step ${step}` : ""}`);
  for (let i = 1; i < frames.length; i++) {
    const d = frames[i] - prev;
    if (step === null) step = d;
    if (d !== step) {
      flush();
      start = frames[i];
      step = null;
    }
    prev = frames[i];
  }
  flush();
  return out.join(", ");
}

export function buildUrl(env, serverUrl, query, pauseParam) {
  let url = env.game.url;
  if (serverUrl) url = serverUrl + new URL(env.game.url).pathname;
  const add = (u, extra) => (extra ? u + (u.includes("?") ? "&" : "?") + extra : u);
  if (query) url = add(url, String(query).replace(/^[?&]+/, ""));
  const pp = pauseParam || "paused";
  if (!new RegExp(`[?&]${pp}(=|&|#|$)`).test(url)) url = add(url, pp);
  return url;
}

/**
 * Run a replay on `driver` (the caller creates and closes it). `opts`: { sessionDir, session, tape, mark, before,
 * after, every, out, query, log }. Returns { outDir, result, diff } where result is the replay.json object.
 */
export async function replayMark(driver, opts) {
  const { sessionDir, session, tape, mark, before, after, every } = opts;
  // D-022: boot with the mark's segment query (its reload marker), else env.game.query; --query overrides.
  const log = opts.log || (() => {});
  const env = session.env || {};
  const markFrame = mark.frame;
  const seg = segmentForMark(tape.lines, mark);
  const keymap = tape.header?.keymap?.length ? tape.header.keymap : env.sdk?.keymap || [];
  const pauseParam = tape.header?.pauseParam || env.sdk?.pauseParam || "paused";
  const frames = seg.frames;
  const q = chooseQuery({ override: opts.query, lines: tape.lines, index: seg.index, envQuery: env.game?.query });
  const firstFrame = frames[0].f;
  const target = Math.max(firstFrame, markFrame - before);
  const endFrame = markFrame + after;
  const warnings = [];
  const outDir = opts.out || join(sessionDir, ...(mark.dir || `marks/${mark.id}`).split("/"), "replay");

  if (!env.game?.url) throw new Refusal("env.json has no game.url; cannot replay");
  const sdkSource = await readFile(SDK_PATH, "utf8");

  const win = env.window || {};
  const dprWanted = env.display?.dpr;
  if (typeof dprWanted === "number" && dprWanted !== driver.dpr) {
    warnings.push(`the session was recorded at devicePixelRatio ${dprWanted}, this display is ${driver.dpr}; frames may differ in size or sharpness`);
  }
  if (typeof win.w === "number" && typeof win.h === "number" && driver.size
    && (driver.size.w !== Math.round(win.w) || driver.size.h !== Math.round(win.h))) {
    warnings.push(`the session's window was ${Math.round(win.w)}x${Math.round(win.h)}, the replay window is ${driver.size.w}x${driver.size.h}; layout-dependent games may differ`);
  }

  let server = null;
  try {
    let serverUrl = null;
    const gameRoot = await sessionGameRoot(sessionDir, env);       // v1.4: an imported tester session replays on the importer's root
    if (env.game.url.startsWith("http://127.0.0.1:") && gameRoot) {
      server = await serveStatic(gameRoot, { coi: env.config?.crossOriginIsolated === true });   // as recorded (--coi, v1.3)
      serverUrl = server.url;
    }
    const url = buildUrl(env, serverUrl, q.query, pauseParam);
    log(`url ${url} (query from ${q.source})`);
    if (q.source === "override") log(`warning: --query overrides the segment query (recorded: ${JSON.stringify(chooseQuery({ lines: tape.lines, index: seg.index, envQuery: env.game?.query }).query)})`);

    const pageErrors = driver.pageErrors;
    await driver.addInitScript(`globalThis.__snapperBridge = { send() {}, sendTape() {} };\n${sdkSource}`);
    await driver.goto(url);
    try {
      await driver.waitForStepper(READY_TIMEOUT_MS);
    } catch {
      throw new Error(`the game did not report a stepper within ${READY_TIMEOUT_MS / 1000} s at ${url}`
        + (pageErrors.length ? `; page errors: ${pageErrors.join(" | ")}` : "; no SDK, or the game never called registerStepper"));
    }
    await driver.evaluate("(()=>{globalThis.snapper.__host.pause();return true})()");

    const frameNow = () => driver.evaluate("globalThis.snapper.frame()");
    const step = (n, mask) => driver.evaluate(stepExpression([{ n, codes: codesOf(mask, keymap) }]));

    // Position (D-014): last tick = snapper.frame(); each step's codes come from the mask at lastTick + 1.
    // Shared with the resume flow (core stepTo): chunks of runs per evaluate, single steps on a skew.
    let last = await frameNow();
    if (last >= target && last >= 0) {
      warnings.push(`the game was already at frame ${last} (target ${target}) after boot; positioning may be off`);
    }
    let steps = 0;
    const toFrame = target - 1;
    if (last < toFrame) {
      const pos = await stepTo({
        frames, keymap, last, to: toFrame, chunk: 2000,
        stepRuns: runs => driver.evaluate(stepExpression(runs)),
      });
      for (const w of pos.warnings) warnings.push(`while positioning: ${w}`);
      steps = pos.steps;
      last = pos.last;
    }
    if (last !== toFrame && last < target) warnings.push(`positioned at frame ${last}, wanted ${toFrame}`);
    log(`positioned at frame ${last} after ${steps} steps`);

    // Dump window.
    await mkdir(outDir, { recursive: true });
    for (const f of await readdir(outDir)) {
      if (/^f\d{6}\.png$/.test(f) || ["sheet.png", "replay.json", "replay.md"].includes(f)) await rm(join(outDir, f), { force: true });
    }

    const dumped = [];       // { frame, state, png: Buffer, file }
    let useShot = false, skewWarned = false, noFrameWarned = false;
    let recordedAtMark = null;
    for (let want = target; want <= endFrame; want++) {
      await step(1, maskAt(frames, want));
      steps++;
      const got = await frameNow();
      if (got !== want && !skewWarned) {
        warnings.push(`tick numbering skipped in the dump window (expected frame ${want}, got ${got})`);
        skewWarned = true;
      }
      const dump = (want - target) % every === 0 || got === markFrame || want === markFrame;
      if (!dump) continue;
      const stateStr = await driver.evaluate("globalThis.snapper.__host.state()");
      let state;
      try { state = JSON.parse(stateStr); } catch { state = { error: "state was not JSON", raw: String(stateStr).slice(0, 200) }; }
      let png = null;
      if (!useShot) {
        const dataUrl = await driver.evaluate("globalThis.snapper.__host.frame()");
        if (dataUrl) png = dataUrlToBuffer(dataUrl);
        else {
          useShot = true;
          if (!noFrameWarned) { warnings.push("the game has no frame provider; frames are page screenshots"); noFrameWarned = true; }
        }
      }
      if (!png) png = await driver.screenshot();
      const file = `f${pad6(got)}.png`;
      await writeFile(join(outDir, file), png);
      dumped.push({ frame: got, state, png, file });
      if (got === markFrame && !recordedAtMark) recordedAtMark = dumped[dumped.length - 1];
    }
    log(`dumped ${dumped.length} frames`);

    // Compare with the recorded state.
    const statePath = join(sessionDir, ...(mark.dir || `marks/${mark.id}`).split("/"), "state.json");
    let recorded = null;
    try { recorded = JSON.parse(await readFile(statePath, "utf8")); } catch {}
    let stateMatches = false, diff = null, diffs = [];
    if (recorded == null) {
      diff = { path: "$", recorded: undefined, replayed: recordedAtMark?.state };
      warnings.push("state.json is missing or unreadable; nothing to compare against");
    } else if (!recordedAtMark) {
      diff = { path: "$", recorded, replayed: undefined };
      warnings.push(`the replay never reached the mark frame ${markFrame}`);
    } else {
      diff = compareState(recorded, recordedAtMark.state);
      diffs = compareStateAll(recorded, recordedAtMark.state);
      stateMatches = !diff;
      if (stateMatches && recorded.unavailable) warnings.push("the game has no state provider; stateMatches is true but proves nothing");
    }

    const result = {
      mark: mark.id, frameAt: markFrame, before, after, every,
      chromium: driver.version, engine: driver.engine, dpr: driver.dpr, stateMatches, query: q.query, querySource: q.source,
      ...(diff ? { firstDiff: diff.path, diffs: diffs.length ? diffs : [diff.path] } : {}),
      warnings,
      frames: dumped.map(d => ({ frame: d.frame, state: d.state })),
    };
    if (pageErrors.length) result.pageErrors = [...pageErrors];

    await writeFile(join(outDir, "replay.json"), JSON.stringify(result, null, 2) + "\n");

    // Contact sheet, composed by the driver in a blank hidden window (no SDK there).
    const stride = Math.max(1, Math.ceil(dumped.length / MAX_SHEET_TILES));
    const picked = dumped.filter((d, i) => i % stride === 0 || d.frame === markFrame);
    if (stride > 1) warnings.push(`sheet.png shows every ${stride}th dumped frame (${picked.length} of ${dumped.length} tiles)`);
    const tiles = picked.map(d => ({ src: `data:image/png;base64,${d.png.toString("base64")}`, label: `f${d.frame}${d.frame === markFrame ? "  << MARK" : ""}` }));
    const sheetUrl = await driver.composeSheet(tiles, { columns: picked.length > 60 ? 10 : 6 });
    if (sheetUrl) await writeFile(join(outDir, "sheet.png"), dataUrlToBuffer(sheetUrl));

    const md = renderReplayMd({ sessionDir, mark, result, dumped, recorded, replayedAtMark: recordedAtMark?.state, diff, outDir, steps, stride });
    await writeFile(join(outDir, "replay.md"), md);
    return { outDir, result, diff };
  } finally {
    if (server) await server.close().catch(() => {});
  }
}

function renderReplayMd({ sessionDir, mark, result, dumped, recorded, replayedAtMark, diff, steps, stride }) {
  const L = [];
  const frames = dumped.map(d => d.frame);
  L.push(`# Replay of mark ${mark.id} at frame ${result.frameAt}`);
  L.push("");
  L.push(`Session: ${sessionDir}`);
  L.push(`Trigger: ${mark.trigger}${mark.t != null ? ` at ${fmtT(mark.t)}` : ""} · Note: ${mark.note || "(none)"} · Summary: ${mark.summary ?? ""}`);
  L.push(`Query: ${result.query ? result.query : "(none)"} (${{ marker: "the segment's reload marker", env: "env.json game.query", override: "--query override" }[result.querySource] || result.querySource})`);
  L.push(`Window: frames ${frames[0]}..${frames[frames.length - 1]} (before ${result.before}, after ${result.after}, every ${result.every}) · ${dumped.length} PNGs · ${steps} steps · Chromium ${result.chromium}${result.engine === "electron" ? " (Electron)" : ""}`);
  L.push("");
  if (result.stateMatches) {
    L.push(`stateMatches: true — the replayed state at frame ${result.frameAt} equals the recorded state.json (top-level perf ignored). The replay can be trusted.`);
  } else {
    L.push("!!! stateMatches: FALSE — THIS REPLAY IS NOT TRUSTWORTHY !!!");
    L.push(`First difference at ${diff?.path ?? "?"}: recorded ${show(diff?.recorded)} · replayed ${show(diff?.replayed)}`);
    if (result.diffs?.length > 1) L.push(`Differs at: ${result.diffs.join(", ")}`);
    L.push("The replay diverged from what the player saw. (A first difference at $.level or $.scene often means the wrong query: the segment boots with a different level than the player was in; pass --query \"?...\" matching the mark's state.) Do not use these frames or states as evidence of the bug; the game may be nondeterministic, the code may have changed since the session (check git.dirty and the sha in env.json), or the tape/keymap is incomplete.");
  }
  L.push("");
  L.push(`Recorded state: ${stateLine(recorded)}`);
  L.push(`Replayed state: ${stateLine(replayedAtMark)}`);
  if (result.warnings.length) {
    L.push("");
    L.push("Warnings:");
    for (const w of result.warnings) L.push(`- ${w}`);
  }
  if (result.pageErrors?.length) {
    L.push("");
    L.push("Page errors during the replay:");
    for (const e of result.pageErrors) L.push(`- ${e}`);
  }
  L.push("");
  L.push(`Dumped frames: ${compactFrames(frames)}`);
  L.push("");
  L.push("Open first:");
  L.push(`1. f${pad6(result.frameAt)}.png — the mark frame itself (compare with the mark's frame.png)`);
  L.push(`2. sheet.png — overview of the lead-up and aftermath${stride > 1 ? ` (every ${stride}th frame)` : ""}, then the frames just before the mark`);
  L.push(`3. replay.json — the state at every dumped frame (find where a value first goes wrong)`);
  const rows = dumped.length <= 12 ? dumped : dumped.filter((d, i) => i % Math.ceil(dumped.length / 12) === 0 || d.frame === result.frameAt);
  L.push("");
  L.push("State by frame:");
  for (const d of rows) L.push(`- ${d.frame}${d.frame === result.frameAt ? " (mark)" : ""}: ${stateLine(d.state)}`);
  L.push("");
  return L.join("\n");
}
