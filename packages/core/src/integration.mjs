// Does this game already talk to Snapper? (v1.4, D-028; BRIEF-v1.4 §1.2). MIT, pure Node.
// The launcher's Set up for Claude dialog and `snapper doctor <root>` use it so a person who does not know where the
// game's boot code is ("it's heavily vibed") gets an answer without reading SDK.md.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, dirname, resolve } from "node:path";
import { findSessions } from "./reader.mjs";
import { resolveConfig } from "./game.mjs";

export const SCAN_EXTENSIONS = Object.freeze([".js", ".mjs", ".cjs", ".ts", ".html"]);
export const SKIP_DIRS = Object.freeze(["node_modules", "vendor", "dist", "build", ".git", ".snapper", ".claude"]);
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILES = 3000;
/** The calls reported, in this order. */
export const CALLS = Object.freeze(["registerState", "registerFrame", "registerStepper", "registerCommands", "tick"]);

const SNAPPER_REF = /\b(?:globalThis|window|self)\s*\??\.\s*snapper\b|\bsnapper\s*\??\.\s*(?:register|tick|log|event|mark|assert)/;
const SDK_ITSELF = /Snapper SDK v\d|G\.snapper\s*=\s*snapper/;     // the SDK's own source (vendored or copied) is not an integration
const RAF = /\brequestAnimationFrame\s*\(/;

/** Pure: which Snapper calls a source text makes. Returns the CALLS present (in CALLS order), [] for none or for the SDK itself. */
export function snapperCalls(text) {
  const s = String(text ?? "");
  if (SDK_ITSELF.test(s)) return [];
  const out = [];
  for (const c of ["registerState", "registerFrame", "registerStepper", "registerCommands"]) {
    if (new RegExp(`\\b${c}\\s*\\(`).test(s)) out.push(c);
  }
  // `.tick` counts only in a file that references the SDK (window.snapper / globalThis.snapper / snapper.x(...)):
  // `sn.tick`, `snapper?.tick(`, `return sn.tick;` all qualify; a game's own `loop.tick()` alone does not.
  if (/\.\s*tick\b/.test(s) && (SNAPPER_REF.test(s) || out.length)) out.push("tick");
  return out;
}

/** Pure: the module scripts of an index.html, as written in their src attributes (relative to the page). */
export function moduleScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(String(html ?? "")))) {
    const attrs = m[1];
    if (!/\btype\s*=\s*["']?module["']?/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (src && !/^(?:[a-z]+:)?\/\//i.test(src[1])) out.push(src[1].split(/[?#]/)[0]);
  }
  return out;
}

/**
 * Scan a game folder. Returns { root, found: [{ file, calls }], candidates: [file], scanned, truncated }.
 * `file` is relative to root with forward slashes. found: files that call the SDK (registerState(, registerFrame(,
 * registerStepper(, registerCommands(, .tick next to snapper). candidates (only meaningful when found is empty, always
 * filled): the module scripts of index.html first, then files that call requestAnimationFrame(, no duplicates — guesses
 * at "the file that starts your game loop".
 */
export function detectIntegration(rootArg) {
  const root = resolve(String(rootArg ?? "."));
  const found = [], rafFiles = [];
  let scanned = 0, truncated = false;
  const rel = p => relative(root, p).split("\\").join("/");
  const walk = dir => {
    if (truncated) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (truncated) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.includes(e.name)) walk(p);
        continue;
      }
      if (!e.isFile() || !SCAN_EXTENSIONS.includes(extname(e.name).toLowerCase())) continue;
      if (scanned >= MAX_FILES) { truncated = true; return; }
      let size = 0;
      try { size = statSync(p).size; } catch { continue; }
      if (size > MAX_FILE_BYTES) continue;
      scanned++;
      let text;
      try { text = readFileSync(p, "utf8"); } catch { continue; }
      const calls = snapperCalls(text);
      if (calls.length) found.push({ file: rel(p), calls });
      if (RAF.test(text) && !SDK_ITSELF.test(text)) rafFiles.push(rel(p));
    }
  };
  walk(root);
  const candidates = [];
  const index = join(root, "index.html");
  if (existsSync(index)) {
    try {
      for (const src of moduleScripts(readFileSync(index, "utf8"))) {
        const p = resolve(dirname(index), src.replace(/^\//, ""));
        if (existsSync(p)) candidates.push(rel(p));
      }
    } catch {}
  }
  for (const f of rafFiles) if (!candidates.includes(f)) candidates.push(f);
  return { root, found, candidates, scanned, truncated };
}

/**
 * The SDK capabilities the newest session of the game saw (env.json `sdk`), or null. `out` overrides the sessions folder.
 * Returns { session, id, sdk: { present, state, frame, stepper, ... } } | null.
 */
export async function lastSdkSeen(root, { out = null } = {}) {
  try {
    const cfg = resolveConfig({ root: resolve(root), flags: out ? { out: resolve(out) } : {} });
    if (!cfg.out) return null;
    for (const dir of await findSessions(join(cfg.out, cfg.slug))) {
      let env = null;
      try { env = JSON.parse(readFileSync(join(dir, "env.json"), "utf8")); } catch {}
      if (env?.sdk) return { session: dir, id: dir.split(/[\\/]/).pop(), sdk: env.sdk };
    }
  } catch {}
  return null;
}

/** Pure: the one line `snapper doctor <root>` prints for a detectIntegration result. */
export function integrationLine(r) {
  if (r.found.length) {
    return `integration: this game already talks to Snapper: ${r.found.map(f => `${f.file} (${f.calls.join(", ")})`).join("; ")}`;
  }
  const c = r.candidates.slice(0, 5);
  return `integration: no Snapper calls found in ${r.scanned} files${r.truncated ? " (stopped at 3000)" : ""}; `
    + (c.length ? `paste the SDK recipe into the file that starts your game loop; guesses: ${c.join(", ")}` : "no game-loop file found (no requestAnimationFrame, no module script in index.html)");
}
