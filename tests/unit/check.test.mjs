// v1.3 Part 3: snapper check — argument validation, session and mark selection, the expectation choice, the table,
// the summary and its exit codes (the replays themselves are tests/e2e/check-demo.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSessionWriter } from "../../packages/core/index.mjs";
import {
  checkArgs, planCheck, expectationFor, formatTable, summarize, summaryLine, resultText, finishCheck,
} from "../../packages/host/tools/check.mjs";
import { Refusal } from "../../packages/host/replay/runner.mjs";

test("checkArgs: defaults, flags, validation", () => {
  const r = checkArgs({ positional: ["game"], flags: {} });
  assert.deepEqual(r, { root: resolve("game"), sessions: null, session: null, marks: null, accept: false, query: undefined, out: null, json: false });
  const f = checkArgs({ positional: ["game"], flags: { sessions: "3", marks: "1,0003, 0003", accept: true, query: "?a=b", out: "o", json: true } });
  assert.equal(f.sessions, 3);
  assert.deepEqual(f.marks, ["0001", "0003"]);
  assert.equal(f.accept, true);
  assert.equal(f.query, "?a=b");
  assert.equal(f.out, resolve("o"));
  assert.equal(f.json, true);
  assert.equal(checkArgs({ positional: ["g"], flags: { session: "s/1" } }).session, resolve("s/1"));
  const bad = (positional, flags, re) => assert.throws(() => checkArgs({ positional, flags }), e => e instanceof Refusal && re.test(e.message));
  bad([], {}, /usage: snapper check/);
  bad(["g"], { sessions: "0" }, /--sessions must be an integer >= 1/);
  bad(["g"], { sessions: "x" }, /--sessions must be/);
  bad(["g"], { sessions: true }, /--sessions must be/);
  bad(["g"], { sessions: "2", session: "d" }, /exclusive/);
  bad(["g"], { session: true }, /--session needs/);
  bad(["g"], { marks: true }, /--marks needs/);
  bad(["g"], { marks: "1,abc" }, /"abc" is not a mark id/);
  bad(["g"], { marks: "12345" }, /is not a mark id/);
  bad(["g"], { query: true }, /--query needs a value/);
  bad(["g"], { out: true }, /--out needs/);
});

test("expectationFor: expected.json wins, else state.json, else null", () => {
  assert.deepEqual(expectationFor({ expected: { state: { a: 2 } }, state: { a: 1 } }), { source: "expected", state: { a: 2 } });
  assert.deepEqual(expectationFor({ expected: null, state: { a: 1 } }), { source: "state", state: { a: 1 } });
  assert.deepEqual(expectationFor({ expected: { acceptedAt: "x" }, state: { a: 1 } }), { source: "state", state: { a: 1 } });
  assert.deepEqual(expectationFor({ expected: { state: null }, state: { a: 1 } }), { source: "expected", state: null });
  assert.deepEqual(expectationFor({ state: { unavailable: true } }), { source: "state", state: { unavailable: true } });
  assert.equal(expectationFor({}), null);
  assert.equal(expectationFor({ expected: null, state: null }), null);
});

const row = (result, extra = {}) => ({ session: "2026-10-21T10-00-00", sessionDir: "/s", mark: "0001", frame: 5, trigger: "hotkey", note: "", expectation: "state", result, ...extra });

test("summarize: counts and exit codes", () => {
  assert.deepEqual(summarize([], 12.4), { total: 0, match: 0, differs: 0, skipped: 0, error: 0, accepted: 0, ms: 12, exit: 0 });
  const ok = summarize([row("match"), row("skipped", { reason: "x" })], 1000);
  assert.deepEqual([ok.total, ok.match, ok.skipped, ok.exit], [2, 1, 1, 0]);
  assert.equal(summarize([row("match"), row("differs", { firstDiff: "$.a" })]).exit, 1);
  assert.equal(summarize([row("match"), row("error", { message: "boom" })]).exit, 1);
  const acc = summarize([row("differs", { firstDiff: "$.a", accepted: true }), row("match", { accepted: true })]);
  assert.equal(acc.exit, 0, "accepted differences pass");
  assert.equal(acc.accepted, 2);
  assert.equal(acc.differs, 1);
  assert.equal(summarize([row("error", { message: "m", accepted: true })]).exit, 1);
  assert.equal(summaryLine({ match: 3, differs: 1, skipped: 2, error: 0, ms: 4321 }), "match 3 · differs 1 · skipped 2 · error 0 · 4.3 s");
});

