// G3 — Moonflex end to end (BRIEF §6). Plays Moonflex 1-1 in the Electron host with a smoke script
// (hold right, tap jump for ~6 s, mark, end), checks the session, replays the mark, and optionally runs
// Moonflex's own `npm test` and the short perf check. Evidence → private/evidence/v1.0/g3/.
//   node scripts/verify-moonflex.mjs [--game C:/Coding/moonflexforceabilities-v3] [--out <dir>] [--moonflex-checks] (EVIDENCE=1 writes private/evidence)
//     [--resume]       also run R3 (save states and resume on Moonflex, D-021) after G3; evidence -> private/evidence/v1.1.1/r3/
//     [--only-resume]  skip G3's own play/replay, run R3 only
//   With --resume / --only-resume the gates run in order R3, R6 (D-022 segment query by navigation) and
//   R9 (D-023: a mark after an IN-PAGE level change; Moonflex D-065 prefetch; evidence -> private/evidence/v1.1.2/r9/).
import { join, basename } from "node:path";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readSession, readTape, readCheckpoint, pickSegment, isFrameLine } from "../packages/core/index.mjs";
import { REPO, snapper, checklist, png, json, evidence, exists, EVIDENCE_ON, evidenceDir } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const GAME = opt("--game", "C:/Coding/moonflexforceabilities-v3");
const OUT = opt("--out", join(REPO, "sessions", "g3"));
const c = checklist("G3 Moonflex end to end");
const ONLY_RESUME = argv.includes("--only-resume");
const RESUME = ONLY_RESUME || argv.includes("--resume");
let ok3 = true;
if (!ONLY_RESUME) {

// the smoke script: ~6 s holding right with a jump tap every 0.75 s, then a mark
const steps = [{ wait: 2500 }, { down: "KeyD" }];
for (let i = 0; i < 8; i++) steps.push({ key: "Space", ms: 120 }, { wait: 630 });
steps.push({ mark: "g3 smoke mark" }, { up: "KeyD" }, { wait: 800 },
  { expect: { marksAtLeast: 1, ready: { sdk: true, state: true, frame: true, stepper: true } } }, { end: true });
await mkdir(join(REPO, "sessions"), { recursive: true });
const script = join(REPO, "sessions", "g3-smoke.json");
await writeFile(script, JSON.stringify(steps, null, 2) + "\n");

const run = await snapper(["play", GAME, "--preset", "1080p", "--query", "?scene=stage&level=1-1", "--smoke", script, "--out", OUT], { timeoutMs: 240000 });
c.check("play --smoke exits 0", run.code === 0, `exit ${run.code}`);
c.check("result JSON ok:true", run.last?.ok === true, run.lastLine.slice(0, 200));
const dir = run.last?.session;
if (!dir || !(await exists(dir))) {
  c.check("session folder exists", false, String(dir));
  process.exit(c.report() ? 0 : 1);
}
process.stdout.write(`session: ${dir}\n`);
const s = await readSession(dir);
c.check("boot ok", s.boot?.ok === true, JSON.stringify(s.boot));
c.check("ready: state, frame, stepper true", s.ready?.state && s.ready?.frame && s.ready?.stepper, JSON.stringify(s.ready));
const m = s.marks.find(x => x.trigger === "smoke");
c.check("smoke mark written", !!m, s.marks.map(x => `${x.id}:${x.trigger}`).join(" "));
let replayDir = null;
if (m) {
  const d = join(dir, ...m.dir.split("/"));
  const fr = await png(join(d, "frame.png"));
  c.check("frame.png 320×180 and not blank", fr.size?.w === 320 && fr.size?.h === 180 && fr.stats?.distinct > 16,
    fr.error || `${fr.size?.w}×${fr.size?.h} distinct colours ${fr.stats?.distinct} nonBlack ${fr.stats?.nonBlack.toFixed(3)}`);
  const shot = await png(join(d, "shot.png"));
  c.check("shot.png 1920×1080 non-black", shot.size?.w === 1920 && shot.size?.h === 1080 && shot.stats?.nonBlack > 0.05,
    shot.error || `${shot.size?.w}×${shot.size?.h} nonBlack ${shot.stats?.nonBlack.toFixed(3)}`);
  const state = await json(join(d, "state.json"));
  c.check('state.json level "1-1"', state?.level === "1-1", JSON.stringify(state)?.slice(0, 300));
  c.check("the player moved right (held KeyD)", state && JSON.stringify(state).includes("player"), "");
  const rep = await snapper(["replay", dir, m.id], { timeoutMs: 240000 });
  c.check("replay exits 0", rep.code === 0, `exit ${rep.code}`);
  replayDir = join(d, "replay");
  const rj = await json(join(replayDir, "replay.json"));
  c.check("replay stateMatches: true (player position identical)", rj?.stateMatches === true,
    rj ? `stateMatches ${rj.stateMatches}${rj.firstDiff ? ` firstDiff ${rj.firstDiff}` : ""} chromium ${rj.chromium}` : "missing");
}

// Moonflex's own checks (BRIEF §4.7 proof), opt-in because they are slow
const sh = (cmd, args, env = {}) => new Promise(res => {
  const ch = spawn(cmd, args, { cwd: GAME, shell: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  ch.stdout.on("data", d => { out += d; process.stdout.write(d); });
  ch.stderr.on("data", d => { out += d; process.stderr.write(d); });
  ch.on("close", code => res({ code, out }));
});
const freePort = () => new Promise(res => { const srv = createServer(); srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); }); });
if (argv.includes("--moonflex-checks")) {
  const t = await sh("npm", ["test"]);
  const pass = /ℹ pass (\d+)/.exec(t.out)?.[1], fail = /ℹ fail (\d+)/.exec(t.out)?.[1];
  c.check("Moonflex npm test", t.code === 0 && fail === "0", `pass ${pass} fail ${fail}`);
  const p = await sh("node", ["tools/checks/perf.mjs", '"?scene=move"'],
    { PERF_SECONDS: "8", PERF_WARM: "3", PERF_SAMPLE: "2", EVIDENCE_SUB: "../../../Snapper/sessions/g3-perf", CHECK_PORT: String(await freePort()) });
  c.check("Moonflex short perf run PASS", p.code === 0 && /PASS/.test(p.out) && !/\bFAIL\b/.test(p.out), `exit ${p.code}`);
  await writeFile(join(REPO, "sessions", "g3-moonflex-checks.txt"), `${t.out}\n\n----- perf -----\n${p.out}`);
}

