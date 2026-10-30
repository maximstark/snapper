// End-to-end: `--coi` makes the page cross-origin isolated (Godot 4 web exports need it); without the flag it is not.
// Opens a real window per play (a few seconds each). Run with: npm run test:e2e
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI = join(ROOT, "bin", "snapper.mjs");

function play(args, timeoutMs = 120000) {
  return new Promise(res => {
    const child = spawn(process.execPath, [CLI, "play", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const to = setTimeout(() => child.kill(), timeoutMs);
    child.on("exit", code => { clearTimeout(to); res({ code, stdout, stderr }); });
  });
}
const lastLine = s => s.trim().split(/\r?\n/).pop();

test("play --coi: the page is cross-origin isolated; without --coi the same smoke fails on the eval step", async t => {
  const tmp = mkdtempSync(join(tmpdir(), "snapper-coi-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const smoke = join(tmp, "coi-smoke.json");
  writeFileSync(smoke, JSON.stringify([
    { wait: 800 },
    { eval: "if (!globalThis.crossOriginIsolated) throw new Error('not isolated'); 1" },
    { end: true },
  ]));

  const on = await play(["examples/demo", "--coi", "--smoke", smoke, "--out", join(tmp, "on")]);
  assert.equal(on.code, 0, on.stderr);
  assert.equal(JSON.parse(lastLine(on.stdout)).ok, true);

  const off = await play(["examples/demo", "--smoke", smoke, "--out", join(tmp, "off")]);
  assert.equal(JSON.parse(lastLine(off.stdout)).ok, false);
  assert.match(off.stderr, /smoke failure:.*not isolated/);
});
