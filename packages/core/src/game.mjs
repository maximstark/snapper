// Game root facts: slug, snapper.config.json, git state, default output folder, resolved config.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, resolve } from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  preset: "1080p",
  query: "",
  hotkeys: { mark: "F8", overlay: "F9", pause: "F10", step: "F7", fullscreen: "F11", save: "F6" },
  padMark: [8, 9],
  padMarkHoldMs: 400,
  ringSeconds: 5,
  fpsDropMs: 250,
  fpsDropRun: 10,
  logLines: 200,
  bare: false,                                       // v1.3 (D-027): no ring buffer, no overlay chip, no F9 panel
  crossOriginIsolated: false,                        // v1.3 (D-027): COOP/COEP on every served response (--coi)
  tester: false,                                     // v1.4 (D-028): tester mode (--tester; the playtester kit sets it)
});

export const PRESETS = Object.freeze({
  deck: { w: 1280, h: 800 },
  "1080p": { w: 1920, h: 1080 },
  ultrawide: { w: 3440, h: 1440 },
  native: null,                                      // primary display size, fullscreen
});

/** Lower-case, non-alphanumerics to "-", trimmed. */
export function slugify(name) {
  return String(name || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game";
}

/** snapper.config.json in the game root, or {} (null root → {}). Throws on invalid JSON. */
export function readGameConfig(root) {
  if (!root) return {};
  const p = join(root, "snapper.config.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8"));
}

/** { sha, branch, dirty } or null when root is not a git work tree. */
export function gitInfo(root) {
  if (!root) return null;
  const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const sha = git(["rev-parse", "HEAD"]);
    let branch = null;
    try { branch = git(["rev-parse", "--abbrev-ref", "HEAD"]); } catch {}
    let dirty = false;
    try { dirty = git(["status", "--porcelain"]).length > 0; } catch {}
    return { sha, branch, dirty };
  } catch {
    return null;
  }
}

export const defaultSessionsDir = root => join(root, ".snapper", "sessions");

const isPlain = v => v && typeof v === "object" && !Array.isArray(v);

/**
 * Resolve the config: defaults < snapper.config.json < CLI flags (undefined flags ignored).
 * Returns { config, root, slug, out }.
 */
export function resolveConfig({ root, flags = {}, fileConfig } = {}) {
  const file = fileConfig ?? readGameConfig(root);
  const config = structuredClone(DEFAULT_CONFIG);
  for (const src of [file, flags]) {
    for (const [k, v] of Object.entries(src || {})) {
      if (v === undefined) continue;
      config[k] = isPlain(v) && isPlain(config[k]) ? { ...config[k], ...v } : v;
    }
  }
  const slug = slugify(config.slug || (root ? basename(resolve(root)) : "game"));
  const out = config.out ? resolve(root || ".", config.out) : root ? defaultSessionsDir(root) : null;
  return { config, root: root ? resolve(root) : null, slug, out };
}
