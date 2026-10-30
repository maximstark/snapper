#!/usr/bin/env node
// snapper CLI dispatcher. Each command lives in its own module and exports
// `async function run(args) → exit code`, where args = { positional: string[], flags: {…} }.
//
//   play     → ../main/cli-play.mjs      (spawns Electron on ../main/entry.mjs)
//   replay   → ../replay/cli.mjs
//   summary  → ../tools/summary.mjs
//   list     → ../tools/list.mjs
//   skill    → ../tools/skill.mjs        (skill install <game-root>)
//   doctor   → ../tools/doctor.mjs
//   check    → ../tools/check.mjs        (v1.3: every replayable mark of past sessions, on the current code)
//   mcp      → ../tools/mcp.mjs          (v1.3: the MCP server on stdio; packages/mcp)
//   attach   → ../main/cli-attach.mjs    (v1.4: capture a page in a Chromium started with --remote-debugging-port)
//   pack     → ../tools/pack.mjs         (v1.4: the playtester kit zip)
//   import   → ../tools/import.mjs       (v1.4: a tester's outbox zip into the game's sessions)
//   triage   → ../tools/triage.mjs       (v1.4: marks/NNNN/triage.json)
//   issue    → ../tools/issue.mjs        (v1.4: Markdown / GitHub via gh / Discord webhook)
//   export-repro → ../tools/export-repro.mjs (v1.4: the no-Snapper repro folder)
//   serve    → ../tools/serve.mjs        (v1.4: a static server for a folder, e.g. repro-game)

const USAGE = `snapper — playtest capture for AI-built games

  snapper play <url|dir> [--preset deck|1080p|ultrawide|native] [--fullscreen] [--out <dir>] [--game-root <dir>]
                         [--query "?scene=…"] [--slug <name>] [--config <file>] [--smoke <script.json>]
                         [--resume <session-dir>|last [--at exit|<state>|mark-<id>|f<frame>]]
                         [--bare] [--coi] [--hotkeys mark=F8,save=F6] [--padMarkHoldMs 400] [--ringSeconds 5]
      --bare: no ring buffer, no overlay chip, no F9 panel (docs/TRUST.md); --coi: COOP/COEP headers (Godot 4 web)
      F6 saves a state; closing the window saves "exit"; --resume replays that run to the state and hands it back
      a mark after a level change restores with that segment's query; --query overrides it (sessions recorded before 1.1.1)
  snapper replay <session-dir> <mark-id> [--before 30] [--after 30] [--every 1] [--out <dir>] [--query "?..."]
  snapper summary <session-dir>          regenerate SESSION.md
  snapper list [<game-root>]              sessions, newest first, with mark counts
  snapper skill install <game-root>       install the snapper Claude skill into a game repo
  snapper doctor                          versions, Electron, packaged or dev, git
  snapper check <game-root> [--sessions N | --session <dir>] [--marks 0001,0003] [--accept] [--query "?..."]
                            [--out <dir>] [--json]
      replays every replayable mark of past sessions on the current code; exit 0 all match, 1 any differs or errors, 2 refusal
  snapper mcp                             the MCP server on stdin/stdout (claude mcp add snapper -- <snapper.cmd> mcp)
  snapper attach <http://host:port | ws://…/devtools/page/…> [--target <url or title>] [--game-root <dir>] [--slug <s>]
                 [--no-reload] [--hotkeys mark=F8] [--bare] [--out <dir>] [--smoke <script.json>]
      captures a page in a Chrome/Edge/Electron/NW.js you started with --remote-debugging-port (and --user-data-dir)
  snapper pack <game-root> [--out <zip>] [--bundle] [--url <u>] [--developer <name>]     the playtester kit
  snapper import <zip> [--root <game-root> | --out <dir>]                                 a tester's session
  snapper triage <session-dir> <mark> <open|fixed|wontfix|duplicate|cannot-reproduce> [--note "…"] [--by <name>] [--of <mark>] [--commit <sha>]
  snapper issue <session-dir> <mark> [--markdown | --github | --discord <webhook-url>] [--title "…"]
  snapper export-repro <session-dir> <mark> [--out <dir>] [--inject]                       replay a mark with no Snapper present
  snapper serve <dir> [--port <n>] [--coi]                                                a static server (e.g. for repro-game)
`;

const COMMANDS = {
  play: "../main/cli-play.mjs",
  replay: "../replay/cli.mjs",
  summary: "../tools/summary.mjs",
  list: "../tools/list.mjs",
  skill: "../tools/skill.mjs",
  doctor: "../tools/doctor.mjs",
  check: "../tools/check.mjs",
  mcp: "../tools/mcp.mjs",
  attach: "../main/cli-attach.mjs",
  pack: "../tools/pack.mjs",
  import: "../tools/import.mjs",
  triage: "../tools/triage.mjs",
  issue: "../tools/issue.mjs",
  "export-repro": "../tools/export-repro.mjs",
  serve: "../tools/serve.mjs",
};

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set(["fullscreen", "help", "version", "json", "headed", "bare", "coi", "accept",
  "no-reload", "tester", "bundle", "inject", "markdown", "github"]);

/** `--name value`, `--name=value`, boolean flags; kebab-case names become camelCase. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      let [name, value] = a.slice(2).split(/=(.*)/s, 2);
      const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (value === undefined) {
        if (BOOLEAN_FLAGS.has(name) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) value = true;
        else value = argv[++i];
      }
      flags[key] = value;
    } else positional.push(a);
  }
  return { positional, flags };
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { process.stdout.write(USAGE); return 0; }
  if (cmd === "--version" || cmd === "version") {
    const { SNAPPER_VERSION } = await import("../../core/index.mjs");
    process.stdout.write(`snapper ${SNAPPER_VERSION}\n`);
    return 0;
  }
  const mod = COMMANDS[cmd];
  if (!mod) { process.stderr.write(`snapper: unknown command "${cmd}"\n\n${USAGE}`); return 2; }
  const args = parseArgs(rest);
  if (args.flags.help) { process.stdout.write(USAGE); return 0; }
  const { run } = await import(new URL(mod, import.meta.url));
  return await run(args);
}

const isMain = process.argv[1] && /snapper(\.mjs)?$/i.test(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain || process.env.SNAPPER_CLI_FORCE_MAIN) {
  runCli(process.argv.slice(2)).then(
    code => { process.exitCode = code ?? 0; },
    err => { process.stderr.write(`snapper: ${err && err.stack || err}\n`); process.exitCode = 1; },
  );
}
