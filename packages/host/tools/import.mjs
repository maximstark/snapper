// snapper import <zip> [--root <game-root>] [--out <dir>]   (at least one; both: --out is the sessions folder, --root is recorded) — a tester's outbox zip into the developer's sessions (BRIEF-v1.4 §3.3).
// Validates before writing anything: one session folder in the zip (under one top-level folder, or at the zip root) whose
// session.jsonl starts with {"kind":"session","v":1} and whose env.json has format 1; entry names are safe (extractZip also
// refuses them). Destination <root>/.snapper/sessions/<slug>/<id> (the root's config `out` is honoured) or <out>/<slug>/<id>;
// an existing id is never overwritten. Writes import.json and regenerates SESSION.md + SESSION.html.
// Exit codes: 0 ok, 1 error, 2 usage or refusal.
import { existsSync, statSync } from "node:fs";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { readZip, readZipEntry, extractZip, safeEntryName, resolveConfig, slugify, writeSummary } from "../../core/index.mjs";

const err = msg => process.stderr.write(`snapper import: ${msg}\n`);
const refuse = message => Object.assign(new Error(message), { exitCode: 2 });
const MAX_TOTAL_BYTES = 2 * 1024 ** 3;

/** `Read "<dir>\SESSION.md" and triage it with the snapper skill.` (what the launcher's Copy for Claude copies) */
export const copyLineFor = dir => `Read "${join(dir, "SESSION.md")}" and triage it with the snapper skill.`;

/**
 * Import a tester's zip. opts: { root (game root), out (sessions folder) } — at least one. With both, the session lands
 * under <out>/<slug>/<id> and import.json records root (what replay serves); with root only, under the root's sessions.
 * Returns { dir, id, slug, tester, copyLine }. Throws Error(user-facing) with .exitCode 2 for every refusal.
 */
export async function importSession(zipPath, { root, out } = {}) {
  if (!zipPath) throw refuse("usage: snapper import <zip> [--root <game-root>] [--out <dir>]");
  if (!root && !out) throw refuse("give --root <game-root> (and/or --out <sessions folder>)");
  const zip = resolve(String(zipPath));
  if (!existsSync(zip) || !statSync(zip).isFile()) throw refuse(`zip not found: ${zip}`);
  let entries;
  try { entries = await readZip(zip); } catch (e) { throw refuse(`not a readable zip (${e.message}): ${zip}`); }
  for (const e of entries) if (!safeEntryName(e.name)) throw refuse(`unsafe entry name ${JSON.stringify(e.name)} in the zip; nothing imported`);
  if (entries.reduce((a, e) => a + e.size, 0) > MAX_TOTAL_BYTES) throw refuse("the zip unpacks to more than 2 GiB; refusing");

  const sessionFiles = entries.filter(e => e.name === "session.jsonl" || e.name.endsWith("/session.jsonl"));
  if (!sessionFiles.length) throw refuse("no session folder in the zip (no session.jsonl)");
  if (sessionFiles.length > 1) throw refuse(`the zip holds ${sessionFiles.length} sessions (${sessionFiles.map(e => e.name).join(", ")}); import one session per zip`);
  const sj = sessionFiles[0].name;
  const prefix = sj.slice(0, -"session.jsonl".length);              // "" or "<top-level folder>/"
  if (prefix.split("/").length > 2) throw refuse(`session.jsonl is nested too deep (${sj}); expected <session id>/session.jsonl or session.jsonl`);

  const sessionBuf = await readZipEntry(zip, sj);
  const firstLine = sessionBuf.toString("utf8").split(/\r?\n/, 1)[0].replace(/^﻿/, "");
  let header;
  try { header = JSON.parse(firstLine); } catch { throw refuse("session.jsonl does not start with a JSON line; not a Snapper session"); }
  if (!header || header.kind !== "session") throw refuse(`the first line of session.jsonl is not {"kind":"session"} (got kind ${JSON.stringify(header?.kind)})`);
  if (header.v !== 1) throw refuse(`session.jsonl v ${JSON.stringify(header.v)}: this Snapper reads session v 1 only`);
  const envBuf = await readZipEntry(zip, `${prefix}env.json`);
  if (!envBuf) throw refuse("the session has no env.json");
  let env;
  try { env = JSON.parse(envBuf.toString("utf8")); } catch { throw refuse("env.json is not valid JSON"); }
  if (!env || env.format !== 1) throw refuse(`env.json format ${JSON.stringify(env?.format)}: this Snapper reads format 1 only`);

  const slug = slugify(env.game?.slug || header.game);
  const id = String(header.id || env.id || (prefix ? prefix.slice(0, -1) : basename(zip, ".zip")));
  if (!/^[\w][\w.-]*$/.test(id) || id.includes("..")) throw refuse(`unsafe session id ${JSON.stringify(id)}`);

  let base, rootAbs = null;
  if (root) {
    rootAbs = resolve(String(root));
    if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) throw refuse(`game root not found: ${rootAbs}`);
    let cfg;
    try { cfg = resolveConfig({ root: rootAbs }); } catch (e) { throw refuse(`cannot read snapper.config.json in ${rootAbs}: ${e.message}`); }
    base = cfg.out;
  }
  if (out) base = resolve(String(out));
  const dest = join(base, slug, id);
  if (existsSync(dest)) throw refuse(`session ${id} already exists at ${dest}; not overwriting`);

  try {
    await extractZip(zip, dest, { filter: n => n.startsWith(prefix) && !n.endsWith("/"), strip: prefix ? 1 : 0 });
    const tester = env.tester?.name ? String(env.tester.name) : null;
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "import.json"), JSON.stringify({ v: 1, importedAt: new Date().toISOString(), from: basename(zip), root: rootAbs, tester }, null, 2) + "\n");
    await writeSummary(dest);
    return { dir: dest, id, slug, tester, copyLine: copyLineFor(dest) };
  } catch (e) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

export async function run({ positional, flags }) {
  const [zip] = positional;
  for (const k of ["root", "out"]) if (flags[k] === true) { err(`--${k} needs a value`); return 2; }
  if (!zip) { err("usage: snapper import <zip> [--root <game-root>] [--out <dir>]"); return 2; }
  try {
    const r = await importSession(zip, { root: flags.root, out: flags.out });
    process.stdout.write(`${r.dir}\n`);
    process.stdout.write(`${r.copyLine}\n`);
    if (r.tester) process.stderr.write(`snapper import: session from ${r.tester}\n`);
    return 0;
  } catch (e) {
    err(e.message);
    return e.exitCode ?? 1;
  }
}
