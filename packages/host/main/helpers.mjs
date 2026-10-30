// Pure helpers for the host (no Electron imports), unit-tested in tests/unit/host-helpers.test.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Width/height of a JPEG buffer from its SOF marker, or null. */
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Screencast everyNthFrame for ~10 fps of captured frames. */
export function nthFor(hz) {
  const h = Number(hz);
  return Number.isFinite(h) && h > 0 ? Math.max(1, Math.round(h / 10)) : 6;
}

/** Overlay rectangles in effect at time t. history: [{t, vw, vh, rects}] ascending. */
export function rectsAt(history, t) {
  let pick = null;
  for (const h of history) {
    if (h.t <= t) pick = h;
    else break;
  }
  return pick;
}

/**
 * Rectangles to blank for a frame captured at time t: those in effect at t plus any reported up to `ahead` ms
 * later (the overlay can appear in a frame before its report reaches main). Returns { vw, vh, rects } or null.
 */
export function rectsNear(history, t, ahead = 350) {
  const cur = rectsAt(history, t);
  const later = history.filter(h => h.t > t && h.t <= t + ahead);
  const all = [...(cur ? [cur] : []), ...later];
  if (!all.length) return null;
  const base = cur || later[0];
  const rects = [];
  for (const h of all) if (h.vw === base.vw && h.vh === base.vh) rects.push(...h.rects);
  return { vw: base.vw, vh: base.vh, rects };
}

/** Scale CSS-pixel rects to an image of (w,h) given the CSS viewport (vw,vh); grows each rect by `pad` image px. */
export function scaleRects(rects, vw, vh, w, h, pad = 2) {
  if (!rects || !rects.length || !vw || !vh) return [];
  const sx = w / vw, sy = h / vh;
  return rects.map(r => {
    const x = Math.max(0, Math.floor(r.x * sx) - pad), y = Math.max(0, Math.floor(r.y * sy) - pad);
    const x2 = Math.min(w, Math.ceil((r.x + r.w) * sx) + pad), y2 = Math.min(h, Math.ceil((r.y + r.h) * sy) + pad);
    return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
  });
}

/** Per-key cooldown gate: ok(key, t, ms) is true (and records t) when `ms` have passed since the last pass. */
export class Cooldowns {
  constructor() { this.last = new Map(); }
  ok(key, t, ms) {
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < ms) return false;
    this.last.set(key, t);
    return true;
  }
}

/** Text of a Runtime.consoleAPICalled args list. */
export function consoleText(args) {
  const parts = (args || []).map(a => {
    if (!a) return "";
    if (a.type === "string") return String(a.value);
    if (a.unserializableValue) return String(a.unserializableValue);
    if (a.value !== undefined) return typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value);
    if (a.description) return String(a.description);
    return a.type === "undefined" ? "undefined" : `[${a.subtype || a.type}]`;
  });
  return parts.join(" ").slice(0, 4000);
}

/** CDP console type → log level used in log.json. */
export function consoleLevel(type) {
  if (type === "error" || type === "assert") return "error";
  if (type === "warning") return "warn";
  if (type === "debug") return "debug";
  if (type === "info") return "info";
  return "log";
}

/** Split an exceptionDetails into { text, stack }. */
export function exceptionText(d) {
  const desc = d?.exception?.description || "";
  if (desc) {
    const lines = String(desc).split(/\r?\n/);
    const first = lines[0];
    const stack = lines.slice(1).join("\n");
    return { text: first.slice(0, 1000), stack: stack || undefined };
  }
  const v = d?.exception?.value;
  const text = `${d?.text || "Uncaught"}${v !== undefined ? ` ${typeof v === "object" ? JSON.stringify(v) : v}` : ""}`;
  const loc = d?.url ? `at ${d.url}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}` : "";
  return { text: text.slice(0, 1000), stack: loc ? `    ${loc}` : undefined };
}

