// Frame-pacing statistics for perf.json and the mark line's worstMs.
import { round1 } from "./time.mjs";

/** Nearest-rank percentile of an ascending array. */
function pct(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/**
 * Stats over consecutive rAF intervals (ms).
 * drops = intervals above 2 × expectedMs (SESSION_FORMAT.md perf.json).
 */
export function perfStats(intervals, expectedMs = 1000 / 60) {
  const a = Array.from(intervals || [], Number).filter(x => Number.isFinite(x) && x >= 0);
  const sorted = a.slice().sort((x, y) => x - y);
  let drops = 0;
  for (const x of a) if (x > 2 * expectedMs) drops++;
  return {
    samples: a.length,
    p50: round1(pct(sorted, 0.5)),
    p95: round1(pct(sorted, 0.95)),
    max: round1(sorted.length ? sorted[sorted.length - 1] : 0),
    drops,
  };
}

/** Build perf.json from the raw window. */
export function buildPerfJson({ intervals, expectedMs = 1000 / 60, displayHz = null, seconds = 10, longTasks = [], gameStats, host } = {}) {
  const st = perfStats(intervals, expectedMs);
  const out = {
    expectedMs: Math.round(expectedMs * 1000) / 1000,
    displayHz,
    window: { seconds, samples: st.samples },
    intervalsMs: Array.from(intervals || [], x => round1(Number(x))),
    p50: st.p50, p95: st.p95, max: st.max, drops: st.drops,
    longTasks,
  };
  if (gameStats !== undefined) out.gameStats = gameStats;
  // v1.3 (D-027, additive): what the host itself cost around this mark: { bare, ringFrames, ringFps, markCaptureMs: { "0001": ms, … } }.
  if (host !== undefined && host !== null) out.host = host;
  return out;
}

/** Long tasks: intervals at or above `thresholdMs`, with the time they ended at. */
export function longTasksOf(intervals, endTimes, thresholdMs = 100) {
  const out = [];
  for (let i = 0; i < intervals.length; i++) {
    if (intervals[i] >= thresholdMs) out.push({ t: round1(endTimes[i]), ms: round1(intervals[i]) });
  }
  return out;
}
