// snapper list [<game-root>] [--json] — sessions of a game, newest first.
import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { resolveConfig, findSessions, readSession, fmtDuration, fmtSessionDuration, listCheckpoints } from "../../core/index.mjs";

/** `  states N (exit f12345)` for a session that has saved states, else nothing. */
const states = r => (r.checkpoints > 0 ? `  states ${r.checkpoints}${r.exitFrame != null ? ` (exit f${r.exitFrame})` : ""}` : "");

/**
 * The sessions of a game root, newest first: { root, out, rows: [{ id, slug, marks, errors, durationMs, activeMs, duration, live,
 * tester (env.json tester.name or null), checkpoints, exitFrame, path }] } — what `snapper list --json` prints; the launcher calls it too (v1.2).
 * `activeMs` is the end line's played time or null (v1.4.1, D-030); `duration` reads "played X of Y" when a minute or more was idle.
 * `out` overrides the config's sessions folder (the launcher's SNAPPER_OUT test hook). Throws an Error with a user-facing message when the root does not exist.
 */
export async function listSessions(rootArg, { out: outOverride = null } = {}) {
  const root = resolve(rootArg || process.cwd());
  if (!existsSync(root)) throw new Error(`game root not found: ${root}`);
  const { out } = resolveConfig({ root, flags: outOverride ? { out: resolve(outOverride) } : {} });
  const dirs = out ? await findSessions(out) : [];
  const rows = [];
  for (const dir of dirs) {
    const s = await readSession(dir, { marks: false });
    const cps = await listCheckpoints(dir);
    const exit = cps.filter(c => c.name === "exit").pop();
    const live = !s.end;
    const durationMs = s.end?.durationMs ?? s.lastT;
    rows.push({
      id: basename(dir),
      slug: s.env?.game?.slug || s.header?.game || "",
      marks: s.marks.length,
      errors: s.errors.length,
      durationMs,
      activeMs: Number.isFinite(s.end?.activeMs) ? s.end.activeMs : null,
      duration: s.end ? fmtSessionDuration(s.end) : fmtDuration(durationMs),
      live,
      tester: s.env?.tester?.name ? String(s.env.tester.name) : null,
      checkpoints: cps.length,
      exitFrame: Number.isInteger(exit?.frame) ? exit.frame : null,
      path: dir,
    });
  }
  return { root, out, rows };
}

export async function run({ positional, flags }) {
  let out, rows;
  try {
    ({ out, rows } = await listSessions(positional[0]));
  } catch (e) {
    process.stderr.write(`snapper list: ${e.message}\n`);
    return 2;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  if (!rows.length) {
    process.stdout.write(`no sessions under ${out}\n`);
    return 0;
  }
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.slug}  marks ${r.marks}  errors ${r.errors}  ${r.duration}${r.live ? " (live)" : ""}${r.tester ? `  from ${r.tester}` : ""}${states(r)}  ${r.path}\n`);
  }
  return 0;
}
