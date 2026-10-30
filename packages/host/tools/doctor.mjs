// snapper doctor — versions and prerequisites. Exit 0 when everything is present, 1 otherwise.
// Works in dev (plain Node, or Electron as Node) and packaged (Snapper.exe under ELECTRON_RUN_AS_NODE=1).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SNAPPER_VERSION, detectIntegration, integrationLine } from "../../core/index.mjs";
import { isPackaged } from "../main/electron-bin.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SDK = fileURLToPath(new URL("../../sdk/snapper.js", import.meta.url));
const require = createRequire(REPO + "package.json");

function checkElectron() {
  // Inside Electron (the exe, or ELECTRON_RUN_AS_NODE) the running binary is the evidence; no node_modules needed.
  if (process.versions.electron) return { ok: true, text: `electron ${process.versions.electron} (${process.execPath})` };
  try {
    const pkg = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8"));
    let exe = null;
    try { exe = require("electron"); } catch {}
    if (typeof exe === "string" && existsSync(exe)) return { ok: true, text: `electron ${pkg.version} (${exe})` };
    return { ok: false, text: `electron ${pkg.version}, executable missing`, hint: "npm install (or: node node_modules/electron/install.js)" };
  } catch {
    return { ok: false, text: "electron not installed", hint: "npm install" };
  }
}

function checkPackaged() {
  const packaged = isPackaged();
  return { ok: true, text: `packaged ${packaged ? "yes" : "no"} (${process.versions.electron || packaged ? process.execPath : "node"})` };
}

function checkGit() {
  try {
    const v = execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { ok: true, text: v };
  } catch {
    return { ok: false, text: "git not on PATH", hint: "install git (replay and sessions record the game's git sha)" };
  }
}

export async function run({ positional = [] } = {}) {
  const checks = [
    { name: "snapper", ok: true, text: `snapper ${SNAPPER_VERSION}` },
    { name: "node", ok: true, text: `node ${process.versions.node}` },
    { name: "electron", ...checkElectron() },
    { name: "packaged", ...checkPackaged() },
    { name: "git", ...checkGit() },
    existsSync(SDK)
      ? { name: "sdk", ok: true, text: `sdk ${SDK}` }
      : { name: "sdk", ok: false, text: `sdk missing: ${SDK}`, hint: "restore packages/sdk/snapper.js" },
    // info only (always ok): when to reach for --coi
    { name: "coi", ok: true, text: "coi: use --coi for Godot 4 web exports (they need SharedArrayBuffer); off by default because require-corp blocks cross-origin assets that lack CORP headers" },
  ];
  // v1.4: `snapper doctor <game-root>` adds the integration finding (info only, always ok)
  if (positional[0]) {
    const root = resolve(positional[0]);
    if (existsSync(root)) checks.push({ name: "integration", ok: true, text: integrationLine(detectIntegration(root)) });
    else checks.push({ name: "integration", ok: true, text: `integration: game root not found: ${root}` });
  }
  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad++;
    process.stdout.write(`${c.ok ? "ok     " : "MISSING"}  ${c.text}${c.ok ? "" : `  -> fix: ${c.hint}`}\n`);
  }
  process.stdout.write(bad ? `${bad} problem(s)\n` : "all ok\n");
  return bad ? 1 : 0;
}