const NAMED = {
  Space: [" ", 32, " "], Enter: ["Enter", 13, "\r"], Escape: ["Escape", 27], Tab: ["Tab", 9], Backspace: ["Backspace", 8],
  ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40],
  ShiftLeft: ["Shift", 16], ShiftRight: ["Shift", 16], ControlLeft: ["Control", 17], ControlRight: ["Control", 17],
  AltLeft: ["Alt", 18], AltRight: ["Alt", 18], Delete: ["Delete", 46], Home: ["Home", 36], End: ["End", 35],
  PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], Comma: [",", 188, ","], Period: [".", 190, "."], Minus: ["-", 189, "-"],
  Equal: ["=", 187, "="], Slash: ["/", 191, "/"], Semicolon: [";", 186, ";"], Quote: ["'", 222, "'"],
};

/** KeyboardEvent.code → { code, key, vk, text? } for CDP Input.dispatchKeyEvent. */
export function keyInfo(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return { code, key: m[1].toLowerCase(), vk: m[1].charCodeAt(0), text: m[1].toLowerCase() };
  if ((m = /^Digit(\d)$/.exec(code))) return { code, key: m[1], vk: 48 + Number(m[1]), text: m[1] };
  if ((m = /^F(\d{1,2})$/.exec(code)) && Number(m[1]) >= 1 && Number(m[1]) <= 24) return { code, key: code, vk: 111 + Number(m[1]) };
  if ((m = /^Numpad(\d)$/.exec(code))) return { code, key: m[1], vk: 96 + Number(m[1]), text: m[1] };
  const n = NAMED[code];
  if (n) return { code, key: n[0], vk: n[1], ...(n[2] ? { text: n[2] } : {}) };
  return { code, key: code, vk: 0 };
}

/** A typed character → keyInfo (lower-case letters, digits, space; other characters carry text only). */
export function charKeyInfo(ch) {
  if (/^[a-z]$/.test(ch)) return keyInfo(`Key${ch.toUpperCase()}`);
  if (/^[A-Z]$/.test(ch)) return { ...keyInfo(`Key${ch}`), key: ch, text: ch, shift: true };
  if (/^\d$/.test(ch)) return keyInfo(`Digit${ch}`);
  if (ch === " ") return keyInfo("Space");
  return { code: "", key: ch, vk: ch.toUpperCase().charCodeAt(0), text: ch };
}

const NUMERIC = ["ringSeconds", "fpsDropMs", "fpsDropRun", "logLines", "padMarkHoldMs"];
const CONFIG_FLAGS = ["preset", "query", "slug", "out", "hotkeys", "padMark", ...NUMERIC];
export const HOTKEY_NAMES = ["mark", "overlay", "pause", "step", "fullscreen", "save"];

/**
 * `--hotkeys mark=F9,save=F6` → { mark: "F9", save: "F6" } (v1.3, D-027). Names are the config's hotkey names; values
 * are KeyboardEvent.code strings (F1..F24, KeyA, Digit1, …). Throws Error with a user-facing message on a bad pair.
 */
