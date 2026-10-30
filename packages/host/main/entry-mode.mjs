// Pure: which of the four roles the single entry point plays (BRIEF-v1.2 §3), from the environment and argv.
// No Electron import, so unit tests load it in plain Node.

/** First arguments that make the entry run the CLI dispatcher instead of the launcher. */
export const CLI_COMMANDS = new Set(["play", "replay", "summary", "list", "skill", "doctor", "check", "mcp",
  "attach", "pack", "import", "triage", "issue", "export-repro", "serve", "help", "version", "--version", "--help", "-h"]);

/**
 * env: process.env; args: the user arguments (argv without the exe and, in dev, without the entry script).
 * Returns "play" | "replay" | "check" | "attach" | "cli" | "launcher". Order: SNAPPER_OPTS, SNAPPER_REPLAY_OPTS,
 * SNAPPER_CHECK_OPTS (v1.3: the `snapper check` child), SNAPPER_ATTACH_OPTS (v1.4: the `snapper attach` host), a CLI
 * command, else the launcher.
 */
export function entryMode(env = {}, args = []) {
  if (env.SNAPPER_OPTS) return "play";
  if (env.SNAPPER_REPLAY_OPTS) return "replay";
  if (env.SNAPPER_CHECK_OPTS) return "check";
  if (env.SNAPPER_ATTACH_OPTS) return "attach";
  if (args.length && CLI_COMMANDS.has(String(args[0]))) return "cli";
  return "launcher";
}

/**
 * The user arguments of an Electron browser process: a dev Electron (`electron entry.mjs …`, process.defaultApp true)
 * has the script at argv[1]; a packaged one has the user arguments right after the exe.
 */
export function userArgs(argv = [], defaultApp = false) {
  return argv.slice(defaultApp ? 2 : 1);
}