test("formatTable: columns session, mark, trigger, note, status (v1.4), result; differs names up to three paths", () => {
  assert.equal(resultText(row("match")), "match");
  assert.equal(resultText(row("differs", { firstDiff: "$.player.x" })), "differs $.player.x");
  assert.equal(resultText(row("differs", { firstDiff: "$.rng", diffs: ["$.rng", "$.player.y", "$.score"] })), "differs $.rng, $.player.y, $.score");
  assert.equal(resultText(row("skipped", { reason: "no state.json" })), "skipped (no state.json)");
  assert.equal(resultText(row("error", { message: "boom\nsecond line" })), "error (boom second line)");
  const t = formatTable([
    row("match", { note: "ok" }),
    row("differs", { mark: "0002", trigger: "api", firstDiff: "$.player.x", note: "x".repeat(80) }),
    row("skipped", { mark: "0003", reason: "no stepper", status: "fixed" }),
  ]).split("\n");
  assert.equal(t.length, 2 + 3);
  assert.match(t[0], /^session\s+mark\s+trigger\s+note\s+status\s+result$/);
  assert.match(t[2], /^2026-10-21T10-00-00\s+0001\s+hotkey\s+ok\s+-\s+match$/);
  assert.match(t[3], /0002\s+api\s+x{39}…\s+-\s+differs \$\.player\.x$/);
  assert.match(t[4], /fixed\s+skipped \(no stepper\)$/);
  // columns line up: the result column starts at the same offset on every row
  const off = t[0].indexOf("result");
  assert.ok(t.slice(2).every(l => l.length > off && l[off - 1] === " "));
});

// ---------------------------------------------------------------- selection on fixture sessions
async function game() {
  const dir = await mkdtemp(join(tmpdir(), "snapper-check-unit-"));
  const root = join(dir, "game");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "snapper.config.json"), JSON.stringify({ slug: "demo" }));
  return { dir, root, out: join(dir, "sessions") };
}

/** A session with marks [{ frame, state?, expected?, note?, trigger? }]. */
async function mkSession(out, startedAt, marks, { stepper = true, tape = true, url = "http://127.0.0.1:1/index.html" } = {}) {
  const w = await createSessionWriter({ out, slug: "demo", startedAt });
  w.line("session", { v: 1, id: w.id, game: "demo", url, query: "", snapper: "1.3.0", startedAt: w.startedAtIso });
  await w.writeEnv({ format: 1, game: { slug: "demo", url, query: "" }, sdk: { present: true, stepper, keymap: ["KeyD"], pauseParam: "paused" }, window: { w: 640, h: 360 } });
  w.line("boot", { ok: true, ms: 1 });
  w.line("ready", { sdk: true, state: true, frame: true, stepper, commands: [] });
  w.tape({ kind: "tape", v: 1, keymap: ["KeyD"], pauseParam: "paused" });
  if (tape) w.tapeMany([{ f: 0, m: 0 }, { f: 10, m: 1 }]);
  for (const [i, m] of marks.entries()) {
    const id = String(i + 1).padStart(4, "0");
    await w.makeMarkDir(id);
    if (m.state !== undefined) await w.writeMarkFile(id, "state.json", m.state);
    if (m.expected !== undefined) await w.writeMarkFile(id, "expected.json", m.expected);
    w.line("mark", { id, frame: m.frame, trigger: m.trigger || "hotkey", dir: `marks/${id}`, summary: "s", errors: 0, worstMs: 1 }, 100 * (i + 1));
    if (m.note) w.line("note", { mark: id, text: m.note });
  }
  w.line("end", { marks: marks.length, errors: 0, durationMs: 1000 });
  await w.flush();
  return w;
}

test("planCheck: refusals (bad root, no sessions, bad --session, --marks naming nothing)", async () => {
  const g = await game();
  try {
    const req = o => checkArgs({ positional: [g.root], flags: { out: g.out, ...o } });
    await assert.rejects(planCheck(checkArgs({ positional: [join(g.dir, "nope")], flags: {} })), e => e instanceof Refusal && /game root not found/.test(e.message));
    await assert.rejects(planCheck(req({})), e => e instanceof Refusal && /no sessions of "demo"/.test(e.message));
    await assert.rejects(planCheck(req({ session: g.dir })), e => e instanceof Refusal && /not a session folder/.test(e.message));
    const s = await mkSession(g.out, new Date(2026, 9, 21, 10, 0, 0), [{ frame: 20, state: { a: 1 } }]);
    await assert.rejects(planCheck(req({ session: s.dir, marks: "0009" })), e => e instanceof Refusal && /none of the marks 0009/.test(e.message));
  } finally { await rm(g.dir, { recursive: true, force: true }); }
});

