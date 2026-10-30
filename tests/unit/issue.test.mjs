// v1.4 core issue.mjs: the Markdown for a mark (title rule, env line, state keys, errors, inputs decode, commands, paths).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIssue, issueMarkdown, readSession } from "../../packages/core/index.mjs";
import { envLine, inputsLines, issueTitle } from "../../packages/core/src/issue.mjs";
import { makeSession } from "../fixtures/team.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "snapper-issue-"));

async function withInputs(dir) {
  const m1 = join(dir, "marks", "0001");
  await writeFile(join(m1, "inputs.json"), JSON.stringify({
    wall: [{ t: 1, k: "KeyD", d: 1 }, { t: 2, k: "Space", d: 1 }, { t: 3, k: "Space", d: 0 }, { t: 4, k: "KeyD", d: 1 }],
    frames: [{ f: 0, m: 0 }, { f: 100, m: 2 }, { f: 2500, m: 6 }, { f: 2540, m: 0 }],
  }));
  await writeFile(join(m1, "log.json"), JSON.stringify([
    { t: 1, source: "console", level: "log", text: "fine" },
    ...Array.from({ length: 7 }, (_, i) => ({ t: 2 + i, source: "console", level: "error", text: `boom ${i}\nsecond line` })),
  ]));
}

test("buildIssue: title rule, sections, state keys, env line, errors (first 5), inputs decoded with the tape keymap, commands, paths", async () => {
  const dir = await makeSession(await tmp(), { tester: "Ann" });
  await withInputs(dir);
  const r = await buildIssue(dir, "1");
  assert.equal(r.title, "pigeon clips through the ledge — demo-game 2026-10-18T14-02-11 mark 0001");
  assert.equal(r.markdown, `# ${r.title}\n\n${r.body}`);
  assert.equal(r.markDir, join(dir, "marks", "0001"));
  const b = r.body;
  assert.match(b, /- note: pigeon clips through the ledge/);
  assert.match(b, /- trigger: hotkey · t 0:42\.3 · frame 2538/);
  assert.match(b, /scene=stage level=2-2 .*hearts=3/);
  assert.match(b, /top-level keys: scene, level, player, vel, pose, hearts, perf, entities/);
  assert.match(b, /Snapper 1\.0\.0 · Windows 11 10\.0\.26100 · GPU NVIDIA GeForce RTX 4060 \(ANGLE D3D11\) · display 3440×1440 @ 180 Hz dpr 1 · Chromium 146\.0\.7600\.10 · git 024e9ae \(dirty\) · tester Ann/);
  assert.ok(b.includes("- boom 0 second line") && b.includes("- boom 4 second line") && !b.includes("boom 5"), "first five errors only, one line each");
  assert.ok(!b.includes("- fine"), "only error-level entries");
  assert.match(b, /keys pressed in the last seconds: KeyD, Space/);
  assert.match(b, /f0: \(none\) · f100: KeyD · f2500: KeyD\+Space · f2540: \(none\)/);
  assert.ok(b.includes(`snapper replay "${dir}" 0001`));
  assert.ok(b.includes(`--session "${dir}" --marks 0001`));
  for (const [label, rel] of [["shot", "shot.png"], ["frame", "frame.png"], ["before", "before\\sheet.png"], ["state", "state.json"]]) {
    assert.ok(b.includes(`- ${label}: ${join(dir, "marks", "0001", ...rel.split("\\"))}`), label);
  }
  const t = await buildIssue(dir, "0001", { title: "Custom title" });
  assert.equal(t.title, "Custom title");
  assert.ok(t.markdown.startsWith("# Custom title\n\n"));
});

test("buildIssue: an exception mark names the exception; missing marks and sessions refuse", async () => {
  const dir = await makeSession(await tmp());
  const r = await buildIssue(dir, "2");
  assert.match(r.title, /^exception — demo-game .* mark 0002$/);
  assert.match(r.body, /- boom|- TypeError: cannot read 'x' of undefined/, "the exception comes from session.jsonl when log.json has none");
  assert.match(r.body, /no input recorded/);
  await assert.rejects(buildIssue(dir, "9"), /mark 0009 does not exist/);
  await assert.rejects(buildIssue(join(dir, "nope"), "1"), /not a session folder/);
});

test("issueMarkdown is pure: no git sha, no keymap, not replayable, game root from data", async () => {
  const dir = await makeSession(await tmp(), { env: { tester: undefined } });
  const s = await readSession(dir);
  s.env.game.git = null;
  const noStepper = { ...s, ready: { ...s.ready, stepper: false } };
  const r = issueMarkdown(noStepper, noStepper.marks[0], { data: { inputs: { frames: [{ f: 5, m: 3 }] }, keymap: [], gameRoot: "D:/g" } });
  assert.match(r.body, /no git sha/);
  assert.match(r.body, /f5: mask 3/);
  assert.match(r.body, /not replayable \(no stepper\)/);
  const ok = issueMarkdown(s, s.marks[0], { data: { gameRoot: "D:/g" } });
  assert.ok(ok.body.includes('snapper check "D:/g" --session'));
  const rb = { ...s.marks[0], replayable: false, replayableReason: "attached without a reload" };
  assert.match(issueMarkdown(s, rb).body, /not replayable \(attached without a reload\)/);
});

test("envLine, inputsLines and issueTitle helpers", () => {
  assert.equal(envLine({}), "Snapper ? · GPU unknown · no git sha");
  assert.deepEqual(inputsLines({}, []), ["no input recorded in the last seconds"]);
  const long = "x".repeat(200);
  assert.ok(issueTitle({ id: "i", env: { game: { slug: "s" } } }, { id: "0003", note: long }).length < 140);
  assert.equal(issueTitle({ id: "i", env: { game: { slug: "s" } } }, { id: "0003", trigger: "fps" }), "fps — s i mark 0003");
});
