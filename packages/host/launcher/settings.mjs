// Launcher settings and the status-line command strings. Pure: no Electron import, so it unit-tests in plain Node.
// File: <userData>/settings.json  { v: 1, recent: [roots, newest first], lastRoot, perRoot: { root: fields }, bounds }
//   fields = { preset, fullscreen, query, url, hotkey, padHoldMs, ringSeconds, bare }  (v1.3 added the last five)
//   url: "" or an http(s) URL (the Play target, run with --game-root); hotkey: "" (the game's own) or a KeyboardEvent.code;
//   padHoldMs / ringSeconds: null (the game's own) or a whole number; bare: boolean.
//   Only OVERRIDES are stored: a value equal to the game's effective one is pruned (pruneCapture), so a later change in
//   the game's snapper.config.json still shows through.
import { fmtT } from "../../core/index.mjs";

export const PRESETS = ["deck", "1080p", "ultrawide", "native"];
export const MAX_RECENT = 8;
export const PAD_HOLD_RANGE = [100, 5000];
export const RING_RANGE = [1, 30];
const DEFAULT_FIELDS = { preset: "1080p", fullscreen: false, query: "", url: "", hotkey: "", padHoldMs: null, ringSeconds: null, bare: false };

export const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
export const ATTACH_HINT = "Start Chrome or Edge with --remote-debugging-port=9222 --user-data-dir=%TEMP%\\snapper-chrome";

export const defaultSettings = () => ({ v: 1, recent: [], lastRoot: "", perRoot: {}, bounds: null, attach: {} });

/** Canonical form of a root: forward slashes, no trailing slash (the drive root keeps its slash). */
export function normRoot(root) {
  let s = String(root ?? "").trim().replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  if (/^[A-Za-z]:$/.test(s)) s += "/";
  return s;
}
const keyOf = root => normRoot(root).toLowerCase();

const NAMED_KEYS = ["Space", "Tab", "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period",
  "Slash", "Backslash", "Insert", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

/** A KeyboardEvent.code (F1–F24, KeyA, Digit1, Space, ArrowUp …) from what a person typed ("f9", "a", "7"), or null. */
export function normHotkey(v) {
  const t = String(v ?? "").trim();
  if (!t) return null;
  let m = /^f(\d{1,2})$/i.exec(t);
  if (m) return +m[1] >= 1 && +m[1] <= 24 ? `F${+m[1]}` : null;
  if (/^[a-z]$/i.test(t)) return `Key${t.toUpperCase()}`;
  if (/^\d$/.test(t)) return `Digit${t}`;
  m = /^key([a-z])$/i.exec(t);
  if (m) return `Key${m[1].toUpperCase()}`;
  m = /^(digit|numpad)(\d)$/i.exec(t);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}${m[2]}`;
  return NAMED_KEYS.find(n => n.toLowerCase() === t.toLowerCase()) ?? null;
}

/** A whole number in [lo, hi] from a number or numeric string, else null. */
export function normInt(v, [lo, hi]) {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null;
  const n = typeof v === "number" ? v : /^\s*\d+\s*$/.test(String(v)) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

/** { url } ("" when empty) or { error }: an optional http(s) target. */
export function checkUrl(v) {
  const t = String(v ?? "").trim();
  if (!t) return { url: "" };
  if (/\s/.test(t)) return { error: "the URL must not contain spaces" };
  let u;
  try { u = new URL(t); } catch { return { error: `not a URL: ${t}` }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "the URL must start with http:// or https://" };
  if (!u.hostname) return { error: "the URL has no host" };
  return { url: t };
}

const cleanFields = f => ({
  preset: PRESETS.includes(f?.preset) ? f.preset : DEFAULT_FIELDS.preset,
  fullscreen: f?.fullscreen === true,
  query: typeof f?.query === "string" ? f.query : "",
  url: checkUrl(f?.url).url ?? "",
  hotkey: normHotkey(f?.hotkey) ?? "",
  padHoldMs: normInt(f?.padHoldMs, PAD_HOLD_RANGE),
  ringSeconds: normInt(f?.ringSeconds, RING_RANGE),
  bare: f?.bare === true,
});

const filled = v => v !== undefined && v !== null && String(v).trim() !== "";

/** The first problem with the URL and capture fields as typed (a user-facing message), or null. Empty = not overridden. */
/** Keys the host already uses with the default config (a mark key there would shadow them; D-027). */
export const RESERVED_KEYS = Object.freeze({ F5: "reload", F6: "save-state", F7: "step", F9: "overlay", F10: "pause", F11: "fullscreen", F12: "devtools" });

export function fieldsProblem(f) {
  const u = checkUrl(f?.url);
  if (u.error) return u.error;
  if (filled(f?.hotkey) && !normHotkey(f.hotkey)) return `mark hotkey "${f.hotkey}" is not a key code (F1–F24, KeyA, Digit1, Space …)`;
  if (filled(f?.hotkey) && RESERVED_KEYS[normHotkey(f.hotkey)]) return `mark hotkey ${normHotkey(f.hotkey)} is already Snapper's ${RESERVED_KEYS[normHotkey(f.hotkey)]} key; pick another (e.g. F4)`;
  if (filled(f?.padHoldMs) && normInt(f.padHoldMs, PAD_HOLD_RANGE) === null) return `pad hold must be a whole number of ms, ${PAD_HOLD_RANGE[0]}–${PAD_HOLD_RANGE[1]}`;
  if (filled(f?.ringSeconds) && normInt(f.ringSeconds, RING_RANGE) === null) return `ring seconds must be a whole number, ${RING_RANGE[0]}–${RING_RANGE[1]}`;
  return null;
}

