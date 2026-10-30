// Checkpoints: save states by replay-to-frame (D-021, SESSION_FORMAT.md "checkpoints/").
// A checkpoint is a frame number plus the state the game reported there. Restoring it boots the game
// paused and replays the session's tape segment to that frame; the saved state is the proof.
import { readdir, mkdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { atomicWrite } from "./writer.mjs";
import { readJson, readText, readTape, findSessions } from "./reader.mjs";
import { parseJsonl } from "./jsonl.mjs";
import { isFrameLine, isWallLine, isReload, segmentForMark } from "./tape.mjs";

export const CHECKPOINTS_DIR = "checkpoints";
export const KINDS = ["manual", "mark", "exit"];

const pad4 = n => String(n).padStart(4, "0");

/** File name (without .json) of a checkpoint: manual n → "0001", mark "0003" → "mark-0003", exit → "exit". */
export function checkpointName(kind, n) {
  if (kind === "exit") return "exit";
  if (kind === "mark") return `mark-${pad4(n)}`;
  return pad4(n);
}

export const checkpointPath = (sessionDir, name) => join(sessionDir, CHECKPOINTS_DIR, `${name}.json`);

/**
 * The segment a checkpoint at time `t` belongs to (D-012): { index, reloadT } where reloadT is the `t` of
 * the reload marker that starts it (null for the first segment).
 */
export function segmentOf(tapeLines, t) {
  const seg = segmentForMark(tapeLines, { t });
  if (!seg) return { index: 0, reloadT: null };
  return { index: seg.index, reloadT: seg.marker && typeof seg.marker.t === "number" ? seg.marker.t : null };
}

/** Build a checkpoint object (key order fixed so files diff cleanly; `state` last because it is big). */
export function makeCheckpoint({ name, kind, trigger, frame, t, markId, query = "", segment, restorable, reason, state }) {
  const cp = { v: 1, name, kind, trigger: trigger || kind, frame: Number.isInteger(frame) ? frame : -1, t };
  if (markId != null) cp.markId = String(markId);
  cp.query = query || "";
  cp.segment = segment || { index: 0, reloadT: null };
  cp.restorable = !!restorable;
  if (reason) cp.reason = reason;
  cp.state = state === undefined ? { unavailable: true } : state;
  return cp;
}

/** Write `<session>/checkpoints/<name>.json` atomically. Returns the path. */
export async function writeCheckpoint(sessionDir, cp) {
  await mkdir(join(sessionDir, CHECKPOINTS_DIR), { recursive: true });
  const p = checkpointPath(sessionDir, cp.name);
  await atomicWrite(p, JSON.stringify(cp, null, 2) + "\n");
  return p;
}

/**
 * The implicit `mark-NNNN` checkpoint of a session recorded before v1.1 (no checkpoints/ file): built in memory
 * from the `mark` line (frame, t), `marks/NNNN/state.json` and env.json (query), with the segment chosen as the
 * writer does (D-012, D-021 addendum). Never written to disk. Returns null when the mark or its state is missing.
 */
export async function synthesiseMarkCheckpoint(sessionDir, id) {
  const markId = pad4(id);
  const { lines } = parseJsonl(await readText(join(sessionDir, "session.jsonl")));
  const mark = lines.find(l => l.kind === "mark" && l.id != null && pad4(l.id) === markId);
  if (!mark || !Number.isInteger(mark.frame) || typeof mark.t !== "number") return null;
  const state = await readJson(join(sessionDir, ...(mark.dir || `marks/${markId}`).split("/"), "state.json"));
  if (state == null) return null;
  const env = await readJson(join(sessionDir, "env.json"));
  const tapeLines = (await readTape(sessionDir)).lines;
  const seg = segmentForMark(tapeLines, { t: mark.t });
  const restorable = !!(seg && seg.frames.length);
  return makeCheckpoint({
    name: checkpointName("mark", markId), kind: "mark", trigger: "mark", frame: mark.frame, t: mark.t, markId,
    query: env?.game?.query ?? "", segment: segmentOf(tapeLines, mark.t), restorable,
    reason: restorable ? null : "the tape has no frame lines for this mark's segment", state,
  });
}

/** Read a checkpoint; an absent `mark-NNNN` file falls back to the implicit checkpoint built from the mark. */
export async function readCheckpoint(sessionDir, name) {
  const cp = await readJson(checkpointPath(sessionDir, name));
  if (cp) return cp;
  const m = /^mark-(\d{1,4})$/.exec(String(name));
  return m ? synthesiseMarkCheckpoint(sessionDir, m[1]) : null;
}

/**
 * listCheckpoints plus an implicit entry for every mark with no checkpoints/mark-NNNN.json (old sessions).
 * Used by `--resume`; `snapper list` keeps the plain listCheckpoints.
 */
export async function listCheckpointsWithMarks(sessionDir) {
  const list = await listCheckpoints(sessionDir);
  const have = new Set(list.map(c => c.name));
  const { lines } = parseJsonl(await readText(join(sessionDir, "session.jsonl")));
  for (const l of lines) {
    if (l.kind !== "mark" || l.id == null) continue;
    const name = checkpointName("mark", l.id);
    if (have.has(name)) continue;
    const cp = await synthesiseMarkCheckpoint(sessionDir, l.id);
    if (!cp) continue;
    have.add(name);
    list.push({ name, kind: "mark", trigger: "mark", frame: cp.frame, t: cp.t, restorable: cp.restorable, markId: cp.markId });
  }
  return list.sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || a.name.localeCompare(b.name));
}

