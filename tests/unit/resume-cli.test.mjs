// `snapper play --resume … --at …` (D-021): argument parsing and resolveResume against a temp game root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../packages/host/bin/snapper.mjs";
import { buildOptions, resolveResume } from "../../packages/host/main/cli-play.mjs";
import { makeCheckpoint, writeCheckpoint } from "../../packages/core/index.mjs";
import { loadResume } from "../../packages/host/main/resume.mjs";

const KEYMAP = ["KeyA", "KeyD", "Space"];
const SLUG = "mygame";

/** A game root named `mygame` with an index.html; sessions go under <root>/.snapper/sessions/mygame/. */
async function gameRoot() {
  const root = join(await mkdtemp(join(tmpdir(), "snapper-resume-")), SLUG);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>g</title>");
  return root;
}

const CPS = {
  "0001": { kind: "manual", frame: 300, t: 10000 },
  "0002": { kind: "manual", frame: 350, t: 12000, restorable: false, reason: "game has no stepper" },
  "mark-0001": { kind: "mark", frame: 450, t: 20000, markId: "0001" },
  exit: { kind: "exit", frame: 900, t: 30000 },
};

async function session(root, id, { env = {}, keymap = KEYMAP, checkpoints = Object.keys(CPS), query = "?scene=a" } = {}) {
  const dir = join(root, ".snapper", "sessions", SLUG, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.jsonl"), JSON.stringify({ kind: "session", t: 0, v: 1, id }) + "\n");
  const base = {
    format: 1,
    game: { slug: SLUG, root: root.replace(/\\/g, "/"), query },
    sdk: { present: true, stepper: true, keymap, pauseParam: "paused" },
  };
  await writeFile(join(dir, "env.json"), JSON.stringify({ ...base, ...env, game: { ...base.game, ...(env.game || {}) }, sdk: { ...base.sdk, ...(env.sdk || {}) } }, null, 2));
  await writeFile(join(dir, "tape.jsonl"), [{ kind: "tape", v: 1, keymap, pauseParam: "paused" }, { f: 0, m: 0 }, { f: 100, m: 2 }].map(l => JSON.stringify(l)).join("\n") + "\n");
  for (const name of checkpoints) {
    const c = CPS[name];
    await writeCheckpoint(dir, makeCheckpoint({ name, kind: c.kind, trigger: c.kind, frame: c.frame, t: c.t, markId: c.markId, query,
      restorable: c.restorable !== false, reason: c.reason, state: { frame: c.frame } }));
  }
  return dir;
}

/** parseArgs the way the CLI would, then buildOptions + resolveResume. */
async function resume(root, argv) {
  const { positional, flags } = parseArgs([root, ...argv]);
  return resolveResume(buildOptions({ positional, flags }), flags);
}

test("parseArgs: --resume last --at 0003, bare --resume, --resume=<dir>", () => {
  assert.deepEqual(parseArgs(["game", "--resume", "last", "--at", "0003"]), { positional: ["game"], flags: { resume: "last", at: "0003" } });
  assert.deepEqual(parseArgs(["game", "--resume"]).flags, { resume: true });
  assert.deepEqual(parseArgs(["game", "--resume", "--at", "mark-0003"]).flags, { resume: true, at: "mark-0003" });
  assert.deepEqual(parseArgs(["game", "--resume=C:/s/2026-10-18T14-02-11", "--at=f450"]).flags, { resume: "C:/s/2026-10-18T14-02-11", at: "f450" });
  assert.deepEqual(parseArgs(["game", "--at", "exit"]).flags, { at: "exit" });
});

test("resolveResume: without --resume it changes nothing", async () => {
  const root = await gameRoot();
  const opts = buildOptions({ positional: [root], flags: {} });
  const before = structuredClone(opts);
  const got = await resolveResume(opts, {});
  assert.equal(got, opts);
  assert.equal(got.resume, undefined);
  assert.deepEqual(got, before);
  assert.equal((await resolveResume(buildOptions({ positional: [root], flags: {} }))).resume, undefined, "flags may be omitted");
});

test("resolveResume: `last` takes the newest session that has states; --at defaults to exit", async () => {
  const root = await gameRoot();
  const older = await session(root, "2026-10-17T09-00-00");
  await session(root, "2026-10-18T09-00-00", { checkpoints: [] });
  const o = await resume(root, ["--resume", "last"]);
  assert.equal(o.resume.session, older);
  assert.equal(o.resume.sessionId, "2026-10-17T09-00-00");
  assert.equal(o.resume.checkpoint, "exit");
  assert.equal(o.resume.frame, 900);
  assert.equal(o.resume.compareWith, "exit");
  assert.equal(o.resume.base, "exit");
  assert.equal(o.resume.pauseParam, "paused");
  assert.deepEqual(o.resume.keymap, KEYMAP);

  const bare = await resume(root, ["--resume"]);
  assert.equal(bare.resume.session, older, "bare --resume means last");
});

test("resolveResume: an explicit session dir, a name, a mark and a frame", async () => {
  const root = await gameRoot();
  const dir = await session(root, "2026-10-17T09-00-00");
  await session(root, "2026-10-18T09-00-00");

  const byDir = await resume(root, ["--resume", dir]);
  assert.equal(byDir.resume.sessionId, "2026-10-17T09-00-00", "an explicit dir beats last");

  const named = await resume(root, ["--resume", dir, "--at", "0001"]);
  assert.deepEqual([named.resume.checkpoint, named.resume.frame, named.resume.compareWith], ["0001", 300, "0001"]);

  const bareNum = await resume(root, ["--resume", dir, "--at", "1"]);
  assert.equal(bareNum.resume.checkpoint, "0001");

  const mark = await resume(root, ["--resume", dir, "--at", "mark-0001"]);
  assert.deepEqual([mark.resume.checkpoint, mark.resume.frame, mark.resume.compareWith], ["mark-0001", 450, "mark-0001"]);
  const m1 = await resume(root, ["--resume", dir, "--at", "m1"]);
  assert.equal(m1.resume.checkpoint, "mark-0001");

  const exact = await resume(root, ["--resume", dir, "--at", "f450"]);
  assert.deepEqual([exact.resume.checkpoint, exact.resume.frame, exact.resume.compareWith, exact.resume.base], ["f450", 450, "mark-0001", "exit"]);

  const early = await resume(root, ["--resume", dir, "--at", "f200"]);
  assert.deepEqual([early.resume.checkpoint, early.resume.frame, early.resume.compareWith, early.resume.base], ["f200", 200, null, "exit"], "no state sits on frame 200, so nothing is compared");
});

test("resolveResume: the query defaults to the source's; a matching --query is fine", async () => {
  const root = await gameRoot();
  const dir = await session(root, "2026-10-17T09-00-00", { query: "?scene=stage&level=1-1" });
  const o = await resume(root, ["--resume", dir]);
  assert.equal(o.config.query, "?scene=stage&level=1-1");
  const same = await resume(root, ["--resume", dir, "--query", "?scene=stage&level=1-1"]);
  assert.equal(same.config.query, "?scene=stage&level=1-1");

  const plain = await session(root, "2026-10-16T09-00-00", { query: "" });
  const none = await resume(root, ["--resume", plain]);
  assert.equal(none.config.query, "");
});

test("resolveResume refuses: a different game root", async () => {
  const root = await gameRoot();
  const dir = await session(root, "2026-10-17T09-00-00", { env: { game: { root: "C:/Coding/some-other-game" } } });
  await assert.rejects(resume(root, ["--resume", dir]), /played from game root C:\/Coding\/some-other-game, not .*mygame; resume it with that game/);
});

test("resolveResume: --query with --resume is the segment query override (D-022), warned, not refused", async () => {
  const root = await gameRoot();
  const dir = await session(root, "2026-10-17T09-00-00", { query: "?scene=a" });
  const warned = [];
  const orig = process.stderr.write;
  process.stderr.write = chunk => { warned.push(String(chunk)); return true; };
  let o;
  try { o = await resume(root, ["--resume", dir, "--query", "?scene=b"]); } finally { process.stderr.write = orig; }
  assert.equal(o.config.query, "?scene=b");
  assert.equal(o.resume.queryOverride, "?scene=b");
  assert.equal(o.resume.envQuery, "?scene=a");
  assert.match(warned.join(""), /warning: --query "\?scene=b" overrides the segment query/);
  const plain = await resume(root, ["--resume", dir]);
  assert.equal(plain.resume.queryOverride, null, "no --query: no override");
  assert.equal(plain.resume.envQuery, "?scene=a");
});

test("loadResume (D-022): a checkpoint in a segment after a navigation restores with that segment's query; the override wins", async () => {
  const root = await gameRoot();
  const dir = await session(root, "2026-10-17T09-00-00", { query: "?scene=a", checkpoints: [] });
  await writeFile(join(dir, "tape.jsonl"), [
    { kind: "tape", v: 1, keymap: KEYMAP, pauseParam: "paused" },
    { f: 0, m: 0 }, { f: 100, m: 2 },
    { f: 0, ev: "reload", t: 20000, query: "?scene=stage&level=2-1", url: "http://x/index.html?scene=stage&level=2-1" },
    { f: 0, m: 0 }, { f: 50, m: 1 },
    { f: 0, ev: "reload", t: 40000 },
    { f: 0, m: 0 },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const cp = (name, frame, t, segment) => writeCheckpoint(dir, makeCheckpoint({ name, kind: "manual", trigger: "manual", frame, t, query: "?scene=a", segment, restorable: true, state: {} }));
  await cp("0001", 80, 10000, { index: 0, reloadT: null });
  await cp("0002", 60, 30000, { index: 1, reloadT: 20000 });
  await cp("0003", 10, 50000, { index: 2, reloadT: 40000 });
  const R = (name, extra = {}) => ({ session: dir, sessionId: "x", base: name, checkpoint: name, frame: 1, compareWith: name, envQuery: "?scene=a", queryOverride: null, ...extra });
  const q = async (name, extra) => { const r = await loadResume(R(name, extra)); return [r.query, r.querySource, r.queryOverride]; };
  assert.deepEqual(await q("0001"), ["?scene=a", "env", false], "segment 0: the session's own query");
  assert.deepEqual(await q("0002"), ["?scene=stage&level=2-1", "marker", false], "segment 1: its reload marker's query");
  assert.deepEqual(await q("0003"), ["?scene=stage&level=2-1", "marker", false], "a marker without a query inherits the previous segment's");
  assert.deepEqual(await q("0002", { queryOverride: "?scene=stage&level=3-1" }), ["?scene=stage&level=3-1", "override", true]);
});


test("resolveResume refuses: no stepper, no keymap", async () => {
  const root = await gameRoot();
  const noStepper = await session(root, "2026-10-17T09-00-00", { env: { sdk: { stepper: false } } });
  await assert.rejects(resume(root, ["--resume", noStepper]), /registered no stepper; its states are not restorable/);
  const noKeymap = await session(root, "2026-10-16T09-00-00", { keymap: [], env: { sdk: { keymap: [] } } });
  await assert.rejects(resume(root, ["--resume", noKeymap]), /registered no stepper/);
});

test("resolveResume refuses: a state that is not restorable, with its reason", async () => {
  const root = await gameRoot();
  const dir = await session(root, "2026-10-17T09-00-00");
  await assert.rejects(resume(root, ["--resume", dir, "--at", "0002"]), /state 0002 is not restorable \(game has no stepper\)/);
});

test("resolveResume refuses: a missing --at target, with the states listed", async () => {
  const root = await gameRoot();
  const dir = await session(root, "2026-10-17T09-00-00");
  await assert.rejects(resume(root, ["--resume", dir, "--at", "mark-9"]), /no checkpoint for mark 0009 \(states: 0001 \(frame 300\)/);
  await assert.rejects(resume(root, ["--resume", dir, "--at", "f5000"]), /no restorable state at or after frame 5000/);
  await assert.rejects(resume(root, ["--resume", dir, "--at", "banana"]), /cannot resolve --at "banana"/);
  await assert.rejects(resume(root, ["--resume", dir, "--at"]), /--at needs a value/);

  const noExit = await session(root, "2026-10-16T09-00-00", { checkpoints: ["0001", "mark-0001"] });
  await assert.rejects(resume(root, ["--resume", noExit]), /the session has no exit checkpoint \(states: 0001 \(frame 300\), mark-0001 \(frame 450\)\)/);
});

test("resolveResume refuses: nothing to resume, a missing folder", async () => {
  const root = await gameRoot();
  await assert.rejects(resume(root, ["--resume", "last"]), /--resume: no session with saved states under /);
  await session(root, "2026-10-17T09-00-00", { checkpoints: [] });
  await assert.rejects(resume(root, ["--resume"]), /no session with saved states/);
  await assert.rejects(resume(root, ["--resume", join(root, "nope")]), /not a session folder \(no env\.json\)/);
});