test("planCheck: newest N sessions of the slug under --out, --session, check.json folder", async () => {
  const g = await game();
  try {
    const a = await mkSession(g.out, new Date(2026, 9, 19, 10, 0, 0), [{ frame: 20, state: { a: 1 } }]);
    const b = await mkSession(g.out, new Date(2026, 9, 20, 10, 0, 0), [{ frame: 20, state: { a: 1 } }]);
    const c = await mkSession(g.out, new Date(2026, 9, 21, 10, 0, 0), [{ frame: 20, state: { a: 1 } }]);
    const req = flags => checkArgs({ positional: [g.root], flags: { out: g.out, ...flags } });
    let p = await planCheck(req({}));
    assert.deepEqual(p.sessions.map(s => s.id), [c.id, b.id, a.id], "all, newest first");
    p = await planCheck(req({ sessions: "2" }));
    assert.deepEqual(p.sessions.map(s => s.id), [c.id, b.id]);
    assert.equal(p.checkDir, join(g.out, "checks"));
    p = await planCheck(req({ session: a.dir }));
    assert.deepEqual(p.sessions.map(s => s.dir), [a.dir]);
    assert.equal(p.slug, "demo");
    // without --out: the config's folder (<root>/.snapper/sessions) and <root>/.snapper/checks
    const w = await createSessionWriter({ out: join(g.root, ".snapper", "sessions"), slug: "demo", startedAt: new Date(2026, 9, 18, 9, 0, 0) });
    w.line("session", { v: 1, id: w.id, game: "demo" });
    await w.flush();
    p = await planCheck(checkArgs({ positional: [g.root], flags: {} }));
    assert.deepEqual(p.sessions.map(s => s.id), [w.id]);
    assert.equal(p.checkDir, join(g.root, ".snapper", "checks"));
  } finally { await rm(g.dir, { recursive: true, force: true }); }
});

test("planCheck: mark selection, expectation source, skipped reasons", async () => {
  const g = await game();
  try {
    const s = await mkSession(g.out, new Date(2026, 9, 21, 10, 0, 0), [
      { frame: 20, state: { a: 1 }, note: "a note that is rather long ".repeat(5), trigger: "api" },     // 0001 state
      { frame: 30, state: { a: 1 }, expected: { state: { a: 2 } } },                                      // 0002 expected wins
      { frame: 40 },                                                                                      // 0003 nothing to compare
      { frame: -1, state: { a: 1 } },                                                                     // 0004 no game frame
      { frame: 50, state: { unavailable: true } },                                                        // 0005 replayable
    ]);
    const req = flags => checkArgs({ positional: [g.root], flags: { out: g.out, session: s.dir, ...flags } });
    const p = await planCheck(req({}));
    const sp = p.sessions[0];
    assert.deepEqual(sp.items.map(i => [i.markId, i.expectation.source, i.frame]), [["0001", "state", 20], ["0002", "expected", 30], ["0005", "state", 50]]);
    assert.deepEqual(sp.items[1].expectation.state, { a: 2 });
    assert.equal(sp.items[0].row.trigger, "api");
    assert.ok(sp.items[0].row.note.length <= 60 && sp.items[0].row.note.endsWith("…"));
    assert.deepEqual(p.rows.map(r => [r.mark, r.result, r.reason]), [
      ["0003", "skipped", "no state.json"],
      ["0004", "skipped", "no game frame at this mark (frame -1)"],
    ]);
    assert.equal(sp.items[0].frames.length, 2);

    const sel = await planCheck(req({ marks: "3,0005" }));
    assert.deepEqual(sel.sessions[0].items.map(i => i.markId), ["0005"]);
    assert.deepEqual(sel.rows.map(r => r.mark), ["0003"]);
  } finally { await rm(g.dir, { recursive: true, force: true }); }
});

test("planCheck: no stepper and no frame lines skip, never error; finishCheck writes check.json", async () => {
  const g = await game();
  try {
    const ns = await mkSession(g.out, new Date(2026, 9, 20, 10, 0, 0), [{ frame: 20, state: { a: 1 } }], { stepper: false });
    const nt = await mkSession(g.out, new Date(2026, 9, 21, 10, 0, 0), [{ frame: 20, state: { a: 1 } }], { tape: false });
    const req = checkArgs({ positional: [g.root], flags: { out: g.out } });
    const p = await planCheck(req);
    assert.ok(p.sessions.every(s => s.items.length === 0));
    const why = Object.fromEntries(p.rows.map(r => [r.session, r.reason]));
    assert.match(why[ns.id], /^no stepper/);
    assert.match(why[nt.id], /^tape\.jsonl has no frame lines/);
    assert.ok(p.rows.every(r => r.result === "skipped" && r.expectation === null));

    // nothing to replay: finishCheck writes check.json and the summary, no Electron needed
    const out = await finishCheck(req, p, p.rows, Date.now() - 50);
    assert.equal(out.summary.skipped, 2);
    assert.equal(out.summary.exit, 0);
    assert.ok(out.rows.every(r => !("_ord" in r)));
    const doc = JSON.parse(await readFile(out.checkFile, "utf8"));
    assert.equal(doc.v, 1);
    assert.equal(doc.host, "1.4.1");
    assert.equal(doc.root, g.root);
    assert.equal(doc.summary.total, 2);
    assert.equal(doc.rows.length, 2);
    assert.equal(doc.request.out, g.out);
    assert.equal(out.checkFile.startsWith(join(g.out, "checks")), true);
    assert.deepEqual(doc.rows.map(r => r.session), [nt.id, ns.id], "plan order: newest session first");
  } finally { await rm(g.dir, { recursive: true, force: true }); }
});
