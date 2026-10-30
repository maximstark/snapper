// replay/cli.mjs replayChildOptions: the pure parse/validate step that feeds the Electron replay child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { replayChildOptions } from "../../packages/host/replay/cli.mjs";
import { Refusal } from "../../packages/host/replay/runner.mjs";

test("replayChildOptions: defaults", () => {
  const o = replayChildOptions({ positional: ["some/session", "0001"], flags: {} });
  assert.equal(o.sessionDir, resolve("some/session"));
  assert.ok(isAbsolute(o.sessionDir));
  assert.equal(o.markId, "0001");
  assert.equal(o.before, 30);
  assert.equal(o.after, 30);
  assert.equal(o.every, 1);
  assert.equal(o.out, null);
  assert.equal(o.query, undefined);
  assert.equal(o.headed, false);
});

test("replayChildOptions: all flags round-trip through JSON with out made absolute", () => {
  const o = replayChildOptions({
    positional: ["s", 7],
    flags: { before: "5", after: "7", every: "2", out: "rel/dir", query: "?a=b", headed: true },
  });
  assert.deepEqual(o, { sessionDir: resolve("s"), markId: "7", before: 5, after: 7, every: 2, out: resolve("rel/dir"), query: "?a=b", headed: true });
  assert.ok(isAbsolute(o.out));
  assert.deepEqual(JSON.parse(JSON.stringify(o)), o);
});

test("replayChildOptions: invalid input throws a Refusal that says what is wrong", () => {
  const bad = (args, re) => assert.throws(() => replayChildOptions(args), e => e instanceof Refusal && re.test(e.message), JSON.stringify(args));
  bad({ positional: [], flags: {} }, /^usage: snapper replay/);
  bad({ positional: ["dir"], flags: {} }, /^usage: snapper replay/);
  bad({ positional: ["dir", "1"], flags: { every: "0" } }, /--every must be an integer >= 1 \(got "0"\)/);
  bad({ positional: ["dir", "1"], flags: { before: "-1" } }, /--before must be an integer >= 0 \(got "-1"\)/);
  bad({ positional: ["dir", "1"], flags: { before: "x" } }, /--before must be an integer >= 0 \(got "x"\)/);
  bad({ positional: ["dir", "1"], flags: { after: "1.5" } }, /--after must be an integer/);
  bad({ positional: ["dir", "1"], flags: { query: true } }, /--query needs a value/);
});
