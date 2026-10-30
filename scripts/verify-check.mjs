// Y4 — snapper check (BRIEF-v1.3 §3, §7). Parts:
//   1. the demo: play the smoke, check matches; a COPY with one constant edited differs with a firstDiff under $.player;
//      --accept on the copy writes expected.json and a second check matches; examples/demo is byte-identical afterwards
//   2. Moonflex: two R3/R9-style sessions (plain run; in-page level change) played into sessions/y4/out, then
//      `check <moonflex> --out sessions/y4/out` -> every mark matches
//   3. Maxim's real 2026-10-19 session, READ-ONLY: `check ... --session <his> --out sessions/y4/maxim` (never --accept);
//      his session folder and Moonflex's whole .snapper folder are listed (path, size, mtime) before and after and must be
//      identical. The counts and the wall time are a REPORT, not a pass condition.
//   node scripts/verify-check.mjs [--game C:/Coding/moonflexforceabilities-v3] [--maxim <session dir>] [--skip-maxim]
//   EVIDENCE=1 writes private/evidence/<EVIDENCE_VERSION or v1.3>/y4/
import { join } from "node:path";
import { readFile, writeFile, mkdir, rm, cp, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { REPO, snapper, checklist, exists, EVIDENCE_ON, evidenceDir } from "./lib.mjs";
import { formatTable, summaryLine } from "../packages/host/tools/check.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const GAME = opt("--game", "C:/Coding/moonflexforceabilities-v3");
const MAXIM = opt("--maxim", "C:/Coding/moonflexforceabilities-v3/.snapper/sessions/moonflex/2026-10-19T15-48-55");
const SKIP_MAXIM = argv.includes("--skip-maxim");
const Y4 = join(REPO, "sessions", "y4");
const c = checklist("Y4 snapper check");
const report = { demo: {}, moonflex: {}, maxim: null };
const tables = {};

const lastJson = r => { try { return JSON.parse(r.lastLine); } catch { return null; } };
async function treeHash(dir) {
  const h = createHash("sha256");
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) h.update(e.name + ":" + await treeHash(p));
    else h.update(e.name + ":" + await readFile(p));
  }
  return h.digest("hex");
}
/** Every file under dir, recursively: "relative/path\tsize\tmtimeMs", sorted. */
async function listing(dir) {
  const out = [];
  async function walk(d) {
    let ents;
    try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) { out.push(`${p.slice(dir.length)}/\t-\t-`); await walk(p); }
      else { const s = await stat(p); out.push(`${p.slice(dir.length)}\t${s.size}\t${Math.round(s.mtimeMs)}`); }
    }
  }
  await walk(dir);
  return out;
}
const runCheck = async (args, timeoutMs = 600000) => {
  const t0 = Date.now();
  const r = await snapper(["check", ...args, "--json"], { timeoutMs, echo: false });
  const res = lastJson(r);
  return { r, res, ms: Date.now() - t0 };
};

async function finish() {
  const ok = c.report();
  if (EVIDENCE_ON) {
    const dir = evidenceDir("v1.3", "y4");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "checks.json"), JSON.stringify({ gate: "Y4", date: new Date().toISOString(), ok, report, checks: c.items }, null, 2) + "\n");
    for (const [name, text] of Object.entries(tables)) await writeFile(join(dir, `${name}.txt`), text);
    if (report.maxim) await writeFile(join(dir, "maxim-counts.json"), JSON.stringify(report.maxim, null, 2) + "\n");
    process.stdout.write(`evidence: ${Object.keys(tables).length + 1 + (report.maxim ? 1 : 0)} files in ${dir}\n`);
  }
  process.exit(ok ? 0 : 1);
}
const tableText = (title, res) => `${title}\n\n${formatTable(res.rows)}\n${summaryLine(res.summary)}\n`;

await rm(Y4, { recursive: true, force: true });
await mkdir(Y4, { recursive: true });

