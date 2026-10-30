// A stand-in for the Snapper CLI in the MCP unit tests (no Electron): `replay <session> <mark>` writes a replay folder and
// prints it; `check <root> --json` prints one JSON line; anything else exits 2 with a message on stderr.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "replay") {
  if (b === "0002") { process.stderr.write("snapper replay: mark 0002 is not replayable: fake refusal\n"); process.exit(2); }
  const out = join(a, "marks", b, "replay");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "replay.json"), JSON.stringify({ mark: b, frameAt: 2538, stateMatches: true, chromium: "152.0", warnings: [], frames: [] }));
  writeFileSync(join(out, "replay.md"), `# Replay of mark ${b} at frame 2538\n\nstateMatches: true (fake)\n`);
  process.stdout.write(`${out}\n`);
} else if (cmd === "check") {
  const rows = [
    { session: "2026-10-18T14-02-11", mark: "0001", frame: 2538, trigger: "hotkey", note: "swan clips", result: "match", expectation: "state" },
    { session: "2026-10-18T14-02-11", mark: "0002", frame: 4201, trigger: "exception", note: "", result: "differs", firstDiff: "$.player.x", expectation: "state" },
  ];
  process.stdout.write("noise before the json line\n");
  process.stdout.write(JSON.stringify({ rows, summary: { total: 2, match: 1, differs: 1, skipped: 0, error: 0, accepted: 0, ms: 1234, exit: 1 }, checkFile: join(a, "checks", "x.json"), argv: process.argv.slice(2) }) + "\n");
  process.exit(1);
} else if (cmd === "import") {
  // `import <zip> --root <root>`: the fixture session already sits under <root>; print it like the real CLI (v1.4)
  const root = process.argv[process.argv.indexOf("--root") + 1];
  process.stdout.write(`imported to ${join(root, ".snapper", "sessions", "moonflexforceabilities-v3", "2026-10-18T14-02-11")}\n`);
  process.stdout.write("Read \"…\\SESSION.md\" and triage it with the snapper skill.\n");
} else if (cmd === "export-repro") {
  const out = join(a, "marks", b, "repro");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "README.md"), `# No-Snapper repro of mark ${b}\n\n(fake)\n`);
  process.stdout.write(`${out}\n`);
} else {
  process.stderr.write(`fake-cli: unknown ${cmd}\n`);
  process.exit(2);
}
