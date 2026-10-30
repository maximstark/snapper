// Mark capture (BRIEF §4.1 "Marks"): id → flush → overlay hidden → shot → overlay restored → one evaluate
// (frame + state + game frame) → ring snapshot → files → the `mark` line LAST → SESSION.md.
import { dataUrlToBuffer, pngSize, isErrorLine, buildPerfJson, longTasksOf, segmentForMark, frameLinesWindow, fmtT, round1 } from "../../core/index.mjs";
import { rectsNear, scaleRects, oneLine } from "./helpers.mjs";
import { saveCheckpoint } from "./checkpoints.mjs";

const nowMs = () => performance.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const COMBINED_EXPR = `(()=>{try{var s=globalThis.snapper;if(!s||!s.__host)return JSON.stringify({sdk:false});var o={sdk:true};
try{s.__host.flush()}catch(e){}
try{o.frame=s.frame()}catch(e){o.frame=-1}
try{o.state=s.__host.state()}catch(e){o.state=JSON.stringify({error:String(e&&e.message||e)})}
try{o.img=s.__host.frame()}catch(e){o.img=null}
return JSON.stringify(o)}catch(e){return JSON.stringify({sdk:false,error:String(e)})}})()`;

export const FLUSH_EXPR = `(()=>{try{var s=globalThis.snapper;if(s&&s.__host)s.__host.flush();return 1}catch(e){return 0}})()`;

function summaryFor(trigger, o) {
  if (o.note) return oneLine(o.note);
  if (o.summary) return oneLine(o.summary);
  return trigger;
}

/** Take one mark. Never throws; resolves { id } (or null when even the folder could not be made). */
export async function takeMark(host, trigger, o = {}) {
  const w = host.writer;
  const cfg = host.config;
  const tMark = w.t();
  const wall0 = nowMs();                             // markCaptureMs starts here (v1.3, D-027)
  const bare = cfg.bare === true;
  const id = w.nextMarkId();
  const rel = w.markRel(id);
  try { await w.makeMarkDir(id, { before: !bare }); } catch (err) { host.warn(`mark ${id}: cannot create folder: ${err.message}`); return null; }

  // Snapshots of the moment of the trigger.
  const ringSnap = host.ring.filter(f => tMark - f.t <= cfg.ringSeconds * 1000 + 250);
  const logSnap = host.logRing.slice(-cfg.logLines);
  const errorsIn = w.lines.filter(l => isErrorLine(l) && l.t >= tMark - 10000 && l.t <= tMark).length;
  const snapP = host.ask("snap", { windowMs: 10000 }, 2500);

  await host.evalRaw(FLUSH_EXPR);

  // Overlay hidden for the capture, restored after (always).
  let shot = null;
  const hide0 = nowMs();                             // hideRoundTripMs (v1.4): the overlay-hide ask, page script included (IPC in play, the binding in attach)
  await host.ask("hide", {}, 1500);
  const hideRoundTripMs = round1(nowMs() - hide0);
  try {
    // (a hidden tab of an attached browser can leave Page.captureScreenshot waiting: give up after 15 s)
    const r = await Promise.race([
      host.cdp("Page.captureScreenshot", { format: "png", fromSurface: true }),
      sleep(15000).then(() => { throw new Error("no answer within 15 s (is the page visible?)"); }),
    ]);
    shot = Buffer.from(r.data, "base64");
  } catch (err) {
    host.warn(`mark ${id}: screenshot failed: ${err.message}`);
  } finally {
    await host.ask("show", {}, 1500);
  }

  // ONE evaluate: frame, state and the game's frame are the same tick.
  let comb = await host.evalJson(COMBINED_EXPR);
  if (!comb) comb = { sdk: false };
  // the synchronous capture ends here: flush + overlay hide + screenshot + overlay show + the one state/frame evaluate
  const captureMs = round1(nowMs() - wall0);
  (host.markCaptureMs ||= {})[id] = captureMs;
  await sleep(40);                                   // let the flushed tape reach main
  const frame = Number.isInteger(comb.frame) ? comb.frame : -1;

  const snap = await snapP;
  const snapT = snap && snap._t != null ? snap._t : w.t();
  const intervals = snap?.intervals || [];
  const endsT = (snap?.ends || []).map(e => snapT - (snap.now - e));
  const wall = host.wall.filter(l => l.t >= tMark - 10000 && l.t <= tMark + 250);

  // state.json
  let state;
  if (!comb.sdk) state = { unavailable: true };
  else {
    try { state = JSON.parse(comb.state); } catch { state = { error: "state provider returned invalid JSON" }; }
  }
  const stateJson = state;

  // frame.png (only when a provider produced a PNG)
  let framePng = null;
  if (comb.img) {
    const b = dataUrlToBuffer(comb.img);
    if (b && pngSize(b)) framePng = b;
  }

  // perf.json
  let hz = host.displayHz;
  const sorted = intervals.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[sorted.length >> 1] : 1000 / 60;
  const expectedMs = hz ? 1000 / hz : median;
  const perf = buildPerfJson({
    intervals, expectedMs, displayHz: hz || null, seconds: 10,
    longTasks: longTasksOf(intervals, endsT, 100),
    gameStats: state && typeof state === "object" ? state.perf : undefined,
    host: {
      bare,
      ringFrames: bare ? 0 : ringSnap.length,
      ringFps: bare ? 0 : ringFpsOf(ringSnap),
      markCaptureMs: { ...host.markCaptureMs },
      adapter: host.adapter || "electron",           // v1.4: "electron" (play) | "cdp" (attach)
      hideRoundTripMs,                               // v1.4: wall ms of THIS mark's overlay-hide round trip
    },
  });
  const worstMs = intervals.length ? round1(Math.max(...intervals)) : 0;

  // inputs.json
  const seg = segmentForMark(host.tapeFrames, { t: tMark });
  const frames = seg && frame >= 0 ? frameLinesWindow(seg.frames, frame - 600, frame) : [];

  // log.json
  const logJson = logSnap.map(e => {
    const x = { t: e.t, source: e.source, level: e.level, text: e.text };
    if (e.frame !== undefined) x.frame = e.frame;
    return x;
  });

  // before/: ring frames, overlay rectangles blanked, plus the contact sheet (none in a --bare session).
  const beforeTask = bare ? null : writeBefore(host, id, ringSnap, shot);

  const files = [
    shot && w.writeMarkFile(id, "shot.png", shot),
    framePng && w.writeMarkFile(id, "frame.png", framePng),
    w.writeMarkFile(id, "state.json", stateJson),
    w.writeMarkFile(id, "inputs.json", { wall, frames }),
    w.writeMarkFile(id, "log.json", logJson),
    w.writeMarkFile(id, "perf.json", perf),
    o.note && w.writeMarkFile(id, "note.txt", o.note + "\n"),
    beforeTask,
    // every mark is also a save state: the mark's frame + state (D-021)
    saveCheckpoint(host, "mark", { trigger: "mark", markId: id, frame, state: stateJson, t: tMark }),
  ].filter(Boolean);
  const results = await Promise.allSettled(files);
  for (const r of results) if (r.status === "rejected") host.warn(`mark ${id}: ${r.reason && r.reason.message || r.reason}`);

  const summary = summaryFor(trigger, o);
  const line = { id, frame, trigger, dir: rel, summary, errors: errorsIn, worstMs };
  if (o.data !== undefined) line.data = o.data;
  if (host.markLineExtras) Object.assign(line, host.markLineExtras);   // attach --no-reload: replayable:false + the reason
  w.line("mark", line, tMark);                       // LAST: a reader that sees it finds a complete folder
  if (o.note) w.line("note", { mark: id, text: o.note });
  await w.renderSummary().catch(() => {});

  host.onMarkSaved({ id, t: fmtT(tMark), trigger, summary, openNote: !!o.openNote });
  return { id, frame, trigger };
}

