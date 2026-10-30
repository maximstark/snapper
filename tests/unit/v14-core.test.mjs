// v1.4 core contracts (the lead): diffs (Part 0.3), triage.json (Part 3.2), detectIntegration (Part 0.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffPaths, compareStateAll, firstDiff, compareState,
  nextTriage, triageProblem, writeTriage, readTriage, triageSummary, triageLine, TRIAGE_STATUSES,
  detectIntegration, snapperCalls, moduleScripts, integrationLine, readSession, renderSessionMd,
} from "../../packages/core/index.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "snapper-v14-"));

test("diffPaths: up to three paths, depth-first in key order; [0] is firstDiff; perf ignored by compareStateAll", () => {
  const a = { rng: 1, player: { x: 1, y: 2 }, score: 10, coins: [1, 2, 3], perf: { fps: 60 } };
  const b = { rng: 2, player: { x: 1, y: 3 }, score: 11, coins: [1, 2, 4], perf: { fps: 30 } };
  assert.deepEqual(diffPaths(a, b, ["perf"]), ["$.rng", "$.player.y", "$.score"]);
  assert.deepEqual(diffPaths(a, b, ["perf"], 10), ["$.rng", "$.player.y", "$.score", "$.coins[2]"]);
  assert.equal(diffPaths(a, b, ["perf"])[0], firstDiff(a, b, ["perf"]).path);
  assert.deepEqual(compareStateAll(a, b), ["$.rng", "$.player.y", "$.score"]);
  assert.equal(compareState(a, b).path, "$.rng");
  assert.deepEqual(compareStateAll(a, { ...a, perf: 0 }), []);
  assert.deepEqual(diffPaths({ a: 1 }, { b: 1 }), ["$.a", "$.b"]);
  assert.deepEqual(diffPaths(NaN, NaN), []);
  assert.deepEqual(diffPaths([1], { 0: 1 }), ["$"]);
});

test("triage: statuses, validation, merge rules", () => {
  assert.deepEqual([...TRIAGE_STATUSES], ["open", "fixed", "wontfix", "duplicate", "cannot-reproduce"]);
  const at = "2026-10-22T10:00:00.000Z";
  const a = nextTriage(null, { status: "open", by: "maxim", at, note: "seen it" });
  assert.deepEqual(a, { status: "open", by: "maxim", at, note: "seen it" });
  const b = nextTriage({ ...a, issue: "https://github.com/x/y/issues/1" }, { status: "fixed", by: "claude", commit: "abc1234", at });
  assert.deepEqual(b, { status: "fixed", by: "claude", at, issue: "https://github.com/x/y/issues/1", commit: "abc1234" }, "issue carries over, note does not (status changed)");
  const c = nextTriage(b, { by: "claude", at });
  assert.equal(c.status, "fixed");
  assert.equal(c.commit, "abc1234", "same status keeps the commit");
  assert.throws(() => nextTriage(null, { status: "done", by: "x" }), /status must be one of/);
  assert.throws(() => nextTriage(null, { status: "duplicate", by: "x" }), /needs --of/);
  assert.throws(() => nextTriage(null, { status: "fixed", of: "0002", by: "x" }), /only goes with status duplicate/);
  assert.throws(() => nextTriage(null, { status: "fixed", by: "" }), /by must be a name/);
  assert.throws(() => nextTriage(null, { status: "fixed", by: "x", commit: "zzz" }), /git sha/);
  assert.throws(() => nextTriage(null, { status: "fixed", by: "x", issue: "javascript:alert(1)" }), /http\(s\) URL/);
  assert.equal(triageProblem({ status: "duplicate", of: "0002", by: "x", at }), null);
  assert.equal(triageLine(b), 'fixed by claude 2026-10-22 · commit abc1234 · issue https://github.com/x/y/issues/1');
  assert.equal(triageSummary([{ info: { triage: b } }, { info: { triage: null } }, { info: { triage: a } }]), "1 open · 1 fixed · 1 untriaged");
  assert.equal(triageSummary([{ info: { triage: null } }]), null);
});