export function parseHotkeys(s) {
  const out = {};
  for (const part of String(s).split(",").map(x => x.trim()).filter(Boolean)) {
    const m = /^([a-z]+)\s*=\s*([A-Za-z0-9]+)$/.exec(part);
    if (!m || !HOTKEY_NAMES.includes(m[1])) throw new Error(`--hotkeys: "${part}" is not name=Code (names: ${HOTKEY_NAMES.join(", ")}; e.g. mark=F9)`);
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * CLI flags → the subset resolveConfig should merge (numbers coerced, padMark "8,9" parsed, `--hotkeys mark=F9` parsed,
 * `--bare` → bare: true, `--coi` → crossOriginIsolated: true). Drops everything else. Throws on a bad --hotkeys value.
 */
export function configFlags(flags = {}, { cwd = process.cwd(), resolve } = {}) {
  const out = {};
  for (const k of CONFIG_FLAGS) {
    let v = flags[k];
    if (v === undefined || v === true) continue;
    if (NUMERIC.includes(k)) { v = Number(v); if (!Number.isFinite(v)) continue; }
    if (k === "padMark" && typeof v === "string") v = v.split(",").map(Number).filter(Number.isFinite);
    if (k === "hotkeys" && typeof v === "string") v = parseHotkeys(v);
    if (k === "out" && resolve) v = resolve(cwd, String(v));
    out[k] = v;
  }
  if (flags.bare === true || flags.bare === "true") out.bare = true;
  if (flags.coi === true || flags.coi === "true") out.crossOriginIsolated = true;
  if (flags.tester === true || flags.tester === "true") out.tester = true;   // v1.4: tester mode (the playtester kit)
  return out;
}

/** Smoke result for an `expect` step. state: { marks, exceptions, errors, triggers:Set, ready }. Returns failure strings. */
export function checkExpect(exp, state) {
  const fails = [];
  const e = exp || {};
  if (e.marksAtLeast != null && state.marks < e.marksAtLeast) fails.push(`marksAtLeast ${e.marksAtLeast}: have ${state.marks}`);
  if (e.exceptions != null && state.exceptions < e.exceptions) fails.push(`exceptions >= ${e.exceptions}: have ${state.exceptions}`);
  if (e.errors != null && state.errors < e.errors) fails.push(`errors >= ${e.errors}: have ${state.errors}`);
  if (e.triggers != null) {
    for (const t of [].concat(e.triggers)) if (!state.triggers.has(t)) fails.push(`trigger "${t}" missing (have ${[...state.triggers].join(",") || "none"})`);
  }
  if (e.ready != null) {
    const want = Array.isArray(e.ready) ? e.ready : Object.keys(e.ready).filter(k => e.ready[k]);
    for (const k of want) if (!state.ready?.[k]) fails.push(`ready.${k} is not true`);
  }
  return fails;
}

/** Error text of an auto-mark summary, first line, clipped. */
export function oneLine(s, n = 160) {
  const t = String(s ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tester mode (v1.4, BRIEF-v1.4 §3.2): the kit folder is the parent of the game root; tester.json lives next to game/.

/** The tester's name as stored: control characters dropped, whitespace collapsed, at most 60 characters. "" when nothing usable. */
export function cleanTesterName(s) {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 60).trim() : t;
}

/** `<kit>/tester.json` → { name, at } or null (missing, unreadable, no usable name: the host asks again). */
export function readTesterFile(kit) {
  try {
    const j = JSON.parse(readFileSync(join(kit, "tester.json"), "utf8"));
    const name = j && typeof j.name === "string" ? cleanTesterName(j.name) : "";
    return name ? { name, at: typeof j.at === "string" ? j.at : null } : null;
  } catch { return null; }
}

/** Write `<kit>/tester.json` = { name, at }. Returns the stored { name, at }, or null when the name is empty or "anonymous". */
export function writeTesterFile(kit, name, at = new Date().toISOString()) {
  const n = cleanTesterName(name);
  if (!n || n.toLowerCase() === "anonymous") return null;
  const doc = { name: n, at };
  writeFileSync(join(kit, "tester.json"), JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

/** File name of the send-this-file zip: `<slug>-<session id>.zip` (no path characters). */
export function outboxName(slug, id) {
  return `${String(slug || "game").replace(/[^A-Za-z0-9._-]+/g, "-")}-${String(id).replace(/[^A-Za-z0-9._-]+/g, "-")}.zip`;
}

/** A KeyboardEvent.code as the player reads it: KeyM → M, Digit5 → 5, F8 → F8. */
export function keyLabel(code) {
  const c = String(code || "");
  return c.replace(/^Key/, "").replace(/^Digit/, "") || "F8";
}

/** The first-10-seconds hint (chip, or a toast in a bare session). */
export function testerHint(markCode) {
  return `${keyLabel(markCode)} marks a moment`;
}

/** The note box title in tester mode. */
export const TESTER_NOTE_TITLE = "What happened?";

/** The name prompt title. */
export function testerNameTitle(developer) {
  return `Your name (sent with your sessions to ${developer || "the developer"})`;
}

/** The line shown before the window goes away. `rel` is the zip relative to the kit folder, shown with backslashes. */
export function sendLine(developer, rel) {
  return `Send this file to ${developer || "the developer"}: ${String(rel).replace(/\//g, "\\")}`;
}
