// Resume (D-021): restore a checkpoint by replaying the source session's tape segment to its frame.
// The game boots paused (pauseParam), audio muted, gamepads hidden from it and keys blocked while the
// host steps it in chunks (one evaluate each, so the restore overlay repaints), then the live state is
// compared with the saved one, the new tape gets the copied segment + a `resume` marker, and the game resumes.
import { readTape, readCheckpoint, pickSegment, chooseQuery, resumeTapeLines, stepTo, stepExpression, compareState, round1 } from "../../core/index.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const n0 = n => Number(n).toLocaleString("en-US");

// Chunk tuning (D-021): start at START frames per evaluate, then aim at TARGET_MS per evaluate.
export const CHUNK = { start: 500, min: 300, max: 6000, targetMs: 100 };

const BLOCK_PADS = `(()=>{try{var n=navigator;if(!n.__snapperGP){n.__snapperGP=n.getGamepads;n.getGamepads=function(){return []}}return 1}catch(e){return 0}})()`;
const UNBLOCK_PADS = `(()=>{try{var n=navigator;if(n.__snapperGP){delete n.getGamepads;delete n.__snapperGP}return 1}catch(e){return 0}})()`;
const FRAME_EXPR = `(()=>{try{return globalThis.snapper.frame()}catch(e){return null}})()`;
const STATE_ONLY = `(()=>{try{return globalThis.snapper.__host.state()}catch(e){return null}})()`;
const stripParam = p => `(()=>{try{var u=new URL(location.href);if(u.searchParams.has(${JSON.stringify(p)})){u.searchParams.delete(${JSON.stringify(p)});history.replaceState(history.state,"",u.pathname+u.search+u.hash)}return 1}catch(e){return 0}})()`;

/** Read what the restore needs from the source session. R comes from cli-play resolveResume. */
export async function loadResume(R) {
  const tape = await readTape(R.session);
  const base = await readCheckpoint(R.session, R.base);
  if (!base) throw new Error(`cannot read checkpoint ${R.base} in ${R.session}`);
  const ref = R.compareWith ? (R.compareWith === R.base ? base : await readCheckpoint(R.session, R.compareWith)) : null;
  const seg = pickSegment(tape.lines, base.segment, base.t);
  // D-022: the segment's own query (its reload marker), else the session's; an explicit --query wins.
  const q = chooseQuery({ override: R.queryOverride, lines: tape.lines, index: seg.index, envQuery: R.envQuery });
  return {
    ...R, from: `${R.sessionId}/${R.checkpoint}`, refState: ref ? ref.state : null, segLines: seg.lines, segIndex: seg.index,
    query: q.query, querySource: q.source, queryOverride: q.source === "override",
  };
}

/**
 * Run the restore. host needs: evalRaw, evalJson, setMuted, writer, toOverlay, finishRestoreTape(lines), warn.
 * Resolves { matched, firstDiff, frames, ms, fps, last, error? }. Never throws.
 */