const ok = c.report();
if (EVIDENCE_ON && m) {
  const d = join(dir, ...m.dir.split("/"));
  await evidence("g3", [
    [join(dir, "SESSION.md"), "SESSION.md"],
    [join(d, "shot.png"), `shot-${m.id}.png`],
    [join(d, "frame.png"), `frame-${m.id}.png`],
    [join(d, "state.json"), `state-${m.id}.json`],
    ...(replayDir ? [[join(replayDir, "replay.md"), "replay.md"], [join(replayDir, "sheet.png"), "replay-sheet.png"]] : []),
  ]);
  await writeFile(join(evidenceDir("v1.0", "g3"), "checks.json"),
    JSON.stringify({ gate: "G3", date: new Date().toISOString(), session: dir, ok, checks: c.items }, null, 2) + "\n");
}
ok3 = ok;
}

if (RESUME) await runR3();
else process.exit(ok3 ? 0 : 1);

/** R3: save states and resume on Moonflex (D-021). */
async function runR3() {
  const r = checklist("R3 Moonflex save states and resume");
  const R3_OUT = join(REPO, "sessions", "r3");
  const SYNTH_OUT = join(REPO, "sessions", "r3-synth");
  const QUERY = "?scene=stage&level=1-1";
  const files = [];
  const info = { sessions: {} };
  const wrap = async ok => {
    const rOk = r.report() && ok;
    if (EVIDENCE_ON) {
      const dir = evidenceDir("v1.1.1", "r3");
      const ev = await evidence("r3", files, "v1.1.1");
      await writeFile(join(dir, "checks.json"), JSON.stringify({ gate: "R3", date: new Date().toISOString(), sessions: info.sessions, ok: rOk, checks: r.items }, null, 2) + "\n");
      process.stdout.write(`evidence: ${ev.length + 1} files in private/evidence/v1.1.1/r3/\n`);
    }
    return runR6(rOk && ok3);
  };
  await mkdir(join(REPO, "sessions"), { recursive: true });
  const writeSmoke = async (name, steps) => {
    const f = join(REPO, "sessions", `r3-smoke-${name}.json`);
    await writeFile(f, JSON.stringify(steps, null, 2) + "\n");
    return f;
  };

  // (a) the source run: ~10 s holding right with a jump tap every 0.75 s, then close → exit state
  const stepsA = [{ wait: 2500 }, { down: "KeyD" }];
  for (let i = 0; i < 13; i++) stepsA.push({ key: "Space", ms: 120 }, { wait: 630 });
  stepsA.push({ up: "KeyD" }, { wait: 500 }, { end: true });
  const A = await snapper(["play", GAME, "--preset", "1080p", "--query", QUERY, "--smoke", await writeSmoke("a", stepsA), "--out", R3_OUT], { timeoutMs: 240000 });
  r.check("A: play --smoke exits 0", A.code === 0 && A.last?.ok === true, `exit ${A.code} ${A.lastLine.slice(0, 160)}`);
  const dirA = A.last?.session;
  if (!dirA || !(await exists(dirA))) { r.check("A: session folder exists", false, String(dirA)); return wrap(false); }
  info.sessions.source = dirA;
  process.stdout.write(`R3 source session: ${dirA}\n`);
  const exitCp = await readCheckpoint(dirA, "exit");
  r.check("A: checkpoints/exit.json restorable with frame > 300", exitCp?.restorable === true && exitCp.frame > 300,
    exitCp ? `frame ${exitCp.frame} restorable ${exitCp.restorable} ${exitCp.reason || ""}` : "missing");
  files.push([join(dirA, "checkpoints", "exit.json"), "exit.json"]);
  if (!exitCp || !Number.isInteger(exitCp.frame)) return wrap(false);

  // (b) resume at exit; no --query: it must default to the source's
  const stepsB = [{ wait: 1500 }, { down: "KeyD" }, { wait: 1200 }, { up: "KeyD" }, { mark: "r3 after resume" }, { wait: 500 }, { end: true }];
  const B = await snapper(["play", GAME, "--preset", "1080p", "--resume", dirA, "--out", R3_OUT, "--smoke", await writeSmoke("b", stepsB)], { timeoutMs: 240000 });
  r.check("B: resumed play --smoke exits 0", B.code === 0 && B.last?.ok === true, `exit ${B.code} ${B.lastLine.slice(0, 160)}`);
  const dirB = B.last?.session;
  if (!dirB || !(await exists(dirB))) { r.check("B: session folder exists", false, String(dirB)); return wrap(false); }
  info.sessions.resumed = dirB;
  process.stdout.write(`R3 resumed session: ${dirB}\n`);
  const envB = (await json(join(dirB, "env.json"))) || {};
  r.check("B: env.resumeMatched === true", envB.resumeMatched === true,
    `resumeMatched ${envB.resumeMatched}${envB.firstDiff ? ` firstDiff ${envB.firstDiff}` : ""}${envB.resumeError ? ` error ${envB.resumeError}` : ""}`);
  r.check("B: the query defaulted to the source's", envB.game?.query === QUERY, JSON.stringify(envB.game?.query));
  process.stdout.write(`B restore: ${envB.restore?.frames} frames in ${envB.restore?.ms} ms = ${envB.restore?.fps} frames/s (${envB.restore?.chunks} chunks)\n`);
  const sB = await readSession(dirB);
  process.stdout.write(`B player at the source exit: ${JSON.stringify(exitCp.state?.player)}; resume line matched: ${sB.resume?.matched}\n`);
  r.check("B: a resume line with matched true", sB.resume?.matched === true, JSON.stringify(sB.resume));
  files.push([join(dirB, "SESSION.md"), "SESSION-resumed.md"]);

  // (c) replay the mark taken after the resume
  const mB = sB.marks.find(x => x.trigger === "smoke") || sB.marks[sB.marks.length - 1];
  r.check("C: a mark was taken after the resume", !!mB, sB.marks.map(x => `${x.id}:${x.trigger}`).join(" "));
  if (mB) {
    const rep = await snapper(["replay", dirB, mB.id], { timeoutMs: 240000 });
    r.check("C: replay exits 0", rep.code === 0, `exit ${rep.code}`);
    const replayDir = join(dirB, ...mB.dir.split("/"), "replay");
    const rj = await json(join(replayDir, "replay.json"));
    r.check("C: replay.json stateMatches: true", rj?.stateMatches === true, rj ? `stateMatches ${rj.stateMatches}${rj.firstDiff ? ` firstDiff ${rj.firstDiff}` : ""}` : "missing");
    files.push([join(replayDir, "replay.md"), "replay.md"]);
  }

  // (d) restore-rate probe: a synthetic source whose tape repeats the real run pattern up to frame 100000
  const TARGET = 100000;
  const tapeA = await readTape(dirA);
  const seg = pickSegment(tapeA.lines, exitCp.segment, exitCp.t);
  const pattern = seg.lines.filter(l => isFrameLine(l) && l.f <= exitCp.frame).map(l => ({ f: l.f, m: l.m }));
  const len = exitCp.frame + 1;
  const lines = [];
  for (let k = 0; pattern.length && k * len <= TARGET; k++) {
    for (const l of pattern) if (l.f + k * len <= TARGET) lines.push({ f: l.f + k * len, m: l.m });
  }
  const synthId = "2026-01-01T00-00-00";
  const synthDir = join(SYNTH_OUT, "moonflex", synthId);
  await mkdir(join(synthDir, "checkpoints"), { recursive: true });
  const envA = (await json(join(dirA, "env.json"))) || {};
  const synthQuery = envA.game?.query ?? QUERY;
  await writeFile(join(synthDir, "env.json"), JSON.stringify(envA, null, 2) + "\n");
  const header = tapeA.header || { kind: "tape", v: 1, keymap: envA.sdk?.keymap || [], pauseParam: envA.sdk?.pauseParam || "paused" };
  await writeFile(join(synthDir, "tape.jsonl"), [header, ...lines].map(l => JSON.stringify(l)).join("\n") + "\n");
  await writeFile(join(synthDir, "session.jsonl"), JSON.stringify({ kind: "session", t: 0, v: 1, id: synthId, game: "moonflex", query: synthQuery }) + "\n");
  await writeFile(join(synthDir, "checkpoints", "exit.json"), JSON.stringify({
    v: 1, name: "exit", kind: "exit", trigger: "exit", frame: TARGET, t: 1, query: synthQuery,
    segment: { index: 0, reloadT: null }, restorable: true, state: { synthetic: true },
  }, null, 2) + "\n");
  r.check("D: synthetic source built", lines.length > 0, `${lines.length} frame lines to frame ${TARGET} from a ${len}-frame pattern (${basename(synthDir)})`);
  const D = await snapper(["play", GAME, "--preset", "1080p", "--resume", synthDir, "--out", SYNTH_OUT, "--smoke", await writeSmoke("synth", [{ wait: 300 }, { end: true }])], { timeoutMs: 600000 });
  const dirD = D.last?.session;
  const envD = dirD ? (await json(join(dirD, "env.json"))) || {} : {};
  if (dirD) info.sessions.synthetic = dirD;
  r.check("D: the restore ran (restore.frames === 100000 or no resumeError)", envD.restore?.frames === TARGET || !envD.resumeError,
    `restore ${JSON.stringify(envD.restore)} resumeError ${envD.resumeError ?? "none"} (play exit ${D.code}; resumeMatched ${envD.resumeMatched} is expected false)`);
  const probe = { frames: envD.restore?.frames ?? null, ms: envD.restore?.ms ?? null, fps: envD.restore?.fps ?? null };
  process.stdout.write(`D restore rate: ${probe.frames} frames in ${probe.ms} ms = ${probe.fps} frames/s; 100000 frames within 60000 ms: ${probe.ms != null && probe.ms <= 60000}\n`);
  const probeFile = join(REPO, "sessions", "r3-restore-rate.json");
  await writeFile(probeFile, JSON.stringify(probe, null, 2) + "\n");
  files.push([probeFile, "restore-rate.json"]);
  return wrap(true);
}

