// Test helper: an Electron main script that serves the replay page driver (packages/host/replay/driver-electron.mjs)
// over a tiny JSON RPC on 127.0.0.1, so the plain-Node e2e tests can drive a real Chromium page.
// Run as `electron tests/e2e/helpers/driver-server.mjs`; electron-pages.mjs spawns it. The chosen port is written
// to the file named by SNAPPER_DRIVER_PORT_FILE once the server listens.
//   POST /rpc  { method, ...args }  → { ok: true, value } | { ok: false, error }
//   methods: open { initScripts, width, height, headed } → { id, version, dpr, size }, goto, waitForStepper,
//            evaluate, screenshot (base64 PNG), cdp, errors, console, close { id }, quit
import { app } from "electron";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The same Chromium switches as the single entry (entry.mjs): a hidden window must keep rendering.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
// A throwaway profile (the parent test deletes it).
const userData = join(tmpdir(), "snapper-driver-server-" + process.pid);
try { mkdirSync(userData, { recursive: true }); app.setPath("userData", userData); } catch {}
// Pages are opened and closed all the time; never quit because no window is left.
app.on("window-all-closed", () => {});

const { createElectronDriver } = await import("../../../packages/host/replay/driver-electron.mjs");

const drivers = new Map();
let nextId = 1;
const get = id => {
  const d = drivers.get(id);
  if (!d) throw new Error(`no driver ${id}`);
  return d;
};

const methods = {
  async open({ initScripts = [], width = 640, height = 360, headed = false } = {}) {
    const d = await createElectronDriver({ width, height, headed });
    for (const s of initScripts) await d.addInitScript(s);
    const id = nextId++;
    drivers.set(id, d);
    return { id, version: d.version, dpr: d.dpr, size: d.size };
  },
  async goto({ id, url }) { await get(id).goto(url); },
  async waitForStepper({ id, ms = 30000 }) { await get(id).waitForStepper(ms); },
  evaluate: ({ id, expression }) => get(id).evaluate(expression),
  async screenshot({ id }) { return (await get(id).screenshot()).toString("base64"); },
  cdp: ({ id, cdpMethod, params }) => get(id).cdp(cdpMethod, params),
  errors: ({ id }) => [...get(id).pageErrors],
  console: ({ id }) => get(id).console.map(c => ({ ...c })),
  async close({ id }) {
    const d = drivers.get(id);
    drivers.delete(id);
    if (d) await d.close();
  },
  async quit() {
    for (const d of drivers.values()) await d.close().catch(() => {});
    drivers.clear();
    setTimeout(() => app.exit(0), 20);
  },
};

// Never `await app.whenReady()` at the top level: Electron waits for the main module before it emits `ready`.
app.whenReady().then(() => {
const server = createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", async () => {
    let out;
    try {
      const msg = JSON.parse(body || "{}");
      if (!methods[msg.method]) throw new Error(`unknown method ${msg.method}`);
      out = { ok: true, value: await methods[msg.method](msg) };
    } catch (e) {
      out = { ok: false, error: String(e && e.stack || e) };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});
server.listen(0, "127.0.0.1", () => {
  const file = process.env.SNAPPER_DRIVER_PORT_FILE;
  if (file) writeFileSync(file, String(server.address().port));
});
});