/** The cleaned fields with every capture value that equals the game's effective one reset to unset ("" / null / false). */
export function pruneCapture(fields, effective = {}) {
  const f = cleanFields(fields);
  if (f.hotkey && f.hotkey === effective.hotkey) f.hotkey = "";
  if (f.padHoldMs !== null && f.padHoldMs === effective.padHoldMs) f.padHoldMs = null;
  if (f.ringSeconds !== null && f.ringSeconds === effective.ringSeconds) f.ringSeconds = null;
  if (f.bare && effective.bare === true) f.bare = false;
  return f;
}

/** "Reset": the fields with this root's capture overrides cleared (preset, fullscreen, query and url are kept). */
export function resetCapture(fields) {
  return { ...cleanFields(fields), hotkey: "", padHoldMs: null, ringSeconds: null, bare: false };
}

/**
 * CLI flags for the capture overrides, only where they differ from `effective` (the game's config with no flags):
 * { hotkeys: "mark=F9", padMarkHoldMs: 600, ringSeconds: 3, bare: true }. The object feeds buildOptions and commandLine.
 * `--bare` has no off form, so an effective bare:true (the game's own config) is never overridden.
 */
export function captureFlags(fields, effective = {}) {
  const f = cleanFields(fields);
  const out = {};
  if (f.hotkey && f.hotkey !== effective.hotkey) out.hotkeys = `mark=${f.hotkey}`;
  if (f.padHoldMs !== null && f.padHoldMs !== effective.padHoldMs) out.padMarkHoldMs = f.padHoldMs;
  if (f.ringSeconds !== null && f.ringSeconds !== effective.ringSeconds) out.ringSeconds = f.ringSeconds;
  if (f.bare && effective.bare !== true) out.bare = true;
  return out;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * The mark picker line: `0003 · fixed · 1:02.3 · hotkey · "jumped through the floor"` (note clipped to 60 chars; the triage
 * status only when the mark has one). `m` = { id, status?, t, trigger, note, summary }; an auto-mark with no note shows its
 * summary instead (unquoted).
 */
export function markLabel(m = {}) {
  const parts = [String(m.id ?? ""), ...(m.status ? [String(m.status)] : []), fmtT(m.t), m.trigger || ""];
  const note = String(m.note ?? "").replace(/\s+/g, " ").trim();
  if (note) parts.push(`"${clip(note, 60)}"`);
  else if (m.summary) parts.push(clip(String(m.summary).replace(/\s+/g, " ").trim(), 60));
  const keep = m.status ? 3 : 2;
  return parts.filter((p, i) => i < keep || p).join(" · ");
}

/**
 * What "Copy for Claude" puts on the clipboard (Windows separators):
 *   Read "<session>\SESSION.md" and triage it with the snapper skill.
 *   Read "<session>\SESSION.md" and triage mark 0003 with the snapper skill.
 */
export function copyForClaudeText(sessionDir, markId = "") {
  const dir = String(sessionDir ?? "").trim().replace(/[\\/]+$/, "").replace(/\//g, "\\");
  if (!dir) throw new Error("no session folder");
  const mark = String(markId ?? "").trim();
  if (mark && !/^\d{4,}$/.test(mark)) throw new Error(`not a mark id: ${mark}`);
  return `Read "${dir}\\SESSION.md" and triage ${mark ? `mark ${mark}` : "it"} with the snapper skill.`;
}

const cleanBounds = b => {
  if (!b || typeof b !== "object") return null;
  const { x, y, width, height } = b;
  if (![x, y, width, height].every(Number.isFinite) || width < 200 || height < 200) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
};

/** Recents with `root` first; case- and slash-insensitive de-dup; at most `max`. */
export function addRecent(recent, root, max = MAX_RECENT) {
  const r = normRoot(root);
  if (!r) return Array.isArray(recent) ? recent.slice(0, max) : [];
  const seen = new Set([keyOf(r)]);
  const out = [r];
  for (const item of Array.isArray(recent) ? recent : []) {
    if (typeof item !== "string" || !item.trim()) continue;
    const k = keyOf(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(normRoot(item));
  }
  return out.slice(0, max);
}

/** Tolerant load: anything missing or of the wrong type falls back to the default. */
export function mergeSettings(loaded) {
  const s = defaultSettings();
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) return s;
  for (const item of Array.isArray(loaded.recent) ? [...loaded.recent].reverse() : []) {
    if (typeof item === "string" && item.trim()) s.recent = addRecent(s.recent, item, 1000);
  }
  s.recent = s.recent.slice(0, MAX_RECENT);
  if (typeof loaded.lastRoot === "string") s.lastRoot = normRoot(loaded.lastRoot);
  if (loaded.perRoot && typeof loaded.perRoot === "object" && !Array.isArray(loaded.perRoot)) {
    for (const [root, f] of Object.entries(loaded.perRoot)) {
      if (root && f && typeof f === "object") s.perRoot[normRoot(root)] = cleanFields(f);
    }
  }
  s.bounds = cleanBounds(loaded.bounds);
  // v1.4: the Attach row's endpoint and target per root
  if (loaded.attach && typeof loaded.attach === "object" && !Array.isArray(loaded.attach)) {
    for (const [root, a] of Object.entries(loaded.attach)) {
      if (root && a && typeof a === "object") s.attach[normRoot(root)] = cleanAttach(a);
    }
  }
  return s;
}

/** { endpoint } (the default when empty) or { error }: an http(s) or ws(s) DevTools endpoint. */
export function checkEndpoint(v) {
  const t = String(v ?? "").trim();
  if (!t) return { endpoint: DEFAULT_ENDPOINT };
  if (/\s/.test(t)) return { error: "the endpoint must not contain spaces" };
  let u;
  try { u = new URL(t); } catch { return { error: `not an endpoint: ${t} (expected ${DEFAULT_ENDPOINT})` }; }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return { error: "the endpoint must start with http:// (or ws://)" };
  if (!u.hostname) return { error: "the endpoint has no host" };
  return { endpoint: t.replace(/\/+$/, "") };
}

const cleanAttach = a => ({
  endpoint: checkEndpoint(a?.endpoint).endpoint ?? DEFAULT_ENDPOINT,
  target: typeof a?.target === "string" ? a.target.slice(0, 2000) : "",
});

/** The remembered Attach endpoint and target of a root (case-insensitive), or the defaults. */
export function attachFor(settings, root) {
  const k = keyOf(root);
  for (const [r, a] of Object.entries(settings?.attach || {})) if (keyOf(r) === k) return cleanAttach(a);
  return { endpoint: DEFAULT_ENDPOINT, target: "" };
}

/** A new settings object with the Attach endpoint and target remembered for `root`. */
export function rememberAttach(settings, root, a = {}) {
  const s = mergeSettings(settings);
  const r = normRoot(root);
  if (!r) return s;
  const k = keyOf(r);
  for (const old of Object.keys(s.attach)) if (keyOf(old) === k) delete s.attach[old];
  s.attach[r] = cleanAttach({ ...attachFor(settings, r), ...a });
  return s;
}

/** The saved fields for a root (case-insensitive), or the defaults. */
export function fieldsFor(settings, root) {
  const k = keyOf(root);
  for (const [r, f] of Object.entries(settings?.perRoot || {})) if (keyOf(r) === k) return cleanFields(f);
  return { ...DEFAULT_FIELDS };
}

/** A new settings object with `root` remembered: lastRoot, recents, and its fields. */
export function rememberRoot(settings, root, fields = {}) {
  const s = mergeSettings(settings);
  const r = normRoot(root);
  if (!r) return s;
  const k = keyOf(r);
  for (const old of Object.keys(s.perRoot)) if (keyOf(old) === k) delete s.perRoot[old];
  s.perRoot[r] = cleanFields({ ...fieldsFor(settings, r), ...fields });
  s.lastRoot = r;
  s.recent = addRecent(s.recent, r);
  return s;
}

const q = v => `"${String(v).replace(/\\/g, "/").replace(/"/g, '\\"')}"`;

/**
 * The CLI line equivalent to a launcher action (status line).
 *   play:   { root, url, preset, fullscreen, query, flags, out }   (flags = captureFlags(); a url → `play <url> --game-root <root>`)
 *   resume: { root, session, at, preset, fullscreen, flags, out }  (the query comes from the saved state's segment)
 *   replay: { session, markId }
 *   check:  { root, sessions, session, marks, accept, out }
 *   skill:  { root }
 *   attach: { endpoint, target, root, flags (hotkeys, bare), out }   (`snapper attach <endpoint> --target "<t>" --game-root "<root>"`)
 */
export function commandLine(kind, a = {}) {
  const parts = ["snapper"];
  if (kind === "replay") {
    parts.push("replay", q(a.session), String(a.markId));
    return parts.join(" ");
  }
  if (kind === "attach") {
    parts.push("attach", String(a.endpoint || DEFAULT_ENDPOINT));
    if (a.target) parts.push("--target", q(a.target));
    if (a.root) parts.push("--game-root", q(a.root));
    const f = a.flags || {};
    if (f.hotkeys) parts.push("--hotkeys", f.hotkeys);
    if (f.bare) parts.push("--bare");
    if (a.out) parts.push("--out", q(a.out));
    return parts.join(" ");
  }
  if (kind === "skill") return `snapper skill install ${q(a.root)}`;
  if (kind === "check") {
    parts.push("check", q(a.root));
    if (a.session) parts.push("--session", q(a.session));
    else if (a.sessions) parts.push("--sessions", String(a.sessions));
    if (a.marks?.length) parts.push("--marks", [].concat(a.marks).join(","));
    if (a.accept) parts.push("--accept");
    if (a.out) parts.push("--out", q(a.out));
    return parts.join(" ");
  }
  if (kind === "play" && a.url) parts.push("play", q(a.url), "--game-root", q(a.root));
  else parts.push("play", q(a.root));
  if (kind === "resume") parts.push("--resume", q(a.session), "--at", String(a.at || "exit"));
  if (a.preset) parts.push("--preset", a.preset);
  if (a.fullscreen) parts.push("--fullscreen");
  if (kind === "play" && a.query) parts.push("--query", q(a.query));
  const f = a.flags || {};
  if (f.hotkeys) parts.push("--hotkeys", f.hotkeys);
  if (f.padMarkHoldMs !== undefined) parts.push("--padMarkHoldMs", String(f.padMarkHoldMs));
  if (f.ringSeconds !== undefined) parts.push("--ringSeconds", String(f.ringSeconds));
  if (f.bare) parts.push("--bare");
  if (a.out) parts.push("--out", q(a.out));
  return parts.join(" ");
}

/**
 * The Set up for Claude dialog, as data (BRIEF-v1.4 §1.2). `integration` = detectIntegration(root), `sdkSeen` = lastSdkSeen(root) | null.
 * Returns { integrated, headline, found: [{ file, calls, text }], seen, candidatesLine, candidates }.
 * Backticks in `headline` / `text` mark file names (the page renders them as code).
 */
export function setupModel(integration, sdkSeen = null) {
  const found = Array.isArray(integration?.found) ? integration.found : [];
  const candidates = Array.isArray(integration?.candidates) ? integration.candidates : [];
  const seen = sdkSeenLine(sdkSeen);
  const files = found.map(f => ({ file: f.file, calls: f.calls || [], text: `\`${f.file}\` (${(f.calls || []).join(", ")})` }));
  if (files.length) {
    return {
      integrated: true,
      headline: `This game already talks to Snapper: ${files.map(f => f.text).join("; ")}. Nothing to paste.`,
      found: files, seen, candidatesLine: "", candidates: [],
    };
  }
  const shown = candidates.slice(0, 5);
  return {
    integrated: false,
    headline: "Paste this into the file that starts your game loop",
    found: [], seen,
    candidatesLine: shown.length
      ? `Likely files (guesses): ${shown.join(", ")}`
      : "No guess: no requestAnimationFrame and no module script in index.html",
    candidates: shown,
  };
}

/** "Last session 2026-10-19T15-48-55: state ✓ frame ✓ stepper ✓ (replayable)" or "No session yet". */
export function sdkSeenLine(seen) {
  if (!seen || !seen.sdk) return "No session yet";
  const sdk = seen.sdk, mark = v => (v ? "✓" : "✗");
  if (sdk.present === false || sdk.sdk === false) return `Last session ${seen.id}: the SDK was not seen`;
  const cap = `state ${mark(sdk.state)} frame ${mark(sdk.frame)} stepper ${mark(sdk.stepper)}`;
  return `Last session ${seen.id}: ${cap}${sdk.stepper ? " (replayable)" : " (not replayable: no stepper)"}`;
}

/** `differs $.a, $.b, $.c` / `stateMatches FALSE`'s paths: up to three `diffs`, else `firstDiff`, else "". */
export function diffsText(row = {}) {
  const d = Array.isArray(row.diffs) ? row.diffs.filter(x => typeof x === "string" && x) : [];
  if (d.length) return d.slice(0, 3).join(", ");
  return row.firstDiff ? String(row.firstDiff) : "";
}
