import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../packages/host/bin/snapper.mjs";

test("cli: parseArgs", () => {
  assert.deepEqual(parseArgs(["C:/game", "--preset", "ultrawide", "--fullscreen", "--query=?scene=stage&level=1-1", "--game-root", "x"]), {
    positional: ["C:/game"], flags: { preset: "ultrawide", fullscreen: true, query: "?scene=stage&level=1-1", gameRoot: "x" },
  });
  assert.deepEqual(parseArgs(["s", "0001", "--before", "10", "--every", "2"]), { positional: ["s", "0001"], flags: { before: "10", every: "2" } });
  assert.deepEqual(parseArgs(["--smoke"]), { positional: [], flags: { smoke: true } });
  // v1.3 boolean flags never eat the next argument
  assert.deepEqual(parseArgs(["--bare", "examples/demo", "--coi", "--accept", "x"]), { positional: ["examples/demo", "x"], flags: { bare: true, coi: true, accept: true } });
});