// ------------------------------------------------------------------------------------------------ 1. the demo
{
  const DEMO = join(REPO, "examples", "demo");
  const before = await treeHash(DEMO);
  const OUT = join(Y4, "demo-out");
  const play = await snapper(["play", DEMO, "--smoke", join(DEMO, "smoke.json"), "--out", OUT], { echo: false });
  c.check("demo: play --smoke exits 0 and is ok", play.code === 0 && play.last?.ok === true, `exit ${play.code} ${play.lastLine.slice(0, 120)}`);
  const sessionDir = play.last?.session;
  const m = await runCheck([DEMO, "--out", OUT]);
  c.check("demo: check on the unchanged demo -> all match, exit 0", m.r.code === 0 && m.res?.summary.match === m.res?.summary.total && m.res?.summary.total >= 5,
    JSON.stringify(m.res?.summary));
  report.demo.match = m.res?.summary;
  if (m.res) tables["demo-match"] = tableText("demo, unchanged", m.res);

  const copy = join(Y4, "demo-copy");
  await cp(DEMO, copy, { recursive: true });
  const src = await readFile(join(copy, "game.js"), "utf8");
  await writeFile(join(copy, "game.js"), src.replace("SPEED = 2,", "SPEED = 2.5,"));
  const d = await runCheck([copy, "--session", sessionDir, "--out", OUT]);
  const diffs = d.res?.rows.filter(x => x.result === "differs") || [];
  c.check("demo: the changed copy differs (exit 1) with a firstDiff under $.player", d.r.code === 1 && diffs.length >= 1 && diffs.every(x => x.firstDiff.startsWith("$.player")),
    `${diffs.length} differs: ${[...new Set(diffs.map(x => x.firstDiff))].join(", ")}`);
  report.demo.changed = d.res?.summary;
  if (d.res) tables["demo-changed"] = tableText("demo copy with SPEED 2 -> 2.5", d.res);
  c.check("demo: a plain check wrote no expected.json", !(await exists(join(sessionDir, "marks", "0001", "expected.json"))));

  const a = await runCheck([copy, "--session", sessionDir, "--out", OUT, "--accept"]);
  c.check("demo: --accept on the copy exits 0, every replayed mark accepted", a.r.code === 0 && a.res?.summary.accepted === a.res?.summary.total - a.res?.summary.skipped,
    JSON.stringify(a.res?.summary));
  c.check("demo: expected.json written on mark 0001", await exists(join(sessionDir, "marks", "0001", "expected.json")));
  const again = await runCheck([copy, "--session", sessionDir, "--out", OUT]);
  c.check("demo: the second check on the copy matches (expectation = expected.json)", again.r.code === 0 && again.res?.summary.match === again.res?.summary.total
    && again.res.rows.every(x => x.expectation === "expected"), JSON.stringify(again.res?.summary));
  if (again.res) tables["demo-accepted"] = tableText("demo copy after --accept", again.res);
  c.check("demo: examples/demo is byte-identical afterwards", (await treeHash(DEMO)) === before);
  c.check("demo: no .snapper folder appeared in examples/demo", !(await exists(join(DEMO, ".snapper"))));
}

// ------------------------------------------------------------------------------------------------ 2. Moonflex test sessions
if (!(await exists(GAME))) {
  c.check("Moonflex game root exists", false, GAME);
} else {
  const OUT = join(Y4, "out");
  const QUERY = "?scene=stage&level=1-1";
  const smoke = async (name, steps) => {
    const f = join(Y4, `smoke-${name}.json`);
    await writeFile(f, JSON.stringify(steps, null, 2) + "\n");
    return f;
  };
  // A: R3-style, ~10 s holding right with a jump tap every 0.75 s, one mark
  const stepsA = [{ wait: 2500 }, { down: "KeyD" }];
  for (let i = 0; i < 13; i++) stepsA.push({ key: "Space", ms: 120 }, { wait: 630 });
  stepsA.push({ mark: "y4 plain run" }, { up: "KeyD" }, { wait: 500 }, { end: true });
  const A = await snapper(["play", GAME, "--preset", "1080p", "--query", QUERY, "--smoke", await smoke("a", stepsA), "--out", OUT], { timeoutMs: 300000, echo: false });
  c.check("Moonflex A (R3-style): play --smoke exits 0", A.code === 0 && A.last?.ok === true, `exit ${A.code} ${A.lastLine.slice(0, 160)}`);

  // B: R9-style, the ghost tape stepped in-page through 1-1 into 1-2, then a mark
  const CODES = { right: "KeyD", left: "KeyA", jump: "Space", down: "KeyS", up: "KeyW", dash: "KeyX", special: "KeyC", tool: "KeyV" };
  let B = null;
  try {
    const ghost = JSON.parse(await readFile(join(GAME, "tools", "ghost", "1-1.tape.json"), "utf8"));
    const runs = [];
    for (const e of ghost.tape) {
      const codes = e ? e.split("+").map(a => CODES[a]) : [];
      if (codes.some(x => !x)) throw new Error(`unknown ghost action ${e}`);
      const last = runs[runs.length - 1];
      if (last && last.codes.join() === codes.join()) last.n++;
      else runs.push({ n: 1, codes });
    }
    const slices = [];
    for (let a = 0, i = 0; i <= runs.length; i++) {
      const frames = runs.slice(a, i).reduce((t, x) => t + x.n, 0);
      if (i === runs.length ? i > a : frames >= 400) { slices.push([a, i]); a = i; }
    }
    const stepsB = [
      { wait: 1500 },
      { eval: `window.__r9 = ${JSON.stringify(runs)}; if (window.__mf.loop.stats.steps !== 0) throw new Error('not at frame 0: ' + window.__mf.loop.stats.steps); 1` },
      ...slices.map(([a, b]) => ({ eval: `(() => { for (const r of window.__r9.slice(${a}, ${b})) window.__mf.step(r.n, r.codes); return window.__mf.loop.stats.steps })()`, ms: 60000 })),
      { eval: "window.__mf.loop.start(); 1" },
      { wait: 3500 }, { keys: ["Space"], hold: 200 }, { wait: 1500 }, { mark: "y4 after in-page level change" }, { wait: 500 }, { end: true },
    ];
    B = await snapper(["play", GAME, "--preset", "1080p", "--query", QUERY + "&paused", "--smoke", await smoke("b", stepsB), "--out", OUT], { timeoutMs: 300000, echo: false });
    c.check("Moonflex B (R9-style): play --smoke exits 0", B.code === 0 && B.last?.ok === true, `exit ${B.code} ${B.lastLine.slice(0, 160)}`);
  } catch (e) {
    c.check("Moonflex B (R9-style): set up", false, e.message);
  }

  const t = await runCheck([GAME, "--out", OUT]);
  const s = t.res?.summary;
  c.check("Moonflex: check on the two test sessions -> all match, exit 0", t.r.code === 0 && s && s.total >= 2 && s.match === s.total,
    `${JSON.stringify(s)} ${t.r.stderr.split("\n").filter(l => /error|differs/.test(l)).slice(0, 3).join(" | ")}`);
  report.moonflex = { summary: s, ms: t.ms, sessions: [A.last?.session, B?.last?.session] };
  if (t.res) tables["moonflex-test-sessions"] = tableText("Moonflex test sessions (R3-style and R9-style)", t.res);
}

