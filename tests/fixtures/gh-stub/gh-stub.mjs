// The stub gh's brain (tests only). SNAPPER_GH_STUB_OUT names the file it writes: { args, cwd, body }.
// SNAPPER_GH_STUB_FAIL=1 makes it fail like an unauthenticated gh. Never talks to the network.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.SNAPPER_GH_STUB_FAIL) {
  process.stderr.write("gh: To get started with GitHub CLI, please run:  gh auth login\n");
  process.exit(1);
}
const i = args.indexOf("--body-file");
let body = null;
if (i >= 0) { try { body = readFileSync(args[i + 1], "utf8"); } catch (e) { body = `unreadable: ${e.message}`; } }
if (process.env.SNAPPER_GH_STUB_OUT) writeFileSync(process.env.SNAPPER_GH_STUB_OUT, JSON.stringify({ args, cwd: process.cwd(), body }, null, 2));
process.stdout.write("https://github.com/example/demo/issues/42\n");
