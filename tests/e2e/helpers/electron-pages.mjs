// Test helper (plain Node): starts the Electron driver server (driver-server.mjs) once and hands out small page
// objects, each a hidden Electron window driven over CDP. No browser dependency beyond Electron.
//   const pages = await startPages();            // in before()
//   const page = await pages.open({ initScripts: [nullBridge, sdk], width: 640, height: 360 });
//   await page.goto(url); await page.waitForStepper(); await page.evaluate("1+1"); await page.key("KeyD", "down");
//   await page.close(); await pages.stop();      // in after()
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCommand, electronChildEnv } from "../../../packages/host/main/electron-bin.mjs";
import { keyInfo } from "../../../packages/host/main/helpers.mjs";

const SERVER = fileURLToPath(new URL("./driver-server.mjs", import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The "no bridge" bridge the replay runner injects ahead of the SDK. */
export const NULL_BRIDGE = "globalThis.__snapperBridge = { send() {}, sendTape() {} };";

export async function startPages() {
  const dir = mkdtempSync(join(tmpdir(), "snapper-pages-"));
  const portFile = join(dir, "port");
  const { exe } = electronCommand();
  const child = spawn(exe, [SERVER], {
    env: electronChildEnv({ SNAPPER_DRIVER_PORT_FILE: portFile, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" }),
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });
  const exited = new Promise(res => child.on("exit", res));
  let dead = false;
  exited.then(() => { dead = true; });

  const deadline = Date.now() + 30000;
  while (!existsSync(portFile)) {
    if (dead) throw new Error("the Electron driver server exited before it listened");
    if (Date.now() > deadline) { child.kill(); throw new Error("the Electron driver server did not start within 30 s"); }
    await sleep(50);
  }
  const base = `http://127.0.0.1:${readFileSync(portFile, "utf8").trim()}/rpc`;

  const rpc = async (method, args = {}) => {
    const r = await fetch(base, { method: "POST", body: JSON.stringify({ method, ...args }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    return j.value;
  };

  const open = async ({ initScripts = [], width = 640, height = 360, headed = false } = {}) => {
    const info = await rpc("open", { initScripts, width, height, headed });
    const id = info.id;
    const page = {
      ...info,
      evaluate: expression => rpc("evaluate", { id, expression }),
      /** Run a function in the page: call(fn, arg) evaluates `(fn)(arg)` with arg inlined as JSON. */
      call: (fn, arg) => rpc("evaluate", { id, expression: `(${fn})(${JSON.stringify(arg ?? null)})` }),
      goto: url => rpc("goto", { id, url }),
      waitForStepper: (ms = 30000) => rpc("waitForStepper", { id, ms }),
      screenshot: async () => Buffer.from(await rpc("screenshot", { id }), "base64"),
      cdp: (method, params) => rpc("cdp", { id, cdpMethod: method, params }),
      /** A real key event through CDP Input.dispatchKeyEvent. dir: "down" | "up". */
      async key(code, dir) {
        const k = keyInfo(code);
        const down = dir === "down";
        await rpc("cdp", {
          id, cdpMethod: "Input.dispatchKeyEvent",
          params: {
            type: down ? (k.text ? "keyDown" : "rawKeyDown") : "keyUp",
            code: k.code, key: k.key, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
            ...(down && k.text ? { text: k.text } : {}),
          },
        });
      },
      async press(code) { await page.key(code, "down"); await page.key(code, "up"); },
      errors: () => rpc("errors", { id }),
      console: () => rpc("console", { id }),
      close: () => rpc("close", { id }),
    };
    return page;
  };

  const stop = async () => {
    if (!dead) {
      await rpc("quit").catch(() => {});
      await Promise.race([exited, sleep(5000)]);
      if (!dead) child.kill();
      await Promise.race([exited, sleep(2000)]);
    }
    try { if (child.pid) rmSync(join(tmpdir(), `snapper-driver-server-${child.pid}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };

  return { open, stop };
}
