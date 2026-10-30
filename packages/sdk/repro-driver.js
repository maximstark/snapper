// Snapper no-Snapper repro driver (MIT). Plain ESM for any browser (Chrome, Edge, Firefox): no Node imports, no
// Chromium-only API. Written by `snapper export-repro` next to tape.json, expected.json and snapper-sdk.js.
//
// What it does: with the page opened at `?paused&snapper-repro=1`, it waits for the game to register its stepper with the
// Snapper SDK (window.snapper, loaded by a plain <script> before the game: no Snapper host, no preload, no CDP), feeds the
// recorded tape through that stepper exactly as the replay runner does (D-014: positioned by the SDK's last tick, each
// frame's keys from the mask in effect at that frame, one step() call per run of equal input, single steps on a tick skew),
// compares the game's state at the mark frame with expected.json (the same compare as Snapper's replay: everything except
// the top-level `perf` key), and prints `REPRO: match at frame N` or `REPRO: differs $.path (…)` to the console and into a
// <pre id="snapper-repro">. Harnesses read window.__snapperRepro = { done, result }.
// It drives the game only through the SDK's documented host surface (snapper.__host: ready, pause, step, state; SDK.md).
// From a console instead of the URL flag: import("/repro/driver.js").then(m => m.run()).

export const REPRO_PARAM = "snapper-repro";

/** Mask in effect at frame f (0 before the first frame line). Same as core tape.mjs maskAt. */
export function maskAt(frames, f) {
  let m = 0;
  for (const x of frames) { if (x.f <= f) m = x.m; else break; }
  return m;
}

/** Codes held under a mask: bit i ⇔ keymap[i]. Same as core codesOf. */
export function codesOf(mask, keymap) {
  const out = [];
  for (let i = 0; i < keymap.length && i < 31; i++) if (mask & (1 << i)) out.push(keymap[i]);
  return out;
}

/** Runs [{ from, n, mask }] covering frames from..to. Same as core runsBetween. */
export function runsBetween(frames, from, to) {
  const out = [];
  if (to < from) return out;
  let cur = from, mask = maskAt(frames, from);
  for (const x of frames) {
    if (x.f <= from) continue;
    if (x.f > to) break;
    if (x.m !== mask) { out.push({ from: cur, n: x.f - cur, mask }); cur = x.f; mask = x.m; }
  }
  out.push({ from: cur, n: to - cur + 1, mask });
  return out.filter(r => r.n > 0);
}

/**
 * Step from the last ticked frame `last` until frame `to` has ticked: one step(n, codes) per run, then a check that
 * the tick numbering advanced as planned; on a skew, one frame per call (the core stepTo's rule). step(n, codes) →
 * the SDK's last ticked frame afterwards (a number or a promise of one). Returns { last, steps, warnings }.
 */
export async function stepTo({ frames, keymap, last, to, step }) {
  const warnings = [];
  let steps = 0;
  if (!Number.isInteger(last)) last = -1;
  if (last > to) { warnings.push(`the game was already at frame ${last}, past the target ${to}`); return { last, steps, warnings }; }
  let single = false;
  for (const r of runsBetween(frames, last + 1, to)) {
    const end = r.from + r.n - 1;
    const got = await step(r.n, codesOf(r.mask, keymap));
    steps += r.n;
    if (got !== end) {
      warnings.push(`tick numbering skipped (expected frame ${end}, got ${got}); fell back to single steps`);
      last = Number.isInteger(got) ? got : last;
      single = true;
      break;
    }
    last = got;
  }
  if (single) {
    let stuck = 0;
    while (last < to) {
      const got = await step(1, codesOf(maskAt(frames, last + 1), keymap));
      steps++;
      stuck = got === last ? stuck + 1 : 0;
      if (stuck >= 3) throw new Error(`the stepper stopped advancing at frame ${last}`);
      last = got;
    }
  }
  return { last, steps, warnings };
}

const isObj = v => v && typeof v === "object";