/** Checkpoints of a session, oldest first (by t): [{ name, kind, trigger, frame, t, markId?, restorable }]. Never throws. */
export async function listCheckpoints(sessionDir) {
  let names;
  try { names = (await readdir(join(sessionDir, CHECKPOINTS_DIR))).filter(f => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of names) {
    const cp = await readJson(join(sessionDir, CHECKPOINTS_DIR, f));
    if (!cp || typeof cp !== "object") continue;
    const e = { name: cp.name || f.slice(0, -5), kind: cp.kind, trigger: cp.trigger, frame: cp.frame, t: cp.t, restorable: cp.restorable !== false };
    if (cp.markId != null) e.markId = String(cp.markId);
    out.push(e);
  }
  return out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || a.name.localeCompare(b.name));
}

const describe = list => list.map(c => `${c.name} (frame ${c.frame}${c.restorable ? "" : ", not restorable"})`).join(", ") || "none";

/**
 * Resolve `--at` against a checkpoint list (from listCheckpoints).
 *   "exit" (default)              → the exit checkpoint
 *   an exact name ("0002", "mark-0003")
 *   a bare number n ("2")          → manual 000n, else mark-000n, else an error (up to 4 digits)
 *   "mark-3", "m3", "mark:0003"    → mark-0003
 *   "f12345" or a bare number of 5+ digits → frame 12345 in the segment of the newest
 *                                     checkpoint at or after that frame (its state is compared only
 *                                     when a checkpoint sits exactly on that frame)
 * Returns { checkpoint } | { frame, base, exact? } | { error }.
 */