/** Captured ring frames per second over the held window (1 decimal); 0 with fewer than two frames. */
export function ringFpsOf(frames) {
  if (!frames || frames.length < 2) return 0;
  const span = frames[frames.length - 1].t - frames[0].t;
  return span > 0 ? round1(((frames.length - 1) * 1000) / span) : 0;
}

async function writeBefore(host, id, ringSnap, shot) {
  const w = host.writer;
  const index = [];
  let sheet = null;
  const pad = ringSnap.length >= 100 ? 3 : 2;
  const tiles = ringSnap.map(f => {
    const h = rectsNear(host.overlayHistory, f.t);
    const rects = h && f.w ? scaleRects(h.rects, h.vw, h.vh, f.w, f.h, 3) : [];
    return {
      src: "data:image/jpeg;base64," + f.buf.toString("base64"),
      label: `t ${(f.t / 1000).toFixed(1)}s  f ${f.frame >= 0 ? f.frame : "-"}`,
      rects,
    };
  });
  let out = null;
  if (tiles.length) {
    try { out = await host.composer.compose(tiles); if (out.bad?.length) host.warn(`compose: ${out.bad.length} tile(s) failed to decode: ${out.bad}`); } catch (err) { host.warn(`compose failed: ${err.message}`); }
  } else if (shot) {
    // No ring frames yet (very early mark): a one-tile sheet from the shot itself (no overlay in it).
    try {
      const r = await host.composer.compose([{ src: "data:image/png;base64," + shot.toString("base64"), label: "shot (no ring frames yet)", rects: [] }]);
      sheet = dataUrlToBuffer(r?.sheet);
    } catch {}
  }
  const writes = [];
  ringSnap.forEach((f, i) => {
    const name = String(i + 1).padStart(pad, "0") + ".jpg";
    let buf = null;
    if (out && out.frames[i]) buf = Buffer.from(out.frames[i], "base64");
    else if (!tiles[i].rects.length) buf = f.buf;     // nothing to blank: the original frame is safe
    if (!buf) return;                                  // needed blanking but compose failed: omit, never leak the overlay
    index.push({ file: name, t: f.t, frame: f.frame });
    writes.push(w.writeMarkFile(id, `before/${name}`, buf));
  });
  if (out?.sheet) sheet = dataUrlToBuffer(out.sheet);
  writes.push(w.writeMarkFile(id, "before/index.json", index));
  if (sheet) writes.push(w.writeMarkFile(id, "before/sheet.png", sheet));
  await Promise.all(writes);
}