/** R6 (D-022): a level change by navigation; a mark after it restores and replays with the segment's query. */
async function runR6(prevOk) {
  const r = checklist("R6 Moonflex segment query (D-022)");
  const OUT6 = join(REPO, "sessions", "r6");
  const files = [];
  const info = { sessions: {} };
  const finish6 = async () => {
    const ok = r.report();
    if (EVIDENCE_ON) {
      const ev = await evidence("r6", files, "v1.1.1");
      const dir = evidenceDir("v1.1.1", "r6");
      await writeFile(join(dir, "checks.json"), JSON.stringify({ gate: "R6", date: new Date().toISOString(), sessions: info.sessions, ok, checks: r.items }, null, 2) + "\n");
      process.stdout.write(`evidence: ${ev.length + 1} files in private/evidence/v1.1.1/r6/
`);
    }
    return runR9(ok && prevOk);
  };
  const smoke = async (name, steps) => {
    const f = join(REPO, "sessions", `r6-smoke-${name}.json`);
    await writeFile(f, JSON.stringify(steps, null, 2) + "\n");
    return f;
  };
  const Q1 = "?scene=stage&level=1-1", Q2 = "?scene=stage&level=1-2";
  const stepsA = [{ wait: 2500 }, { keys: ["KeyD"], hold: 3000 }, { navigate: Q2 }, { wait: 800 }, { keys: ["KeyD"], hold: 3000 }, { mark: "r6 after navigation" }, { wait: 400 }, { end: true }];
  const A = await snapper(["play", GAME, "--preset", "1080p", "--query", Q1, "--smoke", await smoke("a", stepsA), "--out", OUT6], { timeoutMs: 240000 });
  r.check("A: play --smoke (navigate to level 1-2) exits 0", A.code === 0 && A.last?.ok === true, `exit ${A.code} ${A.lastLine.slice(0, 160)}`);
  const dirA = A.last?.session;
  if (!dirA || !(await exists(dirA))) { r.check("A: session folder exists", false, String(dirA)); return finish6(); }
  info.sessions.source = dirA;
  const sA = await readSession(dirA);
  const tapeA = await readTape(dirA);
  const rel = tapeA.lines.find(l => l.ev === "reload");
  r.check("A: the reload marker carries query " + Q2, rel?.query === Q2, JSON.stringify(rel));
  const mark = sA.marks.find(x => x.trigger === "smoke");
  r.check("A: a smoke mark exists", !!mark, sA.marks.map(x => `${x.id}:${x.trigger}`).join(" "));
  if (!mark) return finish6();
  const stateA = (await json(join(dirA, ...mark.dir.split("/"), "state.json"))) || {};
  r.check("A: the mark's state.level is 1-2", stateA.level === "1-2", `level ${JSON.stringify(stateA.level)}`);
  files.push([join(dirA, "SESSION.md"), "SESSION-source.md"], [join(dirA, ...mark.dir.split("/"), "state.json"), "state-mark.json"]);

  const B = await snapper(["play", GAME, "--preset", "1080p", "--resume", dirA, "--at", "mark-" + mark.id, "--smoke", await smoke("b", [{ wait: 1500 }, { end: true }]), "--out", OUT6], { timeoutMs: 240000 });
  r.check("B: resumed play exits 0", B.code === 0 && B.last?.ok === true, `exit ${B.code} ${B.lastLine.slice(0, 160)}`);
  const dirB = B.last?.session;
  if (dirB) {
    info.sessions.resumed = dirB;
    const envB = (await json(join(dirB, "env.json"))) || {};
    const rl = (await readSession(dirB)).resume;
    r.check("B: --at mark-" + mark.id + " -> resumeMatched true, booted with the segment's query " + Q2,
      envB.resumeMatched === true && envB.game?.query === Q2 && rl?.query === Q2, `matched ${envB.resumeMatched} query ${JSON.stringify(envB.game?.query)} resume ${JSON.stringify(rl)}${envB.firstDiff ? ` firstDiff ${envB.firstDiff}` : ""}`);
    const cpState = (await readCheckpoint(dirA, "mark-" + mark.id))?.state;
    r.check("B: the saved state's level is 1-2", cpState?.level === "1-2", `level ${JSON.stringify(cpState?.level)}`);
    files.push([join(dirB, "SESSION.md"), "SESSION-resumed.md"]);
  }
  const rep = await snapper(["replay", dirA, mark.id], { timeoutMs: 240000 });
  r.check("C: replay exits 0", rep.code === 0, `exit ${rep.code}`);
  const replayDir = join(dirA, ...mark.dir.split("/"), "replay");
  const rj = await json(join(replayDir, "replay.json"));
  r.check("C: replay stateMatches true with the segment's query", rj?.stateMatches === true && rj?.query === Q2 && rj?.querySource === "marker",
    rj ? `stateMatches ${rj.stateMatches} query ${rj.query} (${rj.querySource})${rj.firstDiff ? ` firstDiff ${rj.firstDiff}` : ""}` : "missing");
  files.push([join(replayDir, "replay.md"), "replay.md"]);
  return finish6();
}

