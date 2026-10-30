// Played time vs open time (v1.4.1, D-030). Pure.
// The session start counts as activity; each gap between activities counts up to IDLE_MS, and so does the tail to the end.
import { fmtDuration, round1 } from "./time.mjs";

export const IDLE_MS = 60000;

/** A fresh accumulator: { idleMs, last (ms since session start), ms (counted so far) }. */
export function createActivity(idleMs = IDLE_MS) {
  return { idleMs, last: 0, ms: 0 };
}

/** Record activity at `t` (ms since session start). Times at or before the last one are ignored. */
export function noteActivity(a, t) {
  if (!Number.isFinite(t) || t <= a.last) return;
  a.ms += Math.min(t - a.last, a.idleMs);
  a.last = t;
}

/** Played ms at `endT`. */
export function activeTotal(a, endT) {
  return round1(a.ms + Math.min(Math.max(0, (Number(endT) || 0) - a.last), a.idleMs));
}

/** Played ms over a list of activity times (any order), for tests and old tapes. */
export function activeMsOf(times, endT, idleMs = IDLE_MS) {
  const a = createActivity(idleMs);
  for (const t of Array.from(times, Number).filter(Number.isFinite).sort((x, y) => x - y)) noteActivity(a, t);
  return activeTotal(a, endT);
}

/**
 * The duration text of a finished session: "played X of Y" when its `end` line has `activeMs` and the idle time is
 * IDLE_MS or more, else "Y". `end` is the session's `end` line (or a { durationMs, activeMs } object).
 */
export function fmtSessionDuration(end) {
  const dur = Number(end?.durationMs) || 0;
  const active = Number(end?.activeMs);
  if (!Number.isFinite(active) || dur - active < IDLE_MS) return fmtDuration(dur);
  return `played ${fmtDuration(active)} of ${fmtDuration(dur)}`;
}
