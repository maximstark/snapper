"use strict";
// The launcher page's only door to the main process: plain data in, plain data out.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const call = (name, ...args) => ipcRenderer.invoke(`snapper:${name}`, ...args);

// Drag and drop (v1.3): a sandboxed contextIsolation page has no File.path, and a File cannot cross the bridge. This
// preload sees the same DOM events, turns the dropped File into a path with webUtils.getPathForFile and sends only that
// string to the main process (dropPath validates it); the page gets the plain-data answer through onDrop.
// v1.4: a dropped .zip is a tester's session: it goes to importZip (with the page's current game folder), not dropPath.
let dropCb = null;
let rootGetter = null;
const hasFiles = e => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
window.addEventListener("dragover", e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
window.addEventListener("drop", async e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  let result;
  try {
    const file = e.dataTransfer.files[0];
    const p = file ? webUtils.getPathForFile(file) : "";
    if (!p) result = { error: "nothing was dropped" };
    else if (/\.zip$/i.test(String(p))) result = await call("importZip", String(p), String((rootGetter && rootGetter()) || ""));
    else result = await call("dropPath", String(p));
  } catch (err) { result = { error: String(err && err.message || err) }; }
  try { if (dropCb) dropCb(result); } catch {}
});

contextBridge.exposeInMainWorld("snapperLauncher", {
  getState: () => call("getState"),
  browse: () => call("browse"),
  setRoot: root => call("setRoot", String(root ?? "")),
  saveFields: fields => call("saveFields", { ...fields }),
  resetCapture: root => call("resetCapture", String(root ?? "")),
  listSessions: root => call("listSessions", String(root ?? "")),
  checkpoints: sessionDir => call("checkpoints", String(sessionDir)),
  marks: sessionDir => call("marks", String(sessionDir)),
  play: fields => call("play", { ...fields }),
  resume: (sessionDir, at, fields) => call("resume", String(sessionDir), String(at || "exit"), { ...fields }),
  replay: (sessionDir, markId) => call("replay", String(sessionDir), String(markId)),
  demos: () => call("demos"),
  tryDemo: slug => call("tryDemo", String(slug ?? "")),
  setupClaude: root => call("setupClaude", String(root ?? "")),
  copyForClaude: (sessionDir, markId) => call("copyForClaude", String(sessionDir), String(markId ?? "")),
  copyText: kind => call("copyText", String(kind)),
  check: root => call("check", String(root ?? "")),
  accept: (root, sessionDir, markId) => call("accept", String(root ?? ""), String(sessionDir), String(markId)),
  openPath: p => call("openPath", String(p)),
  reportLayout: elements => ipcRenderer.send("snapper:layout", elements),
  attachTargets: endpoint => call("attachTargets", String(endpoint ?? "")),
  attach: fields => call("attach", { ...fields }),
  detach: () => call("detach"),
  importZip: (p, root) => call("importZip", String(p), String(root ?? "")),
  openReport: sessionDir => call("openReport", String(sessionDir)),
  copyIssue: (sessionDir, markId) => call("copyIssue", String(sessionDir), String(markId)),
  setTriage: (sessionDir, markId, status, of) => call("setTriage", String(sessionDir), String(markId), String(status), String(of ?? "")),
  onDrop: (cb, getRoot) => { dropCb = typeof cb === "function" ? cb : null; rootGetter = typeof getRoot === "function" ? getRoot : null; },
  onEvent: cb => {
    ipcRenderer.on("snapper:event", (_e, ev) => { try { cb(ev); } catch {} });
  },
});
