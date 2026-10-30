// snapper pack <game-root> [--out <zip>] [--bundle] [--url <u>] [--developer <name>] — the playtester kit (BRIEF-v1.4 §3.1).
// Writes <slug>-playtest-<yyyymmdd>.zip: game/ (the root minus .git node_modules .snapper .claude dist outbox, minus the
// root's snapper.config.json (the kit's own replaces it, and a Discord webhook must never ship), minus .snapperignore globs),
// snapper.config.json, PLAY.cmd, README-TESTER.txt (CRLF) and, with --bundle, snapper/ (the repo's dist/win-unpacked).
// Exit codes: 0 ok, 1 error, 2 usage or refusal.
import { existsSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, gitInfo, listTree, writeZip, SNAPPER_VERSION } from "../../core/index.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ALWAYS_SKIP = new Set([".git", "node_modules", ".snapper", ".claude", "dist"]);
const err = msg => process.stderr.write(`snapper pack: ${msg}\n`);
const refuse = (message, exitCode = 2) => Object.assign(new Error(message), { exitCode });
const crlf = s => s.replace(/\r?\n/g, "\r\n");

// ---- .snapperignore globs ---------------------------------------------------------------------------------------

/**
 * Compile one .snapperignore line to { re, dirOnly } or null (blank or comment). `*` = any run without "/", `**` = anything
 * including "/" (a `**` followed by a slash = zero or more folders), `?` = one character, a trailing "/" = folders only. A pattern with no "/"
 * (after dropping a trailing one) matches at any depth; one with a "/" or a leading "/" is anchored at the game root.
 */
export function compileGlob(line) {
  let p = String(line ?? "").trim();
  if (!p || p.startsWith("#")) return null;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\/+/, "");
  if (!p) return null;
  let src = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") { src += "(?:.*/)?"; i += 2; } else { src += ".*"; i += 1; }
      } else src += "[^/]*";
    } else if (c === "?") src += "[^/]";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return { re: new RegExp(anchored ? `^${src}$` : `^(?:.*/)?${src}$`), dirOnly };
}

/** Pure: the matcher for a .snapperignore text: (rel, isDir) → true when ignored. */
export function ignoreMatcher(text) {
  const globs = String(text ?? "").split(/\r?\n/).map(compileGlob).filter(Boolean);
  return (rel, isDir) => globs.some(g => (!g.dirOnly || isDir) && g.re.test(rel));
}

// ---- the kit's text files ---------------------------------------------------------------------------------------