// ------------------------------------------------------------------------------------------------ 3. Maxim's real session, read-only
if (SKIP_MAXIM) {
  process.stdout.write("Maxim's session skipped (--skip-maxim)\n");
} else if (!(await exists(MAXIM))) {
  c.check("Maxim's real session exists", false, MAXIM);
} else {
  const SNAP_DIR = join(GAME, ".snapper");
  const beforeSession = await listing(MAXIM);
  const beforeAll = await listing(SNAP_DIR);
  const OUTM = join(Y4, "maxim");
  const t0 = Date.now();
  const x = await runCheck([GAME, "--session", MAXIM, "--out", OUTM], 40 * 60000);
  const wall = Date.now() - t0;
  const afterSession = await listing(MAXIM);
  const afterAll = await listing(SNAP_DIR);
  c.check("Maxim: check ran (exit 0 or 1, a result came back)", (x.r.code === 0 || x.r.code === 1) && !!x.res, `exit ${x.r.code} ${x.r.stderr.slice(-300)}`);
  c.check("Maxim: his session folder is byte-for-byte unchanged (path, size, mtime)", beforeSession.join("\n") === afterSession.join("\n"),
    `${beforeSession.length} entries before, ${afterSession.length} after`);
  c.check("Maxim: Moonflex's whole .snapper folder is unchanged (path, size, mtime)", beforeAll.join("\n") === afterAll.join("\n"),
    `${beforeAll.length} entries before, ${afterAll.length} after`);
  c.check("Maxim: no expected.json and no check.json inside his session", !afterSession.some(l => /expected\.json|check\.json/.test(l)));
  c.check("Maxim: check.json went to --out", !!x.res?.checkFile && x.res.checkFile.startsWith(join(OUTM, "checks")), x.res?.checkFile);
  report.maxim = { session: MAXIM, wallSeconds: Math.round(wall / 100) / 10, summary: x.res?.summary || null,
    differs: (x.res?.rows || []).filter(r => r.result === "differs").map(r => `${r.mark} ${r.firstDiff}`),
    skipped: (x.res?.rows || []).filter(r => r.result === "skipped").map(r => `${r.mark} ${r.reason}`),
    errors: (x.res?.rows || []).filter(r => r.result === "error").map(r => `${r.mark} ${r.message}`),
    sessionEntries: beforeSession.length, snapperEntries: beforeAll.length };
  process.stdout.write(`Maxim's session: ${JSON.stringify(report.maxim.summary)} in ${report.maxim.wallSeconds} s\n`);
  if (x.res) tables["maxim-session"] = tableText(`Maxim's 2026-10-19 session (read-only), ${report.maxim.wallSeconds} s wall`, x.res);
}

await finish();
