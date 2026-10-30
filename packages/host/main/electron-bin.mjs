// How to start an Electron child (the play host, the replay process) from wherever Snapper is running (v1.2, D-025).
//
//   plain Node (`node bin/snapper.mjs …`)            exe = require("electron") (a path), args = [entry.mjs]
//   dev Electron (`electron entry.mjs …`, the GUI
//     CLI path, or ELECTRON_RUN_AS_NODE=1 electron.exe) exe = process.execPath,       args = [entry.mjs]
//   packaged (Snapper.exe, GUI or RUN_AS_NODE shim)  exe = process.execPath,       args = []  (a packaged Electron ignores
//                                                                                              a script and runs its own main)
//
// Packaged detection (D-025): the code is packaged when Electron is running it AND it lives in
// `<process.resourcesPath>/app` (electron-builder with asar:false puts the repo tree there). `process.defaultApp`
// alone cannot tell: under ELECTRON_RUN_AS_NODE it is undefined in dev and packaged alike, and `process.resourcesPath`
// is set in both (dev: node_modules/electron/dist/resources).
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The app root: the folder holding package.json, packages/, bin/ (the repo in dev, resources/app when packaged). */
export const APP_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
/** The single entry point (BRIEF-v1.2 §3). */
export const ENTRY = join(APP_ROOT, "packages", "host", "main", "entry.mjs");

const norm = p => resolve(String(p)).replace(/[\\/]+$/, "").toLowerCase();

/**
 * Pure: is this code running packaged? `info` = { electron: process.versions.electron, resourcesPath, appRoot }.
 */
export function isPackagedInfo({ electron, resourcesPath, appRoot = APP_ROOT } = {}) {
  if (!electron || !resourcesPath) return false;
  return norm(join(resourcesPath, "app")) === norm(appRoot);
}

/** Is the current process running packaged code? */
export function isPackaged() {
  return isPackagedInfo({ electron: process.versions.electron, resourcesPath: process.resourcesPath, appRoot: APP_ROOT });
}

/**
 * The bundled examples (v1.3: demo, phaser, pixi, three): `<resourcesPath>/app/examples` when packaged, the repo's
 * `examples/` in dev (BRIEF-v1.3 §9: resolved from the packaged detection).
 */
export function examplesDir() {
  return isPackaged() ? join(process.resourcesPath, "app", "examples") : join(APP_ROOT, "examples");
}

/**
 * Pure: the command that starts an Electron child on the entry.
 * `info` = { electron, execPath, resourcesPath, appRoot, entry, requireElectron: () => string }.
 * Returns { exe, args, packaged }.
 */
export function electronCommandFor(info = {}) {
  const packaged = isPackagedInfo(info);
  const entry = info.entry || ENTRY;
  if (info.electron) return { exe: info.execPath, args: packaged ? [] : [entry], packaged };
  const exe = info.requireElectron ? info.requireElectron() : null;
  if (typeof exe !== "string" || !exe) throw new Error("cannot find the Electron binary (npm install in the Snapper repo)");
  return { exe, args: [entry], packaged: false };
}

/** The command for this process. */
export function electronCommand() {
  return electronCommandFor({
    electron: process.versions.electron, execPath: process.execPath, resourcesPath: process.resourcesPath,
    appRoot: APP_ROOT, entry: ENTRY, requireElectron: () => createRequire(import.meta.url)("electron"),
  });
}

/** The environment for an Electron child: the parent's, plus `extra`, never ELECTRON_RUN_AS_NODE (the child is a GUI app). */
export function electronChildEnv(extra = {}, base = process.env) {
  const env = { ...base, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