const cmdSafeUrl = u => (/^[\w:/.?=#@+,~-]+$/.test(u) ? u : `"${u}"`);

/** Pure: PLAY.cmd (CRLF). `bundled`: run the snapper/ folder of the kit; `url`: launch a URL with the game folder as --game-root. */
export function playCmd({ bundled = false, url = null } = {}) {
  const target = url ? `${cmdSafeUrl(url.replace(/%/g, "%%"))} --game-root "%~dp0game"` : `"%~dp0game"`;
  const run = `call "%SNAPPER%" play ${target} --tester --config "%~dp0snapper.config.json"`;
  if (bundled) {
    return crlf([
      "@echo off", "setlocal", `set "SNAPPER=%~dp0snapper\\snapper.cmd"`,
      "rem This kit carries its own copy of Snapper: nothing to install.",
      run, "exit /b %errorlevel%", "",
    ].join("\n"));
  }
  return crlf([
    "@echo off", "setlocal", `set "SNAPPER=%LOCALAPPDATA%\\Programs\\Snapper\\snapper.cmd"`,
    `if not exist "%SNAPPER%" goto missing`, run, "exit /b %errorlevel%", "",
    ":missing", `start "" notepad "%~dp0README-TESTER.txt"`, "exit /b 1", "",
  ].join("\n"));
}

/** Pure: README-TESTER.txt (CRLF). */
export function readmeTester({ developer, slug, markKey = "F8", homepage = null, bundled = false, url = null }) {
  const lines = [
    `PLAYTEST: ${slug}`, "",
    `This is a playtest kit for "${slug}", sent to you by ${developer}.`,
    "It records what happens while you play (a screenshot, the game's state, the last seconds of video frames and your keys)",
    "so the developer can see exactly what you saw. Nothing is uploaded anywhere; everything stays on this computer",
    "until you send one file by hand.", "",
  ];
  if (bundled) {
    lines.push("1. Unzip this whole folder somewhere (not inside the zip viewer).", "   Nothing to install: the Snapper player is in the snapper folder.", "");
  } else {
    lines.push("1. Install Snapper once (Windows 10 or 11).",
      homepage ? `   Download Snapper: ${homepage}` : `   Download Snapper: (link to come — ask ${developer})`,
      "   Then unzip this whole folder somewhere (not inside the zip viewer).", "");
  }
  lines.push(
    "2. Double-click PLAY.cmd.", "   The game opens in a Snapper window.", "",
    "3. The first time, type your name once when it asks and press Enter.", "",
    `4. Play. When something feels wrong (a bug, a glitch, a part that is confusing), press ${markKey}`,
    "   and type what happened, then press Enter. You can do that as many times as you like.", "",
    "5. When you are done, close the game window.", "",
    `6. Open the "outbox" folder next to PLAY.cmd and send the .zip file inside to ${developer}`,
    "   (email, chat, a shared drive: whatever you normally use).", "",
    "Nothing is uploaded by this kit. If you do not want to share a session, simply do not send the file.", "",
  );
  return crlf(lines.join("\n"));
}

// ---- pack -------------------------------------------------------------------------------------------------------

const yyyymmdd = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const defaultDeveloper = () => { try { return userInfo().username || "the developer"; } catch { return process.env.USERNAME || "the developer"; } };
function homepageOf() {
  try { const h = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).homepage; return typeof h === "string" && h.trim() ? h.trim() : null; } catch { return null; }
}

/**
 * Build the kit zip for a game root. opts: { out (zip path), bundle, url, developer, bundleDir (tests: the folder bundled
 * instead of the repo's dist/win-unpacked), level }. Returns { file, bytes, entries, bundled, slug, files }.
 * Throws Error(user-facing) with .exitCode 2 for a refusal.
 */
export async function packKit(rootArg, { out, bundle = false, url = null, developer, bundleDir, level } = {}) {
  const root = resolve(String(rootArg ?? ""));
  if (!rootArg || !existsSync(root) || !statSync(root).isDirectory()) throw refuse(`game root not found: ${root}`);
  if (!existsSync(join(root, "index.html")) && !url) {
    throw refuse(`no index.html in ${root}: a game that is not a static folder needs --url <address> (the kit opens that address; the folder is still packed)`);
  }
  if (url && !/^https?:\/\/[^\s"]+$/i.test(url)) throw refuse(`--url must be an http(s) address without spaces or quotes (got ${JSON.stringify(url)})`);
  const bundleFrom = bundleDir ?? join(REPO, "dist", "win-unpacked");
  if (bundle && !existsSync(join(bundleFrom, "snapper.cmd"))) {
    throw refuse(`--bundle needs ${bundleFrom} (with snapper.cmd): build it first with \`npm run dist:dir\`, or pack without --bundle`);
  }
  const dev = String(developer ?? defaultDeveloper()).trim() || defaultDeveloper();

  let cfg;
  try { cfg = resolveConfig({ root }); } catch (e) { throw refuse(`cannot read snapper.config.json: ${e.message}`); }
  const git = gitInfo(root);
  const config = { ...cfg.config, slug: cfg.slug };
  delete config.out;                                  // the tester's sessions live in the kit, not in the developer's folder
  delete config.discordWebhook;                       // a secret: never ships
  config.developer = dev;
  config.tester = true;
  config.pack = { sha: git?.sha ?? null, dirty: git ? git.dirty : null, at: new Date().toISOString(), host: SNAPPER_VERSION };

  const outFile = resolve(out ? String(out) : join(process.cwd(), `${cfg.slug}-playtest-${yyyymmdd()}.zip`));
  let ignoreText = "";
  try { ignoreText = readFileSync(join(root, ".snapperignore"), "utf8"); } catch {}
  const ignored = ignoreMatcher(ignoreText);
  const files = await listTree(root, (rel, isDir) => {
    const name = rel.split("/").pop();
    if (ALWAYS_SKIP.has(name) && isDir) return true;
    if (isDir && rel === "outbox") return true;                       // a tester's outbox is never repacked
    if (!isDir && rel === "snapper.config.json") return true;         // replaced by the kit's own
    if (!isDir && resolve(root, ...rel.split("/")) === outFile) return true;   // never zip the output into itself
    return ignored(rel, isDir);
  });

  const entries = files.map(rel => ({ name: `game/${rel}`, file: join(root, ...rel.split("/")) }));
  entries.push({ name: "snapper.config.json", data: JSON.stringify(config, null, 2) + "\n" });
  entries.push({ name: "PLAY.cmd", data: playCmd({ bundled: bundle, url }) });
  entries.push({ name: "README-TESTER.txt", data: readmeTester({
    developer: dev, slug: cfg.slug, markKey: config.hotkeys?.mark || "F8", homepage: homepageOf(), bundled: bundle, url }) });
  if (bundle) {
    for (const rel of await listTree(bundleFrom)) entries.push({ name: `snapper/${rel}`, file: join(bundleFrom, ...rel.split("/")) });
  }
  const res = await writeZip(outFile, entries, { level: level ?? (bundle ? 3 : 6) });
  return { file: res.file, bytes: res.bytes, entries: res.entries, bundled: !!bundle, slug: cfg.slug, files: files.length };
}

export async function run({ positional, flags }) {
  const [root] = positional;
  if (!root) { err("usage: snapper pack <game-root> [--out <zip>] [--bundle] [--url <u>] [--developer <name>]"); return 2; }
  for (const k of ["out", "url", "developer"]) if (flags[k] === true) { err(`--${k} needs a value`); return 2; }
  try {
    const r = await packKit(root, { out: flags.out, bundle: flags.bundle === true, url: flags.url, developer: flags.developer });
    process.stdout.write(`${r.file}\n`);
    process.stderr.write(`snapper pack: ${r.entries} files, ${(r.bytes / 1048576).toFixed(1)} MB${r.bundled ? " (with the Snapper player bundled)" : ""}\n`);
    return 0;
  } catch (e) {
    err(e.message);
    return e.exitCode ?? 1;
  }
}
