// snapper serve <dir> [--port <n>] [--coi]   (v1.4, D-028; BRIEF-v1.4 §5.3)
// A static server for a folder (e.g. the repro-game/ that `snapper export-repro --inject` writes): core serveStatic on
// 127.0.0.1, no caching, COOP/COEP/CORP with --coi. Prints `serving <dir> at http://127.0.0.1:<port>/` and runs until
// Ctrl+C (or stdin closes when SNAPPER_SERVE_STDIN=1, for test harnesses). Exit 2 on a bad folder or port.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "../../core/index.mjs";

const err = s => process.stderr.write(`snapper serve: ${s}\n`);

export async function run({ positional = [], flags = {} }) {
  const dirArg = positional[0];
  if (!dirArg) { err("usage: snapper serve <dir> [--port <n>] [--coi]"); return 2; }
  const dir = resolve(String(dirArg));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { err(`not a folder: ${dir}`); return 2; }
  let port = 0;
  if (flags.port !== undefined) {
    port = Number(flags.port);
    if (flags.port === true || !Number.isInteger(port) || port < 0 || port > 65535) { err(`--port must be 0-65535 (got "${flags.port}")`); return 2; }
  }
  let srv;
  try { srv = await serveStatic(dir, { port, coi: flags.coi === true || flags.coi === "true" }); }
  catch (e) { err(`cannot listen on 127.0.0.1:${port}: ${e.message}`); return 2; }
  process.stdout.write(`serving ${dir} at ${srv.url}/${flags.coi ? " (cross-origin isolated)" : ""}\n`);
  process.stdout.write("Ctrl+C stops it\n");
  await new Promise(res => {
    const stop = () => res();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (process.env.SNAPPER_SERVE_STDIN === "1") { process.stdin.resume(); process.stdin.once("end", stop); process.stdin.once("close", stop); }
  });
  await srv.close().catch(() => {});
  return 0;
}
