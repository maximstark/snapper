// The single Electron entry point (BRIEF-v1.2 §3): Snapper.exe, and `electron packages/host/main/entry.mjs` in dev.
// It decides its role by environment and argv (entry-mode.mjs), in this order:
//   SNAPPER_OPTS set         → the play host (app.mjs, unchanged behaviour; cli-play.mjs and the launcher spawn it)
//   SNAPPER_REPLAY_OPTS set  → the replay process (replay/child.mjs; replay/cli.mjs spawns it)
//   SNAPPER_CHECK_OPTS set   → the check process (v1.3)
//   SNAPPER_ATTACH_OPTS set  → the attach host (v1.4: main/attach.mjs; main/cli-attach.mjs spawns it)
//   a CLI command first      → the CLI dispatcher in this process, then app.exit(code) (the GUI-subsystem path;
//                              the documented way is snapper.cmd, which runs the dispatcher under ELECTRON_RUN_AS_NODE)
//   otherwise                → the launcher window (launcher/main.mjs)
//
// Electron waits for this module's top-level await before it emits `ready`, so the role modules are imported here
// (their top-level code, e.g. app.mjs's userData and switches, runs before `ready`). Nothing imported from here may
// `await app.whenReady()` at its own top level: that would deadlock. Start work from an exported function instead.
import { app } from "electron";
import { entryMode, userArgs } from "./entry-mode.mjs";

const warn = msg => { try { process.stderr.write(`[snapper] ${msg}\n`); } catch {} };
const fatal = (what, err) => { warn(`${what}: ${err && err.stack || err}`); app.exit(1); };

// The host's Chromium switches, for every role (the play host sets them again itself; the replay process and the
// launcher's in-process replay need a hidden window that keeps rendering).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const args = userArgs(process.argv, !!process.defaultApp);
const mode = entryMode(process.env, args);

if (mode === "play") {
  await import("./app.mjs");                                   // runs the play host (its own main(), as before v1.2)
} else if (mode === "replay") {
  const { runReplayChild } = await import("../replay/child.mjs");
  runReplayChild().then(code => app.exit(code ?? 0), err => fatal("replay process", err));
} else if (mode === "check") {
  // v1.3: the `snapper check` child (tools/check.mjs spawns it with SNAPPER_CHECK_OPTS + SNAPPER_RESULT_FILE).
  const { runCheckChild } = await import("../replay/check-child.mjs");
  runCheckChild().then(code => app.exit(code ?? 0), err => fatal("check process", err));
} else if (mode === "attach") {
  // v1.4: the `snapper attach` host (main/cli-attach.mjs spawns it with SNAPPER_ATTACH_OPTS + SNAPPER_RESULT_FILE): no game
  // window; the page lives in the user's own browser, reached over a CDP WebSocket (main/cdp.mjs wsBackend).
  const { startAttach } = await import("./attach.mjs");
  startAttach().catch(err => fatal("attach host", err));
} else if (mode === "cli") {
  // The GUI-path CLI needs no browser profile; keep it off the launcher's userData (a profile in use by a running
  // launcher made Chromium print cache-lock errors here). One shared temp folder, not one per run.
  try {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    app.setPath("userData", join(tmpdir(), "snapper-cli-profile"));
  } catch {}
  const { runCli } = await import("../bin/snapper.mjs");
  runCli(args).then(code => app.exit(code ?? 0), err => fatal("snapper", err));
} else {
  const { startLauncher } = await import("../launcher/main.mjs");
  startLauncher().catch(err => fatal("launcher", err));
}
