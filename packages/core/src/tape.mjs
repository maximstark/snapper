// Tape helpers (SESSION_FORMAT.md "tape.jsonl", SDK.md "Tape semantics").
//
// Frame lines {"f","m"} are run-length: mask m holds from frame f until the next frame line.
// Markers {"f","ev":"reload"} split the tape into segments (frame numbers restart). The host
// stamps markers with `t` (host receipt time, D-012) so a mark can find the segment it was taken in.
import { parseJsonl } from "./jsonl.mjs";

export function parseTape(text) {
  const { lines } = parseJsonl(text);
  const header = lines.length && lines[0].kind === "tape" ? lines[0] : null;
  return { header, lines: header ? lines.slice(1) : lines };
}

export const isFrameLine = l => Number.isInteger(l.f) && Number.isInteger(l.m) && l.ev === undefined;
export const isWallLine = l => typeof l.t === "number" && (typeof l.k === "string" || Number.isInteger(l.p)) && l.f === undefined;
export const isReload = l => l.ev === "reload";

/**
 * Convert an SDK tape flush (parallel int arrays) into tape lines.
 * mask === -1 marks a reset at that frame (the SDK saw the frame counter go backwards).
 */
export function tapeLinesFromFlush(frames, masks, count, t) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const f = frames[i] | 0, m = masks[i] | 0;
    out.push(m === -1 ? (t == null ? { f, ev: "reload" } : { f, ev: "reload", t }) : { f, m });
  }
  return out;
}

/** Split tape lines into segments at reload markers. Segment 0 starts at the top (marker null). */
export function segments(lines) {
  const segs = [{ marker: null, frames: [] }];
  for (const l of lines) {
    if (isReload(l)) segs.push({ marker: l, frames: [] });
    else if (isFrameLine(l)) segs[segs.length - 1].frames.push({ f: l.f, m: l.m });
  }
  return segs;
}

/**
 * The segment a mark was taken in: the last segment whose reload marker was stamped at or before
 * the mark's `t`. Without stamped markers, the last segment (the literal rule of the format:
 * "from the last reload marker (or the start) before the mark's frame").
 * Returns { index, marker, frames } or null when the tape has no frame lines at all.
 */
export function segmentForMark(lines, mark = {}) {
  const segs = segments(lines);
  let pick = segs.length - 1;
  const stamped = segs.slice(1).every(s => typeof s.marker.t === "number");
  if (stamped && typeof mark.t === "number") {
    pick = 0;
    for (let i = 1; i < segs.length; i++) if (segs[i].marker.t <= mark.t) pick = i;
  }
  const seg = segs[pick];
  if (!seg.frames.length && !segs.some(s => s.frames.length)) return null;
  return { index: pick, marker: seg.marker, frames: seg.frames };
}

/**
 * The query a tape segment boots with (D-022): the `query` of the nearest reload marker at or before
 * segment `index` that carries one (a reset marker from the SDK has none: same document, same query),
 * else the session's original `env.game.query`. Returns { query, source: "marker" | "env" }.
 */
export function segmentQuery(lines, index, envQuery = "") {
  const segs = segments(lines);
  for (let i = Math.min(index, segs.length - 1); i >= 1; i--) {
    const q = segs[i].marker.query;
    if (typeof q === "string") return { query: q, source: "marker" };
  }
  return { query: envQuery || "", source: "env" };
}

/** An explicit `--query` override wins; otherwise the segment's query. Returns { query, source: "override" | "marker" | "env" }. */
export function chooseQuery({ override, lines, index, envQuery }) {
  if (typeof override === "string") return { query: override, source: "override" };
  return segmentQuery(lines, index, envQuery);
}

/** Mask in effect at frame f (0 before the first frame line). */
export function maskAt(frames, f) {
  let m = 0;
  for (const x of frames) {
    if (x.f <= f) m = x.m;
    else break;
  }
  return m;
}

/** Codes held under a mask: bit i ⇔ keymap[i]. */
export function codesOf(mask, keymap = []) {
  const out = [];
  for (let i = 0; i < keymap.length && i < 31; i++) if (mask & (1 << i)) out.push(keymap[i]);
  return out;
}

/** Mask of a code list. */
export function maskOf(codes, keymap = []) {
  let m = 0;
  for (const c of codes) {
    const i = keymap.indexOf(c);
    if (i >= 0 && i < 31) m |= 1 << i;
  }
  return m;
}

/**
 * Runs covering frames [from, to] inclusive: [{ from, n, mask }], split where the mask changes.
 * A replay steps each run with step(n, codesOf(mask)).
 */
export function runsBetween(frames, from, to) {
  const out = [];
  if (to < from) return out;
  let cur = from;
  let mask = maskAt(frames, from);
  for (const x of frames) {
    if (x.f <= from) continue;
    if (x.f > to) break;
    if (x.m !== mask) {
      out.push({ from: cur, n: x.f - cur, mask });
      cur = x.f;
      mask = x.m;
    }
  }
  out.push({ from: cur, n: to - cur + 1, mask });
  return out.filter(r => r.n > 0);
}

/** Frame lines (and the line in effect at `from`) within [from, to], for a mark's inputs.json. */
export function frameLinesWindow(frames, from, to) {
  const out = [];
  let prev = null;
  for (const x of frames) {
    if (x.f < from) prev = x;
    else if (x.f <= to) out.push(x);
  }
  return prev ? [prev, ...out] : out;
}