export async function runRestore(host, R) {
  const w = host.writer;
  const target = R.frame;
  const started = Date.now();
  const label = `Restoring to frame ${n0(target)}`;
  const show = (pct, extra = "") => host.toOverlay("restore", { text: `${label} · ${Math.floor(pct)} %${extra}`, pct });
  const { frames } = resumeTapeLines(R.segLines, target, { from: R.from });
  let last = -1, steps = 0, chunks = 0, warnings = [], error = null;
  let msPerFrame = null, chunk = CHUNK.start;
  host.setMuted(true);
  show(0);
  await host.evalRaw(BLOCK_PADS);
  try {
    await host.evalRaw(`(()=>{try{globalThis.snapper.__host.pause()}catch(e){}return 1})()`);
    const f0 = await host.evalRaw(FRAME_EXPR);
    last = Number.isInteger(f0) ? f0 : -1;
    const startFrame = last;
    let tChunk = Date.now();
    const res = await stepTo({
      frames, keymap: R.keymap, last, to: target, chunk: () => chunk,
      stepRuns: async runs => {
        tChunk = Date.now();
        const v = await host.evalRaw(stepExpression(runs), 120000);
        if (!Number.isInteger(v)) throw new Error("the game stopped answering while stepping (evaluate failed)");
        return v;
      },
      onChunk: ({ last: l, frames: n }) => {
        const ms = Date.now() - tChunk;
        if (n >= 50 && ms > 0) {
          const m = ms / n;
          msPerFrame = msPerFrame == null ? m : msPerFrame * 0.6 + m * 0.4;
          chunk = Math.max(CHUNK.min, Math.min(CHUNK.max, Math.round(CHUNK.targetMs / msPerFrame)));
        }
        const done = l - startFrame, total = target - startFrame;
        const pct = total > 0 ? (100 * done) / total : 100;
        const eta = msPerFrame != null ? Math.ceil(((target - l) * msPerFrame) / 1000) : null;
        show(pct, eta != null ? ` · ~${eta} s left` : "");
      },
    });
    last = res.last; steps = res.steps; chunks = res.chunks; warnings = res.warnings;
    if (last !== target) error = `stopped at frame ${last}, not ${target}`;
  } catch (err) {
    error = String(err && err.message || err);
  }
  const ms = Date.now() - started;
  const fps = ms > 0 ? Math.round((steps * 1000) / ms) : null;

  // Compare the live state with the saved one (D-014 compare: top-level perf ignored).
  let matched = null, diff = null;
  if (!error && R.refState) {
    const s = await host.evalRaw(STATE_ONLY, 5000);
    let live = null;
    try { live = JSON.parse(s); } catch {}
    diff = live == null ? { path: "$" } : compareState(R.refState, live);
    matched = !diff;
  } else if (error) matched = false;

  // The new tape: copied segment up to where the game really is, then the resume marker.
  await host.evalRaw(`(()=>{try{globalThis.snapper.__host.flush()}catch(e){}return 1})()`);
  await sleep(120);                                      // in-flight restore ticks reach main (and are dropped)
  const at = error ? Math.max(-1, last) : target;
  const tape = resumeTapeLines(R.segLines, at, { from: R.from, t: w.t() });
  host.finishRestoreTape(tape.lines, at);

  // Hand control back: release the stepper's held keys, give the pads back, unmute, resume.
  await host.evalRaw(`(()=>{try{globalThis.snapper.__host.step(0,[])}catch(e){}return 1})()`);
  await host.evalRaw(UNBLOCK_PADS);
  await host.evalRaw(stripParam(R.pauseParam || "paused"));
  host.setMuted(false);
  host.toOverlay("restore", null);
  await host.evalRaw(`(()=>{try{globalThis.snapper.__host.resume()}catch(e){}return 1})()`);

  const firstDiff = diff ? diff.path : null;
  const restore = { frames: steps, ms, fps, chunks, from: R.from, segment: R.segIndex, query: R.query, querySource: R.querySource };
  if (warnings.length) restore.warnings = warnings;
  await w.patchEnv({ resumeMatched: matched, ...(firstDiff ? { firstDiff } : {}), restore, ...(error ? { resumeError: error } : {}) });
  w.line("resume", {
    frame: at, from: R.from, matched, ...(firstDiff ? { firstDiff } : {}), ms, fps: fps ?? 0, query: R.query,
    ...(R.queryOverride ? { queryOverride: true } : {}), ...(error ? { error } : {}),
  });
  w.renderSummary().catch(() => {});
  const pretty = firstDiff ? firstDiff.replace(/^\$\.?/, "") || "$" : "";
  const toast = error ? `Restore FAILED at frame ${n0(at)}: ${error}`
    : matched === true ? `Resumed at frame ${n0(target)} ✓`
    : matched === false ? `Resumed at frame ${n0(target)} — state DIFFERS (${pretty}): replay of later marks may not match`
    : `Resumed at frame ${n0(target)} (no saved state to compare)`;
  host.toOverlay("toast", { text: toast, ms: matched === true ? 4000 : 9000 });
  host.warn(`resume: ${toast} · ${n0(steps)} frames in ${round1(ms / 1000)} s (${fps ?? "?"} frames/s)${warnings.length ? " · " + warnings.join("; ") : ""}`);
  return { matched, firstDiff, frames: steps, ms, fps, last: at, error };
}
