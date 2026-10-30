// snapper summary <session-dir> — regenerate SESSION.md and SESSION.html (v1.4).
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeSummary } from "../../core/index.mjs";

export async function run({ positional }) {
  const dir = positional[0] && resolve(positional[0]);
  if (!dir) {
    process.stderr.write("snapper summary: usage: snapper summary <session-dir>\n");
    return 2;
  }
  if (!existsSync(join(dir, "session.jsonl"))) {
    process.stderr.write(`snapper summary: no session.jsonl in ${dir}\n`);
    return 2;
  }
  await writeSummary(dir);
  process.stdout.write(`${join(dir, "SESSION.md")}\n${join(dir, "SESSION.html")}\n`);
  return 0;
}
