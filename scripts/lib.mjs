// Helpers for the gate scripts (verify-demo, verify-check, verify-trust): run the CLI, collect checks, copy evidence.
import { spawn } from "node:child_process";
import { mkdir, copyFile, readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pngSize, pngStats } from "../packages/core/index.mjs";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(REPO, "bin", "snapper.mjs");
export const exists = p => access(p).then(() => true, () => false);

/** Run `node bin/snapper.mjs …args`. Resolves { code, stdout, stderr, last } (last = last stdout line parsed as JSON, or null). */
export function snapper(args, { timeoutMs = 180000, echo = true } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; if (echo) process.stdout.write(d); });
    child.stderr.on("data", d => { stderr += d; if (echo) process.stderr.write(d); });
    const timer = setTimeout(() => { stderr += `\n[verify] timeout after ${timeoutMs} ms, killing\n`; child.kill(); }, timeoutMs);
    child.on("close", code => {
      clearTimeout(timer);
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let last = null;
      try { last = JSON.parse(lines[lines.length - 1]); } catch {}
      resolve({ code, stdout, stderr, last, lastLine: lines[lines.length - 1] ?? "" });
    });
  });
}

/** A list of named checks; `check(name, ok, detail)`; `report()` prints and returns all-ok. */
export function checklist(title) {
  const items = [];
  return {
    items,
    check(name, ok, detail = "") {
      items.push({ name, ok: !!ok, detail: String(detail) });
      process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
      return !!ok;
    },
    report() {
      const failed = items.filter(i => !i.ok);
      process.stdout.write(`\n${title}: ${failed.length ? `FAIL (${failed.length} of ${items.length} checks failed)` : `PASS (${items.length} checks)`}\n`);
      return failed.length === 0;
    },
  };
}

export async function png(path) {
  try {
    const buf = await readFile(path);
    return { size: pngSize(buf), stats: pngStats(buf) };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

export async function json(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

/** Copy files into private/evidence/<version>/<gate>/ (default v1.0) as [src, destName] pairs. Returns the dest paths. */
export async function evidence(gate, pairs, version = "v1.0") {
  const dir = evidenceDir(version, gate);
  await mkdir(dir, { recursive: true });
  const out = [];
  for (const [src, name] of pairs) {
    if (!(await exists(src))) continue;
    await copyFile(src, join(dir, name));
    out.push(join(dir, name));
  }
  return out;
}

/** private/evidence/<version>/<gate>; EVIDENCE_VERSION (e.g. "v1.2/x2", v1.2) re-targets a re-run so it never overwrites older evidence. */
export const evidenceDir = (version, gate) => join(REPO, "private", "evidence", ...(process.env.EVIDENCE_VERSION || version).split("/"), gate);

/** Gate scripts rewrite private/evidence/** only when EVIDENCE=1 is set (v1.1.1: keeps the tree clean on routine runs). */
export const EVIDENCE_ON = process.env.EVIDENCE === "1";
