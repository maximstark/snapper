// Fixtures for the v1.4 team tests: a session-a copy with a tester, a zip of it, a spawn helper that does not block the event loop.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionA, SESSION_A_ENV } from "./session-a.mjs";
import { zipDir } from "../../packages/core/index.mjs";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = join(REPO, "bin", "snapper.mjs");
export const GH_STUB_DIR = join(REPO, "tests", "fixtures", "gh-stub");

/** Async `node bin/snapper.mjs …args` → { status, stdout, stderr }. */
export function snapperAsync(args, { env = {}, cwd = REPO } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

/**
 * Build session-a at `<base>/<slug>/<id>` and patch env.json: game.root = `gameRoot` (when given), tester { name } (when given),
 * extra top-level env keys. Returns the session folder.
 */
export async function makeSession(base, { slug = "demo-game", id = "2026-10-18T14-02-11", gameRoot, tester, env = {}, garbage = false } = {}) {
  const dir = join(base, slug, id);
  await mkdir(dir, { recursive: true });
  await buildSessionA(dir, { garbage });
  const e = JSON.parse(await readFile(join(dir, "env.json"), "utf8"));
  e.game = { ...SESSION_A_ENV.game, slug, ...(gameRoot ? { root: gameRoot } : {}) };
  if (tester) e.tester = { name: tester };
  Object.assign(e, env);
  await writeFile(join(dir, "env.json"), JSON.stringify(e, null, 2) + "\n");
  const sj = (await readFile(join(dir, "session.jsonl"), "utf8")).replace(/"id":"2026-10-18T14-02-11"/, `"id":"${id}"`);
  await writeFile(join(dir, "session.jsonl"), sj);
  return dir;
}

/** Zip a session folder the way tester mode does: entries under `<session id>/`. */
export async function zipSession(dir, outFile) {
  const id = basename(dir);
  await zipDir(dir, outFile, { prefix: `${id}/` });
  return outFile;
}