export function resolveAt(list, at = "exit") {
  const a = at === true || at == null || at === "" ? "exit" : String(at).trim();
  const byName = n => list.find(c => c.name === n);
  let m;
  if (a === "exit") {
    const c = byName("exit");
    return c ? { checkpoint: c } : { error: `the session has no exit checkpoint (states: ${describe(list)})` };
  }
  if (byName(a)) return { checkpoint: byName(a) };
  if ((m = /^\d{1,4}$/.exec(a))) {
    const c = byName(pad4(a)) || byName(`mark-${pad4(a)}`);
    if (c) return { checkpoint: c };
    return { error: `no state or mark named "${a}"; write f${Number(a)} for a frame (states: ${describe(list)})` };
  }
  if ((m = /^(?:mark[-:]?|m)(\d{1,4})$/i.exec(a))) {
    const c = byName(`mark-${pad4(m[1])}`);
    return c ? { checkpoint: c } : { error: `no checkpoint for mark ${pad4(m[1])} (states: ${describe(list)})` };
  }
  if ((m = /^(?:f|frame[-:=]?)?(\d+)$/i.exec(a))) {
    const frame = Number(m[1]);
    const usable = list.filter(c => c.restorable && Number.isInteger(c.frame) && c.frame >= frame);
    if (!usable.length) return { error: `no restorable state at or after frame ${frame} to replay from (states: ${describe(list)})` };
    const exact = usable.filter(c => c.frame === frame).pop();
    const base = list.find(c => c.name === "exit" && usable.includes(c)) || usable[usable.length - 1];
    return { frame, base, ...(exact ? { exact } : {}) };
  }
  return { error: `cannot resolve --at "${a}" (use exit, a state name like 0002, mark-0003, or f<frame>; states: ${describe(list)})` };
}

/**
 * The source session of `--resume`: "last"/true → the newest session under `base` (a `<out>/<slug>` folder)
 * that has at least one checkpoint; otherwise a path. Returns { dir } | { error }.
 */
export async function findResumeSource(base, spec) {
  if (spec === true || spec == null || spec === "" || spec === "last") {
    for (const dir of await findSessions(base)) {
      if ((await listCheckpoints(dir)).length) return { dir };
    }
    return { error: `no session with saved states under ${base}` };
  }
  const dir = resolve(String(spec));
  if (!(await readJson(join(dir, "env.json")))) return { error: `not a session folder (no env.json): ${dir}` };
  return { dir };
}

/** Same filesystem path (Windows: case-insensitive, either slash). */
export function samePath(a, b) {
  if (!a || !b) return false;
  const n = p => resolve(String(p)).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

/** Tape lines split at reload markers, keeping every non-wall line: [{ marker, lines }]. */
export function rawSegments(tapeLines) {
  const segs = [{ marker: null, lines: [] }];
  for (const l of tapeLines) {
    if (isReload(l)) segs.push({ marker: l, lines: [] });
    else if (!isWallLine(l)) segs[segs.length - 1].lines.push(l);
  }
  return segs;
}

/** Pick a checkpoint's segment: by reload marker `t`, else by index, else by the checkpoint's `t` (D-012). */
export function pickSegment(tapeLines, segment = {}, t) {
  const segs = rawSegments(tapeLines);
  let i = -1;
  if (segment && typeof segment.reloadT === "number") i = segs.findIndex(s => s.marker && s.marker.t === segment.reloadT);
  else if (segment && segment.reloadT === null && (segment.index ?? 0) === 0) i = 0;
  if (i < 0 && segment && Number.isInteger(segment.index) && segment.index < segs.length) i = segment.index;
  if (i < 0) i = segmentForMark(tapeLines, { t })?.index ?? segs.length - 1;
  return { index: i, ...segs[i] };
}

/**
 * What a resumed session's tape starts with: the source segment's lines up to `frame` (frame lines, seed
 * and earlier resume markers; wall lines are not copied) followed by the resume marker
 * {"f":frame,"ev":"resume","from":"<session id>/<checkpoint>","t":…}.
 * Returns { lines, frames } where `frames` are the frame lines to step through.
 */
export function resumeTapeLines(segLines, frame, { from, t }) {
  const copied = segLines.filter(l => Number.isInteger(l.f) && l.f <= frame && (isFrameLine(l) || l.ev === "seed" || l.ev === "resume"));
  const frames = copied.filter(isFrameLine).map(l => ({ f: l.f, m: l.m }));
  const marker = { f: frame, ev: "resume", from };
  if (typeof t === "number") marker.t = t;
  return { lines: [...copied, marker], frames };
}

/** Session id of a session folder (its folder name). */
export const sessionIdOf = dir => basename(resolve(dir));
