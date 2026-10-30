// snapper skill install <game-root> — copy packages/skill/snapper into <game-root>/.claude/skills/snapper.
import { existsSync, statSync } from "node:fs";
import { cp, readdir, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_SRC = fileURLToPath(new URL("../../skill/snapper/", import.meta.url));

async function listFiles(dir, base = "") {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await listFiles(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Install the Snapper skill into `<root>/.claude/skills/snapper` and nothing else in the game folder.
 * Returns { dest, files } (files = absolute paths written). Throws an Error with a user-facing message; `.exitCode`
 * is the CLI exit code (2 usage/game root, 1 missing skill source). Shared by the CLI and the launcher.
 */
export async function installSkill(rootArg) {
  const root = resolve(String(rootArg ?? ""));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw Object.assign(new Error(`game root not found: ${root}`), { exitCode: 2 });
  }
  if (!existsSync(SKILL_SRC)) {
    throw Object.assign(new Error(`skill source missing: ${SKILL_SRC}`), { exitCode: 1 });
  }
  const dest = join(root, ".claude", "skills", "snapper");
  await mkdir(dirname(dest), { recursive: true });
  await cp(SKILL_SRC, dest, { recursive: true, force: true });
  const files = (await listFiles(SKILL_SRC)).map(f => join(dest, ...f.split("/")));
  return { dest, files };
}

export async function run({ positional }) {
  const [sub, rootArg] = positional;
  if (sub !== "install" || !rootArg) {
    process.stderr.write("snapper skill: usage: snapper skill install <game-root>\n");
    return 2;
  }
  let res;
  try { res = await installSkill(rootArg); } catch (e) {
    process.stderr.write(`snapper skill: ${e.message}\n`);
    return e.exitCode ?? 1;
  }
  for (const f of res.files) process.stdout.write(`wrote ${f}\n`);
  return 0;
}
