// Plain-Node helper: open a page in a visible Electron window (electron-shot.mjs), screenshot it with capturePage().
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { electronCommand, electronChildEnv } from "../../packages/host/main/electron-bin.mjs";

const SCRIPT = fileURLToPath(new URL("./electron-shot.mjs", import.meta.url));

/** Screenshot `fileOrUrl` (a path or a URL) to `outPng`. Resolves the page report { ok, page: { images, scripts, ... }, size, blocked }. */
export async function shotPage(fileOrUrl, outPng, { width = 1400, timeoutMs = 60000 } = {}) {
  const url = /^[a-z]+:\/\//i.test(fileOrUrl) ? fileOrUrl : pathToFileURL(fileOrUrl).href;
  const dir = await mkdtemp(join(tmpdir(), "snapper-shotpage-"));
  const infoFile = join(dir, "info.json");
  const { exe } = electronCommand();
  const child = spawn(exe, [SCRIPT], {
    env: electronChildEnv({ SNAPPER_SHOT_URL: url, SNAPPER_SHOT_OUT: outPng, SNAPPER_SHOT_INFO: infoFile, SNAPPER_SHOT_WIDTH: String(width), ELECTRON_DISABLE_SECURITY_WARNINGS: "1" }),
    stdio: ["ignore", "ignore", "inherit"], windowsHide: false,
  });
  const code = await new Promise(res => {
    const t = setTimeout(() => { child.kill(); res(-1); }, timeoutMs);
    child.on("exit", c => { clearTimeout(t); res(c); });
    child.on("error", () => { clearTimeout(t); res(-2); });
  });
  let info = { ok: false, error: `electron exited ${code} without a report` };
  try { info = JSON.parse(await readFile(infoFile, "utf8")); } catch {}
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return { ...info, exitCode: code };
}
