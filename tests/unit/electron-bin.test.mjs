// X1: packaged detection and the Electron child command (pure functions over injected process facts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPackagedInfo, electronCommandFor, electronChildEnv, APP_ROOT, ENTRY } from "../../packages/host/main/electron-bin.mjs";

const DEV_ROOT = "C:\\Coding\\Snapper";
const DEV_RES = "C:\\Coding\\Snapper\\node_modules\\electron\\dist\\resources";
const PKG_RES = "C:\\Users\\me\\AppData\\Local\\Programs\\Snapper\\resources";
const PKG_ROOT = PKG_RES + "\\app";

test("isPackagedInfo: dev Electron (GUI, resourcesPath inside node_modules) is not packaged", () => {
  assert.equal(isPackagedInfo({ electron: "44.9.0", resourcesPath: DEV_RES, appRoot: DEV_ROOT }), false);
});

test("isPackagedInfo: ELECTRON_RUN_AS_NODE in dev (resourcesPath is set, code is the repo) is not packaged", () => {
  assert.equal(isPackagedInfo({ electron: "44.9.0", resourcesPath: DEV_RES, appRoot: "C:\\Coding\\Snapper" }), false);
});

test("isPackagedInfo: code under <resourcesPath>/app is packaged (GUI or RUN_AS_NODE alike)", () => {
  assert.equal(isPackagedInfo({ electron: "44.9.0", resourcesPath: PKG_RES, appRoot: PKG_ROOT }), true);
});

test("isPackagedInfo: case-insensitive, slash-agnostic, trailing separators ignored", () => {
  assert.equal(isPackagedInfo({ electron: "44.9.0", resourcesPath: PKG_RES.toUpperCase(), appRoot: PKG_ROOT.toLowerCase() }), true);
  assert.equal(isPackagedInfo({ electron: "44.9.0", resourcesPath: "C:/Snap/resources/", appRoot: "C:\\Snap\\resources\\app\\" }), true);
  assert.equal(isPackagedInfo({ electron: "44.9.0", resourcesPath: PKG_RES, appRoot: PKG_ROOT + "x" }), false);
});

test("isPackagedInfo: no Electron or no resourcesPath → false", () => {
  assert.equal(isPackagedInfo({ resourcesPath: PKG_RES, appRoot: PKG_ROOT }), false);
  assert.equal(isPackagedInfo({ electron: "44.9.0", appRoot: PKG_ROOT }), false);
  assert.equal(isPackagedInfo({}), false);
  assert.equal(isPackagedInfo(), false);
});

test("electronCommandFor: plain Node → require('electron') path + [entry]", () => {
  const c = electronCommandFor({ execPath: "C:\\node.exe", appRoot: DEV_ROOT, entry: "E.mjs", requireElectron: () => "C:\\el\\electron.exe" });
  assert.deepEqual(c, { exe: "C:\\el\\electron.exe", args: ["E.mjs"], packaged: false });
});

test("electronCommandFor: dev Electron → process.execPath + [entry]", () => {
  const c = electronCommandFor({
    electron: "44.9.0", execPath: "C:\\el\\electron.exe", resourcesPath: DEV_RES, appRoot: DEV_ROOT, entry: "E.mjs",
    requireElectron: () => { throw new Error("must not be called inside Electron"); },
  });
  assert.deepEqual(c, { exe: "C:\\el\\electron.exe", args: ["E.mjs"], packaged: false });
});

test("electronCommandFor: packaged → process.execPath and NO script argument", () => {
  const c = electronCommandFor({
    electron: "44.9.0", execPath: "C:\\Snap\\Snapper.exe", resourcesPath: "C:\\Snap\\resources", appRoot: "C:\\Snap\\resources\\app", entry: "E.mjs",
  });
  assert.deepEqual(c, { exe: "C:\\Snap\\Snapper.exe", args: [], packaged: true });
});

test("electronCommandFor: require('electron') returning a non-string (the API object inside Electron) throws", () => {
  assert.throws(() => electronCommandFor({ appRoot: DEV_ROOT, requireElectron: () => ({ app: {} }) }), /cannot find the Electron binary/);
  assert.throws(() => electronCommandFor({ appRoot: DEV_ROOT, requireElectron: () => "" }), /cannot find the Electron binary/);
  assert.throws(() => electronCommandFor({ appRoot: DEV_ROOT }), /cannot find the Electron binary/);
  assert.throws(() => electronCommandFor({ appRoot: DEV_ROOT, requireElectron: () => { throw new Error("no module"); } }), /no module/);
});

test("electronCommandFor: defaults to the real entry file", () => {
  const c = electronCommandFor({ requireElectron: () => "x.exe" });
  assert.deepEqual(c.args, [ENTRY]);
  assert.ok(ENTRY.startsWith(APP_ROOT) && /entry\.mjs$/.test(ENTRY));
});

test("electronChildEnv: drops ELECTRON_RUN_AS_NODE, keeps the base and the extras", () => {
  const env = electronChildEnv({ SNAPPER_OPTS: "{}", SNAPPER_RESULT_FILE: "r.json" }, { PATH: "p", ELECTRON_RUN_AS_NODE: "1", KEEP: "yes" });
  assert.deepEqual(env, { PATH: "p", KEEP: "yes", SNAPPER_OPTS: "{}", SNAPPER_RESULT_FILE: "r.json" });
  // an extra cannot smuggle it back in
  assert.equal("ELECTRON_RUN_AS_NODE" in electronChildEnv({ ELECTRON_RUN_AS_NODE: "1" }, {}), false);
  // the base object is not mutated
  const base = { ELECTRON_RUN_AS_NODE: "1" };
  electronChildEnv({}, base);
  assert.equal(base.ELECTRON_RUN_AS_NODE, "1");
});