/** Up to `max` differing paths (depth-first, key order; top-level `skipTop` keys ignored). Same as core diffPaths. */
export function diffPaths(a, b, skipTop = ["perf"], max = 3) {
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

/** The value at a "$.a.b[2]" path, or undefined. */
export function valueAt(obj, path) {
  let v = obj;
  for (const part of String(path).replace(/^\$/, "").match(/\.[^.[\]]+|\[\d+\]/g) || []) {
    if (v == null) return undefined;
    v = part[0] === "[" ? v[Number(part.slice(1, -1))] : v[part.slice(1)];
  }
  return v;
}

const show = v => { const s = v === undefined ? "(missing)" : JSON.stringify(v); return s.length > 80 ? s.slice(0, 77) + "..." : s; };

/** Pure: the one-line verdict. */
export function verdictLine(result) {
  if (result.status === "match") return `REPRO: match at frame ${result.frame}`;
  if (result.status === "differs") {
    const d = result.diffs[0];
    return `REPRO: differs ${result.diffs.join(", ")} (at frame ${result.frame}; ${d}: recorded ${show(result.recorded)}, replayed ${show(result.replayed)})`;
  }
  return `REPRO: error: ${result.message}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The repro itself, environment-injected so it unit-tests in Node. opts: { tape, expected, sn (a function returning
 * window.snapper, looked up on every use: the SDK may load after this module), search (location.search), timeoutMs }. Resolves { status: "match" | "differs" | "error", frame, diffs, recorded, replayed,
 * steps, warnings, message }.
 */
export async function runRepro({ tape, expected, sn, search = "", timeoutMs = 30000 }) {
  const warnings = [];
  try {
    if (!tape || !Array.isArray(tape.frames) || !Number.isInteger(tape.markFrame)) throw new Error("tape.json is missing or malformed");
    if (!expected || expected.state === undefined) throw new Error("expected.json is missing or malformed");
    const pp = tape.pauseParam || "paused";
    const params = new URLSearchParams(search);
    if (!params.has(pp)) throw new Error(`open the game with ?${pp} (the game must boot paused so the tape starts at its frame 0); e.g. ${tape.openQuery || "?" + pp}`);
    for (const [k, v] of new URLSearchParams(tape.query || "")) {
      if (params.get(k) !== v) warnings.push(`the session was played with ${k}=${v}; this page has ${params.has(k) ? `${k}=${params.get(k)}` : `no ${k}`}`);
    }
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = !!(sn() && sn().__host && sn().__host.ready().stepper === true); } catch {}
      if (ok) break;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(sn() ? "the game never registered a stepper (snapper.registerStepper) within " + timeoutMs / 1000 + " s"
          : "window.snapper is missing: load repro/snapper-sdk.js with a plain <script> before the game's first script");
      }
      await sleep(50);
    }
    const h = sn().__host;
    h.pause();
    const keymap = Array.isArray(tape.keymap) ? tape.keymap : [];
    const last = sn().frame();
    const pos = await stepTo({ frames: tape.frames, keymap, last, to: tape.markFrame, step: (n, codes) => { h.step(n, codes); return sn().frame(); } });
    warnings.push(...pos.warnings);
    if (pos.last !== tape.markFrame) throw new Error(`the replay reached frame ${pos.last}, not the mark frame ${tape.markFrame}`);
    let state;
    try { state = JSON.parse(h.state()); } catch { throw new Error("the game's state provider returned invalid JSON"); }
    const diffs = diffPaths(expected.state, state);
    const base = { frame: pos.last, steps: pos.steps, warnings, diffs };
    if (!diffs.length) return { status: "match", ...base };
    return { status: "differs", ...base, recorded: valueAt(expected.state, diffs[0]), replayed: valueAt(state, diffs[0]) };
  } catch (e) {
    return { status: "error", message: String(e && e.message || e), warnings, diffs: [] };
  }
}

function show_(text) {
  try {
    let pre = document.getElementById("snapper-repro");
    if (!pre) {
      pre = document.createElement("pre");
      pre.id = "snapper-repro";
      pre.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483647;margin:0;padding:6px 10px;max-width:90vw;white-space:pre-wrap;"
        + "font:13px/1.4 ui-monospace,Consolas,monospace;color:#fff;background:rgba(0,0,0,.85);border:1px solid #888;border-radius:4px";
      (document.body || document.documentElement).appendChild(pre);
    }
    pre.textContent = text;
  } catch {}
}

/** Run in this page: fetch tape.json and expected.json next to this file, drive, report. Resolves the result. */
export async function run() {
  const state = (globalThis.__snapperRepro = { done: false, result: null });
  show_("REPRO: running…");
  let tape = null, expected = null;
  try {
    tape = await (await fetch(new URL("./tape.json", import.meta.url), { cache: "no-store" })).json();
    expected = await (await fetch(new URL("./expected.json", import.meta.url), { cache: "no-store" })).json();
  } catch (e) { /* runRepro reports the missing file */ }
  const result = await runRepro({ tape, expected, sn: () => globalThis.snapper, search: location.search });
  const line = verdictLine(result);
  const extra = result.warnings && result.warnings.length ? "\n" + result.warnings.map(w => "warning: " + w).join("\n") : "";
  (result.status === "match" ? console.log : console.warn)(line + extra);
  show_(line + extra);
  state.result = result;
  state.line = line;
  state.done = true;
  try { document.title = line; } catch {}
  return result;
}

if (typeof location !== "undefined" && typeof document !== "undefined" && new URLSearchParams(location.search).has(REPRO_PARAM)) {
  run();
}
