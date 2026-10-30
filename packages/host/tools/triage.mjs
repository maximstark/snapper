// snapper triage <session-dir> <mark> <open|fixed|wontfix|duplicate|cannot-reproduce> [--note "…"] [--by <name>] [--of <mark>] [--commit <sha>]
// Writes marks/NNNN/triage.json (core writeTriage) and regenerates SESSION.md + SESSION.html. Exit 0 ok, 2 usage or refusal.
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { writeTriage, writeSummary, triageLine, TRIAGE_STATUSES } from "../../core/index.mjs";

const USAGE = `usage: snapper triage <session-dir> <mark> <${TRIAGE_STATUSES.join("|")}> [--note "…"] [--by <name>] [--of <mark>] [--commit <sha>]`;
const err = msg => process.stderr.write(`snapper triage: ${msg}\n`);
const str = v => (typeof v === "string" ? v : undefined);

export function defaultBy() {
  try { return userInfo().username || "unknown"; } catch { return process.env.USERNAME || process.env.USER || "unknown"; }
}

export async function run({ positional, flags }) {
  const [sessionArg, mark, status] = positional;
  if (!sessionArg || !mark || !status) { err(USAGE); return 2; }
  for (const k of ["note", "by", "of", "commit"]) {
    if (flags[k] === true) { err(`--${k} needs a value`); return 2; }
  }
  const dir = resolve(sessionArg);
  try {
    const { doc } = await writeTriage(dir, mark, {
      status, by: str(flags.by) ?? defaultBy(), note: str(flags.note), of: str(flags.of), commit: str(flags.commit),
    });
    process.stdout.write(`${String(mark).padStart(4, "0")}: ${triageLine(doc)}\n`);
    await writeSummary(dir);
  } catch (e) {
    err(e.message);
    return 2;
  }
  return 0;
}
