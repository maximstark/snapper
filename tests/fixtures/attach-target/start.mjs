// Starts a browser with remote debugging on, for the attach tests and gate Z3 (scripts/verify-attach.mjs).
//   startElectronTarget({ url, url2? }) → the repo's own Electron on tests/fixtures/attach-target/main.mjs (a visible 1280x720 window)
//   startEdgeTarget({ url })     → Microsoft Edge headless (null when msedge.exe is not installed)
// Both return { kind, port, endpoint, browser, pid, profile, stop() }. stop() kills only the process tree that was started and deletes its
// throwaway profile. Chrome 136+ and current Edge refuse --remote-debugging-port on the default profile: the profile is always ours.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCommand, electronChildEnv } from "../../../packages/host/main/electron-bin.mjs";
import { browserVersion, listTargets } from "../../../packages/host/main/cdp.mjs";

const MAIN = fileURLToPath(new URL("./main.mjs", import.meta.url));
export const EDGE_EXE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync(process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "taskkill.exe") : "taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {}
}

/** Windows: stop every process whose command line names our throwaway profile (a browser may re-launch itself, so the pid we spawned is not enough). Only ours: the profile folder is unique. */
function killByProfile(profile) {
  if (process.platform !== "win32") return;
  const q = String(profile).replace(/'/g, "''");
  try {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${q}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { stdio: "ignore", windowsHide: true });
  } catch {}
}

async function waitForPage(endpoint, urlPart, ms = 30000, count = 1) {
  const t0 = Date.now();
  for (;;) {
    try {
      const list = await listTargets(endpoint, { timeoutMs: 1500 });
      if (list.filter(t => t.url.includes(urlPart)).length >= count) return list;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`no page with ${urlPart} at ${endpoint} within ${ms} ms`);
    await sleep(150);
  }
}

async function finish(kind, child, profile, port, url, count = 1) {
  const endpoint = `http://127.0.0.1:${port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    killTree(child.pid);
    killByProfile(profile);
    await sleep(500);
    for (let i = 0; i < 10; i++) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); } }
  };
  try {
    await waitForPage(endpoint, new URL(url).host, 30000, count);
    await sleep(500);                                         // let the page boot a moment
  } catch (e) { await stop(); throw e; }
  const v = await browserVersion(endpoint);
  return { kind, port, endpoint, browser: v?.Browser || null, pid: child.pid, profile, stop };
}

export async function startElectronTarget({ url, url2, port } = {}) {
  port ||= await freePort();
  const profile = mkdtempSync(join(tmpdir(), "snapper-attach-target-"));
  const { exe } = electronCommand();
  const child = spawn(exe, [MAIN], {
    env: electronChildEnv({ ATTACH_TARGET_URL: url, ...(url2 ? { ATTACH_TARGET_URL2: url2 } : {}), ATTACH_TARGET_PORT: String(port), ATTACH_TARGET_USERDATA: profile, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" }),
    stdio: ["ignore", "ignore", "inherit"], windowsHide: false,
  });
  return finish("electron", child, profile, port, url, url2 ? 2 : 1);
}

export async function startEdgeTarget({ url, port } = {}) {
  if (!existsSync(EDGE_EXE)) return null;
  port ||= await freePort();
  const profile = mkdtempSync(join(tmpdir(), "snapper-attach-edge-"));
  const child = spawn(EDGE_EXE, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--window-size=1280,720", url,
  ], { stdio: "ignore", windowsHide: true });
  return finish("edge", child, profile, port, url);
}
