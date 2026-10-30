// Replay-to-frame stepping, shared by the replay runner and the host's resume flow (D-014, D-021).
// Pure: the caller supplies `stepRuns`, which executes a list of { n, codes } steps in the game (one
// evaluate) and resolves the SDK's last ticked frame afterwards.
import { runsBetween, maskAt, codesOf } from "./tape.mjs";

const isObj = v => v && typeof v === "object";

/**
 * First differing JSON path between a and b ("$.player.x", "$.vel[1]"), or null when equal.
 * Object key order does not matter. `skipTop` lists top-level keys to ignore.
 * Returns { path, recorded: a-side value, replayed: b-side value }.
 */
export function firstDiff(a, b, skipTop = [], path = "$") {
  if (a === b) return null;
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) return null;
    return { path, recorded: a, replayed: b };
  }
  if (Array.isArray(a)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = firstDiff(a[i], b[i], [], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    if (path === "$" && skipTop.includes(k)) continue;
    const ka = k in a, kb = k in b;
    const p = `${path}.${k}`;
    if (ka !== kb) return { path: p, recorded: a[k], replayed: b[k] };
    const d = firstDiff(a[k], b[k], [], p);
    if (d) return d;
  }
  return null;
}

/**
 * Up to `max` differing JSON paths between a and b, depth-first in key order (v1.4, D-028): the same walk as firstDiff,
 * so diffPaths(a, b)[0] === firstDiff(a, b).path. `skipTop` lists top-level keys to ignore. Returns [] when equal.
 */
export function diffPaths(a, b, skipTop = [], max = 3) {
  const out = [];
  const walk = (x, y, path) => {
    if (out.length >= max || x === y) return;
    if (!isObj(x) || !isObj(y) || Array.isArray(x) !== Array.isArray(y)) {
      if (typeof x === "number" && typeof y === "number" && Number.isNaN(x) && Number.isNaN(y)) return;
      out.push(path);
      return;
    }
    if (Array.isArray(x)) {
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n && out.length < max; i++) walk(x[i], y[i], `${path}[${i}]`);
      return;
    }
    for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])]) {
      if (out.length >= max) return;
      if (path === "$" && skipTop.includes(k)) continue;
      const p = `${path}.${k}`;
      if ((k in x) !== (k in y)) { out.push(p); continue; }
      walk(x[k], y[k], p);
    }
  };
  walk(a, b, "$");
  return out;
}

/** The replay/resume state compare (D-014): everything except the top-level `perf` key. */
export const compareState = (recorded, live) => firstDiff(recorded, live, ["perf"]);

/** The same compare, up to three differing paths (v1.4 `diffs`; [] when equal). */
export const compareStateAll = (recorded, live, max = 3) => diffPaths(recorded, live, ["perf"], max);

/**
 * Split runs [{from, n, mask}] into chunks of at most `size` frames (a number, or a function called
 * before each chunk so the caller can adapt it). Yields { runs, frames, end } where `end` is the last
 * frame the chunk ticks.
 */
export function* chunkRuns(runs, size) {
  const sizeOf = typeof size === "function" ? size : () => size;
  let i = 0, off = 0;
  while (i < runs.length) {
    const cap = Math.max(1, Math.floor(sizeOf()) || 1);
    const out = [];
    let n = 0;
    while (i < runs.length && n < cap) {
      const r = runs[i];
      const take = Math.min(r.n - off, cap - n);
      out.push({ from: r.from + off, n: take, mask: r.mask });
      n += take;
      off += take;
      if (off >= r.n) { i++; off = 0; }
    }
    const last = out[out.length - 1];
    yield { runs: out, frames: n, end: last.from + last.n - 1 };
  }
}

/**
 * Step the game from its last ticked frame `last` until it has ticked frame `to`, using the tape's
 * frame lines (D-014: positioned by the SDK's last tick; each frame's codes come from the mask in
 * effect at that frame). Steps in chunks of `chunk` frames (number or function); when the tick
 * numbering does not advance as planned it falls back to one frame per call.
 * stepRuns([{n, codes}]) → Promise<number> (the SDK's last ticked frame afterwards).
 * onChunk({ last, to, steps, frames }) is called after every chunk (progress).
 * Returns { last, steps, chunks, warnings }.
 */
export async function stepTo({ frames, keymap = [], last, to, chunk = 500, stepRuns, onChunk }) {
  const warnings = [];
  let steps = 0, chunks = 0;
  if (!Number.isInteger(last)) last = -1;
  if (last > to) {
    warnings.push(`the game was already at frame ${last}, past the target ${to}`);
    return { last, steps, chunks, warnings };
  }
  let single = false;
  for (const c of chunkRuns(runsBetween(frames, last + 1, to), chunk)) {
    const got = await stepRuns(c.runs.map(r => ({ n: r.n, codes: codesOf(r.mask, keymap) })));
    steps += c.frames;
    chunks++;
    if (got !== c.end) {
      warnings.push(`tick numbering skipped (expected frame ${c.end}, got ${got}); fell back to single steps`);
      last = Number.isInteger(got) ? got : last;
      single = true;
      break;
    }
    last = got;
    if (onChunk) await onChunk({ last, to, steps, frames: c.frames });
  }
  if (single) {
    let stuck = 0;
    while (last < to) {
      const got = await stepRuns([{ n: 1, codes: codesOf(maskAt(frames, last + 1), keymap) }]);
      steps++;
      chunks++;
      stuck = got === last ? stuck + 1 : 0;
      if (stuck >= 3) throw new Error(`the stepper stopped advancing at frame ${last}`);
      last = got;
      if (onChunk && steps % 200 === 0) await onChunk({ last, to, steps, frames: 1 });
    }
  }
  return { last, steps, chunks, warnings };
}

/** Append a bare query parameter (`paused`) to a URL unless it is already there. */
export function addQueryParam(url, param) {
  if (!param) return url;
  if (new RegExp(`[?&]${param}(=|&|#|$)`).test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + param;
}

/** One expression that runs [{n, codes}] through snapper.__host.step and returns snapper.frame(). */
export function stepExpression(runs) {
  return `(()=>{var h=globalThis.snapper.__host,R=${JSON.stringify(runs.map(r => [r.n, r.codes]))};`
    + `for(var i=0;i<R.length;i++)h.step(R[i][0],R[i][1]);return globalThis.snapper.frame()})()`;
}
