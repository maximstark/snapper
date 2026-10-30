// Checkpoints (D-021): a frame number plus the game's state there, written to <session>/checkpoints/<name>.json
// with a `checkpoint` line in session.jsonl. Manual (hotkey `save`), one per mark, and `exit` on close.
import { makeCheckpoint, writeCheckpoint, checkpointName, segmentOf, isFrameLine } from "../../core/index.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** flush + frame + state in ONE evaluate, so the frame and the state are the same tick. */
export const STATE_EXPR = `(()=>{try{var s=globalThis.snapper;if(!s||!s.__host)return JSON.stringify({sdk:false});var o={sdk:true};
try{s.__host.flush()}catch(e){}
try{o.frame=s.frame()}catch(e){o.frame=-1}
try{o.state=s.__host.state()}catch(e){o.state=JSON.stringify({error:String(e&&e.message||e)})}
return JSON.stringify(o)}catch(e){return JSON.stringify({sdk:false})}})()`;

/**
 * Write one checkpoint. kind: "manual" | "mark" | "exit". o: { trigger, t?, frame?, state?, markId?, reason?, timeoutMs? }.
 * Without frame/state it reads them from the game now. Never throws; resolves { name, frame, restorable, reason } or null.
 */
export async function saveCheckpoint(host, kind, o = {}) {
  const w = host.writer;
  const t = o.t ?? w.t();
  let { frame, state } = o;
  try {
    if (frame === undefined || state === undefined) {
      const r = await host.evalJson(STATE_EXPR, o.timeoutMs ?? 3000);
      if (r && r.sdk) {
        frame = Number.isInteger(r.frame) ? r.frame : -1;
        try { state = JSON.parse(r.state); } catch { state = { error: "state provider returned invalid JSON" }; }
      } else {
        frame = -1;
        state = { unavailable: true };
      }
      await sleep(40);                                  // let the flushed tape reach main before the file says "restorable"
    }
    const name = kind === "manual" ? checkpointName("manual", ++host.checkpointCount)
      : kind === "mark" ? checkpointName("mark", o.markId) : "exit";
    let reason = o.reason || null;
    if (!reason && !host.readyLine?.stepper) reason = "no stepper: the game registered no deterministic stepper";
    else if (!reason && !(frame >= 0)) reason = "no game frame: the game has not ticked";
    else if (!reason && !host.tapeFrames.some(isFrameLine)) reason = "the tape has no frame lines";
    const cp = makeCheckpoint({
      name, kind, trigger: o.trigger || (kind === "manual" ? "save" : kind), frame, t, markId: o.markId,
      query: w.env?.game?.query ?? "", segment: segmentOf(host.tapeFrames, t), restorable: !reason, reason, state,
    });
    await writeCheckpoint(w.dir, cp);
    w.line("checkpoint", { frame: cp.frame, name, trigger: cp.trigger, ...(cp.markId ? { markId: cp.markId } : {}), restorable: cp.restorable }, t);
    return { name, frame: cp.frame, restorable: cp.restorable, reason };
  } catch (err) {
    host.warn(`checkpoint ${kind}${o.markId ? " " + o.markId : ""}: ${err && err.stack || err}`);
    return null;
  }
}