function fakeSession(dir) {
  mkdirSync(join(dir, "marks", "0001"), { recursive: true });
  mkdirSync(join(dir, "marks", "0002"), { recursive: true });
  const lines = [
    { kind: "session", t: 0, v: 1, id: "2026-10-22T10-00-00", game: "demo", url: "http://127.0.0.1:1/index.html", query: "", snapper: "1.4.0" },
    { kind: "boot", t: 10, ok: true, ms: 10 },
    { kind: "ready", t: 20, sdk: true, state: true, frame: true, stepper: true, commands: [] },
    { kind: "mark", t: 1000, id: "0001", frame: 60, trigger: "hotkey", dir: "marks/0001", summary: "a", errors: 0, worstMs: 5 },
    { kind: "mark", t: 2000, id: "0002", frame: 120, trigger: "smoke", dir: "marks/0002", summary: "b", errors: 0, worstMs: 5 },
  ];
  writeFileSync(join(dir, "session.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(dir, "env.json"), JSON.stringify({ format: 1, game: { slug: "demo", url: "http://127.0.0.1:1/index.html", query: "" }, host: {}, tester: { name: "Ana" } }));
  writeFileSync(join(dir, "marks", "0001", "state.json"), "{}");
}

test("writeTriage: writes marks/NNNN/triage.json atomically, refuses bad marks; SESSION.md shows the counts and the line; session.jsonl untouched", async () => {
  const d = tmp();
  try {
    fakeSession(d);
    const before = readFileSync(join(d, "session.jsonl"), "utf8");
    await assert.rejects(writeTriage(d, "0009", { status: "fixed", by: "x" }), /mark 0009 does not exist/);
    await assert.rejects(writeTriage(d, "abc", { status: "fixed", by: "x" }), /not a mark id/);
    await assert.rejects(writeTriage(d, "1", { status: "duplicate", of: "0001", by: "x" }), /cannot duplicate itself/);
    const r = await writeTriage(d, "1", { status: "fixed", by: "claude", commit: "deadbeef", note: "off by one" });
    assert.equal(r.path, join(d, "marks", "0001", "triage.json"));
    assert.equal((await readTriage(d, "0001")).status, "fixed");
    await writeTriage(d, "2", { status: "duplicate", of: "1", by: "maxim" });
    assert.equal((await readTriage(d, "0002")).of, "0001");
    assert.equal(readFileSync(join(d, "session.jsonl"), "utf8"), before);
    const md = renderSessionMd(await readSession(d));
    assert.match(md, /^Triage: 1 fixed · 1 duplicate$/m);
    assert.match(md, /^Triage: fixed by claude \d{4}-\d\d-\d\d · commit deadbeef · "off by one"$/m);
    assert.match(md, /^Triage: duplicate of 0001 by maxim/m);
    assert.match(md.split("\n")[1], /tester: Ana/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("detectIntegration: Moonflex-shaped, demo-shaped and un-integrated fixtures", () => {
  const d = tmp();
  try {
    // Moonflex-shaped: src/dev/snapper.js registers; src/main.js imports it and runs the loop
    const mf = join(d, "mf");
    mkdirSync(join(mf, "src", "dev"), { recursive: true });
    mkdirSync(join(mf, "node_modules", "lib"), { recursive: true });
    writeFileSync(join(mf, "index.html"), '<!doctype html><script type="module" src="src/main.js"></script>');
    writeFileSync(join(mf, "src", "dev", "snapper.js"), [
      "export function attachSnapper(o) {", "  const sn = globalThis.snapper;", "  if (!sn) return () => {};",
      "  sn.registerState(() => ({}));", "  sn.registerFrame(() => null);", "  sn.registerStepper({ keymap: [] });", "  return sn.tick;", "}",
    ].join("\n"));
    writeFileSync(join(mf, "src", "main.js"), 'import { attachSnapper } from "./dev/snapper.js";\nconst tick = attachSnapper({});\nfunction f(){ requestAnimationFrame(f); tick(1, 0); }\n');
    writeFileSync(join(mf, "node_modules", "lib", "x.js"), "snapper.registerState(() => 1)");      // skipped folder
    const a = detectIntegration(mf);
    assert.deepEqual(a.found, [{ file: "src/dev/snapper.js", calls: ["registerState", "registerFrame", "registerStepper", "tick"] }]);
    assert.equal(integrationLine(a), "integration: this game already talks to Snapper: src/dev/snapper.js (registerState, registerFrame, registerStepper, tick)");
    // demo-shaped: one game.js with guarded calls
    const demo = join(d, "demo");
    mkdirSync(demo);
    writeFileSync(join(demo, "index.html"), '<script src="game.js"></script>');
    writeFileSync(join(demo, "game.js"), "const sn = window.snapper;\nconst tick = window.snapper?.tick ?? (() => {});\nif (sn) { sn.registerState(() => ({})); sn.registerStepper({}); }\nrequestAnimationFrame(loop);\n");
    assert.deepEqual(detectIntegration(demo).found, [{ file: "game.js", calls: ["registerState", "registerStepper", "tick"] }]);
    // nothing: a loop with no Snapper; the SDK's own copy is not an integration; a game's own loop.tick() is not one
    const none = join(d, "none");
    mkdirSync(join(none, "js"), { recursive: true });
    writeFileSync(join(none, "index.html"), '<script type="module" src="./js/boot.js?v=2"></script><script type="module" src="https://cdn.x/lib.js"></script>');
    writeFileSync(join(none, "js", "boot.js"), "import './loop.js';\n");
    writeFileSync(join(none, "js", "loop.js"), "function f(){ loop.tick(); requestAnimationFrame(f) }\n");
    writeFileSync(join(none, "js", "snapper.js"), "/* Snapper SDK v1.0.0 (MIT). */ function registerState(fn){} G.snapper = snapper;");
    const c = detectIntegration(none);
    assert.deepEqual(c.found, []);
    assert.deepEqual(c.candidates, ["js/boot.js", "js/loop.js"]);
    assert.match(integrationLine(c), /no Snapper calls found in 4 files; paste the SDK recipe into the file that starts your game loop; guesses: js\/boot.js, js\/loop.js/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("snapperCalls / moduleScripts edge cases", () => {
  assert.deepEqual(snapperCalls("loop.tick(); clock.tick"), []);
  assert.deepEqual(snapperCalls("globalThis.snapper?.tick(f, m)"), ["tick"]);
  assert.deepEqual(snapperCalls("window.snapper.registerCommands({})"), ["registerCommands"]);
  assert.deepEqual(moduleScripts('<script type=module src="a.js"></script><script src="b.js"></script><script type="module">inline</script>'), ["a.js"]);
});
