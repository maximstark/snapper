// Pure helpers of the attach host (no Electron import, so unit tests load them in plain Node).

export const NO_RELOAD_REASON = "attached without a reload: the game booted before Snapper was injected";
export const NO_ROOT_REASON = "no --game-root and the page is not an http(s) URL, so replay has nothing to load";


/** Pure: "Chrome/141.0.7390.55" → "141.0.7390.55" (anything else: null). */
export function chromiumOf(product) {
  const m = /\/(\d+(?:\.\d+)+)/.exec(String(product || ""));
  return m ? m[1] : null;
}

/** Pure: the game URL without query and hash, and the query without the pause parameter. */
export function splitPageUrl(href, pauseParam = "paused") {
  try {
    const u = new URL(href);
    u.searchParams.delete(pauseParam);
    return { url: u.origin === "null" ? `${u.protocol}//${u.pathname}` : u.origin + u.pathname, query: u.search };
  } catch { return { url: String(href || ""), query: "" }; }
}

/** Pure: extra fields for the mark lines of a session that cannot be replayed (null when replay is possible). */
export function markLineExtrasFor({ reload, root, url }) {
  if (reload === false) return { replayable: false, replayableReason: NO_RELOAD_REASON };
  if (!root && !/^https?:\/\//i.test(String(url || ""))) return { replayable: false, replayableReason: NO_ROOT_REASON };
  return null;
}

/** Pure: display refresh from a list of rAF intervals (ms): the fast quartile, as an integer Hz; null with too few. */
export function hzFromIntervals(intervals) {
  const a = (intervals || []).filter(x => Number.isFinite(x) && x > 1).sort((x, y) => x - y);
  if (a.length < 10) return null;
  const q = a[Math.floor(a.length / 4)];
  const hz = Math.round(1000 / q);
  return hz >= 24 && hz <= 480 ? hz : null;
}
