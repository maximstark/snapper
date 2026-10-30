// X1: the single entry point's role selection and argv handling (pure functions, no Electron).
import { test } from "node:test";
import assert from "node:assert/strict";
import { entryMode, userArgs, CLI_COMMANDS } from "../../packages/host/main/entry-mode.mjs";

test("entryMode: no env, no args → the launcher", () => {
  assert.equal(entryMode({}, []), "launcher");
  assert.equal(entryMode(undefined, undefined), "launcher");
});

test("entryMode: SNAPPER_OPTS → the play host, whatever the args", () => {
  assert.equal(entryMode({ SNAPPER_OPTS: "{}" }, []), "play");
  assert.equal(entryMode({ SNAPPER_OPTS: "{}" }, ["doctor"]), "play");
});

test("entryMode: SNAPPER_REPLAY_OPTS → the replay process", () => {
  assert.equal(entryMode({ SNAPPER_REPLAY_OPTS: "{}" }, []), "replay");
  assert.equal(entryMode({ SNAPPER_REPLAY_OPTS: "{}" }, ["play", "x"]), "replay");
});

test("entryMode precedence: SNAPPER_OPTS beats SNAPPER_REPLAY_OPTS beats a CLI command beats the launcher", () => {
  const both = { SNAPPER_OPTS: "{}", SNAPPER_REPLAY_OPTS: "{}" };
  assert.equal(entryMode(both, ["replay"]), "play");
  assert.equal(entryMode({ SNAPPER_REPLAY_OPTS: "{}" }, ["list"]), "replay");
  assert.equal(entryMode({}, ["list"]), "cli");
  assert.equal(entryMode({}, []), "launcher");
});

test("entryMode: SNAPPER_CHECK_OPTS → the check process (v1.3), after play and replay", () => {
  assert.equal(entryMode({ SNAPPER_CHECK_OPTS: "{}" }, []), "check");
  assert.equal(entryMode({ SNAPPER_CHECK_OPTS: "{}" }, ["list"]), "check");
  assert.equal(entryMode({ SNAPPER_REPLAY_OPTS: "{}", SNAPPER_CHECK_OPTS: "{}" }, []), "replay");
  assert.equal(entryMode({ SNAPPER_CHECK_OPTS: "" }, []), "launcher");
});

test("entryMode: SNAPPER_ATTACH_OPTS → the attach host (v1.4), after play, replay and check", () => {
  assert.equal(entryMode({ SNAPPER_ATTACH_OPTS: "{}" }, []), "attach");
  assert.equal(entryMode({ SNAPPER_ATTACH_OPTS: "{}" }, ["list"]), "attach");
  assert.equal(entryMode({ SNAPPER_CHECK_OPTS: "{}", SNAPPER_ATTACH_OPTS: "{}" }, []), "check");
  assert.equal(entryMode({ SNAPPER_ATTACH_OPTS: "" }, []), "launcher");
});

test("entryMode: every CLI command is the cli role", () => {
  for (const cmd of ["play", "replay", "summary", "list", "skill", "doctor", "check", "mcp",
    "attach", "pack", "import", "triage", "issue", "export-repro", "serve", "help", "version", "--version", "--help", "-h"]) {
    assert.ok(CLI_COMMANDS.has(cmd), cmd);
    assert.equal(entryMode({}, [cmd]), "cli", cmd);
    assert.equal(entryMode({}, [cmd, "extra", "--flag"]), "cli", cmd);
  }
  assert.equal(CLI_COMMANDS.size, 20);
});

test("entryMode: an unknown first argument or a path → the launcher", () => {
  assert.equal(entryMode({}, ["frobnicate"]), "launcher");
  assert.equal(entryMode({}, ["C:/Coding/moonflexforceabilities-v3"]), "launcher");
  assert.equal(entryMode({}, ["./examples/demo"]), "launcher");
  assert.equal(entryMode({}, [""]), "launcher");
  assert.equal(entryMode({}, ["--inspect"]), "launcher");
  // only the FIRST argument selects the role
  assert.equal(entryMode({}, ["C:/game", "play"]), "launcher");
  // empty env values do not select a role
  assert.equal(entryMode({ SNAPPER_OPTS: "", SNAPPER_REPLAY_OPTS: "" }, []), "launcher");
});

test("userArgs: dev Electron skips the entry script, packaged does not", () => {
  const dev = ["C:\\x\\electron.exe", "C:\\x\\packages\\host\\main\\entry.mjs", "play", "examples/demo", "--smoke", "s.json"];
  assert.deepEqual(userArgs(dev, true), ["play", "examples/demo", "--smoke", "s.json"]);
  const packaged = ["C:\\Program Files\\Snapper\\Snapper.exe", "doctor"];
  assert.deepEqual(userArgs(packaged, false), ["doctor"]);
  assert.deepEqual(userArgs(["C:\\Snapper.exe"], false), []);
  assert.deepEqual(userArgs(["C:\\electron.exe", "entry.mjs"], true), []);
  assert.deepEqual(userArgs(undefined, false), []);
});