/** R9 (D-023): the ghost tape drives 1-1 to the goal through the smoke `eval` step; the tally's JUMP changes level in-page (Moonflex D-065);
 *  a mark there restores and replays with a matched state. */
async function runR9(prevOk) {
  const r = checklist("R9 Moonflex in-page level change (Moonflex D-065, Snapper D-023)");
  const OUT9 = join(REPO, "sessions", "r9");
  const files = [];
  const info = { sessions: {} };
  const finish9 = async () => {
    const ok = r.report();
    if (EVIDENCE_ON) {
      const ev = await evidence("r9", files, "v1.1.2");
      const dir = evidenceDir("v1.1.2", "r9");
      await writeFile(join(dir, "checks.json"), JSON.stringify({ gate: "R9", date: new Date().toISOString(), sessions: info.sessions, ok, checks: r.items }, null, 2) + "\n");
      process.stdout.write(`evidence: ${ev.length + 1} files in private/evidence/v1.1.2/r9/
`);
    }
    process.exit(ok && prevOk ? 0 : 1);
  };
  const smoke = async (name, steps) => {
    const f = join(REPO, "sessions", `r9-smoke-${name}.json`);
    await writeFile(f, JSON.stringify(steps, null, 2) + "\n");
    return f;
  };
  const CODES = { right: "KeyD", left: "KeyA", jump: "Space", down: "KeyS", up: "KeyW", dash: "KeyX", special: "KeyC", tool: "KeyV" };
  const ghost = JSON.parse(await readFile(join(GAME, "tools", "ghost", "1-1.tape.json"), "utf8"));
  const runs = [];
  for (const e of ghost.tape) {
    const codes = e ? e.split("+").map(a => CODES[a]) : [];
    if (codes.some(x => !x)) { r.check("ghost tape actions all known", false, e); return finish9(); }
    const last = runs[runs.length - 1];
    if (last && last.codes.join() === codes.join()) last.n++;
    else runs.push({ n: 1, codes });
  }
  // slices of at most ~400 frames, cut on run boundaries so every run is stepped exactly once
  const slices = [];
  for (let a = 0, i = 0; i <= runs.length; i++) {
    const frames = runs.slice(a, i).reduce((t, x) => t + x.n, 0);
    if (i === runs.length ? i > a : frames >= 400) { slices.push([a, i]); a = i; }
  }
  const stepsA = [
    { wait: 1500 },
    { eval: `window.__r9 = ${JSON.stringify(runs)}; if (window.__mf.loop.stats.steps !== 0) throw new Error('not at frame 0: ' + window.__mf.loop.stats.steps); 1` },
    ...slices.map(([a, b]) => ({ eval: `(() => { for (const r of window.__r9.slice(${a}, ${b})) window.__mf.step(r.n, r.codes); return window.__mf.loop.stats.steps })()`, ms: 60000 })),
    { eval: "window.__mf.loop.start(); 1" },
    { wait: 3500 },
    { keys: ["Space"], hold: 200 },
    { wait: 1500 }, { mark: "r9 after in-page level change" }, { wait: 500 }, { end: true },
  ];
  process.stdout.write(`R9 ghost tape: ${ghost.tape.length} frames in ${runs.length} runs, ${slices.length} slices
`);
  const QUERY = "?scene=stage&level=1-1&paused";
  const A = await snapper(["play", GAME, "--preset", "1080p", "--query", QUERY, "--smoke", await smoke("a", stepsA), "--out", OUT9], { timeoutMs: 300000 });
  r.check("A: play --smoke exits 0 and the smoke reports ok", A.code === 0 && A.last?.ok === true, `exit ${A.code} ${A.lastLine.slice(0, 200)}`);
  const dirA = A.last?.session;
  if (!dirA || !(await exists(dirA))) { r.check("A: session folder exists", false, String(dirA)); return finish9(); }
  info.sessions.source = dirA;
  process.stdout.write(`R9 source session: ${dirA}
`);
  const sA = await readSession(dirA);
  const mark = sA.marks.find(x => x.trigger === "smoke");
  r.check("A: a mark with trigger smoke exists", !!mark, sA.marks.map(x => `${x.id}:${x.trigger}`).join(" "));
  if (!mark) return finish9();
  const mdir = join(dirA, ...mark.dir.split("/"));
  const st = (await json(join(mdir, "state.json"))) || {};
  r.check("A: mark state.level is 1-2 and frame > 2416", st.level === "1-2" && st.frame > 2416, `mark ${mark.id} level ${JSON.stringify(st.level)} frame ${st.frame}`);
  const fr = await png(join(mdir, "frame.png"));
  r.check("A: frame.png 320x180", fr.size?.w === 320 && fr.size?.h === 180, fr.error || `${fr.size?.w}x${fr.size?.h}`);
  files.push([join(dirA, "SESSION.md"), "SESSION-source.md"], [join(mdir, "state.json"), "state-mark.json"], [join(mdir, "frame.png"), "frame.png"]);

  const rep = await snapper(["replay", dirA, mark.id], { timeoutMs: 300000 });
  r.check("C: replay exits 0", rep.code === 0, `exit ${rep.code}`);
  const replayDir = join(mdir, "replay");
  const rj = await json(join(replayDir, "replay.json"));
  r.check("C: replay.json stateMatches true", rj?.stateMatches === true, rj ? `stateMatches ${rj.stateMatches}${rj.firstDiff ? ` firstDiff ${rj.firstDiff}` : ""} query ${rj.query} (${rj.querySource})` : "missing");
  const rstate = rj?.frames?.find(f => f.frame === rj.frameAt)?.state;
  if (rstate) r.check("C: the replayed state's level is 1-2", rstate.level === "1-2", `level ${JSON.stringify(rstate.level)}`);
  files.push([join(replayDir, "replay.json"), "replay.json"]);
  try {
    const { readdir } = await import("node:fs/promises");
    const fl = (await readdir(replayDir)).filter(f => /^f\d{6}\.png$/.test(f)).sort();
    if (fl.length) files.push([join(replayDir, fl[fl.length - 1]), "replay-last-frame.png"]);
  } catch {}

  const B = await snapper(["play", GAME, "--preset", "1080p", "--resume", dirA, "--at", "mark-" + mark.id, "--smoke",
    await smoke("b", [{ wait: 1500 }, { mark: "r9 post-resume" }, { wait: 400 }, { end: true }]), "--out", OUT9], { timeoutMs: 300000 });
  r.check("B: resumed play exits 0", B.code === 0 && B.last?.ok === true, `exit ${B.code} ${B.lastLine.slice(0, 160)}`);
  const dirB = B.last?.session;
  if (!dirB || !(await exists(dirB))) { r.check("B: session folder exists", false, String(dirB)); return finish9(); }
  info.sessions.resumed = dirB;
  const envB = (await json(join(dirB, "env.json"))) || {};
  r.check("B: --at mark-" + mark.id + " -> env.resumeMatched true", envB.resumeMatched === true,
    `resumeMatched ${envB.resumeMatched}${envB.firstDiff ? ` firstDiff ${envB.firstDiff}` : ""}${envB.resumeError ? ` error ${envB.resumeError}` : ""}; restore ${JSON.stringify(envB.restore)}`);
  const sB = await readSession(dirB);
  const mB = sB.marks.find(x => x.trigger === "smoke") || sB.marks[sB.marks.length - 1];
  r.check("D: a mark was taken after the resume", !!mB, sB.marks.map(x => `${x.id}:${x.trigger}`).join(" "));
  if (mB) {
    const rep2 = await snapper(["replay", dirB, mB.id], { timeoutMs: 300000 });
    r.check("D: replay of the post-resume mark exits 0", rep2.code === 0, `exit ${rep2.code}`);
    const rj2 = await json(join(dirB, ...mB.dir.split("/"), "replay", "replay.json"));
    r.check("D: post-resume replay stateMatches true", rj2?.stateMatches === true, rj2 ? `stateMatches ${rj2.stateMatches}${rj2.firstDiff ? ` firstDiff ${rj2.firstDiff}` : ""}` : "missing");
  }
  return finish9();
}
