// Time and id helpers shared by the writer, the reader and the renderer.

export const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Local start time as a session id: YYYY-MM-DDTHH-mm-ss. */
export function sessionIdFor(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** ISO 8601 in local time with the UTC offset, e.g. 2026-10-18T14:02:11-07:00. */
export function isoLocal(date = new Date()) {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Mark id: 4-digit zero-padded sequential number. */
export const markId = n => pad(n, 4);

/** One decimal, as every `t` in the format. */
export const round1 = x => Math.round(x * 10) / 10;

/** Session-relative ms → "m:ss.s" (0:42.3). */
export function fmtT(ms) {
  const tenths = Math.max(0, Math.round((Number(ms) || 0) / 100));
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Duration ms → "12 m 04 s" (or "1 h 02 m 04 s"). */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h} h ${pad(m)} m ${pad(s)} s` : `${m} m ${pad(s)} s`;
}

/** "2026-10-18T14-02-11" → "2026-10-18 14:02" (null when the id is not a session id). */
export function idToDisplay(id) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/.exec(String(id || ""));
  return m ? `${m[1]} ${m[2]}:${m[3]}` : null;
}
