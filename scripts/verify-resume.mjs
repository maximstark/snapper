// R2 — save states and resume on the demo (D-021). Five phases in the Electron host:
//   A  play, save with F6 (hotkey "save"), mark, close → checkpoints 0001, mark-0001, exit
//   B  --resume <A> --at exit → restored and compared, tape carries the source inputs, replay of a post-resume mark
//   C  --resume <A> --at 0001      D  --resume <A> --at mark-0001      E  --resume last (newest with states)
// Evidence → private/evidence/v1.1.1/r2/.
//   F  (D-022) navigate mid-session; a mark after it restores and replays with the segment query
//   node scripts/verify-resume.mjs [--out <dir>] (EVIDENCE=1 writes private/evidence)
import { join, basename } from "node:path";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { readSession, readTape, listCheckpoints, readCheckpoint, isFrameLine, pickSegment } from "../packages/core/index.mjs";
import { REPO, snapper, checklist, json, evidence, exists, EVIDENCE_ON, evidenceDir } from "./lib.mjs";

const argv = process.argv.slice(2);
const OUT = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : join(REPO, "sessions", "r2");
const GAME = "examples/demo";
const TIMEOUT = 240000;
const c = checklist("R2 save states and resume (demo)");
const sessions = {};

await mkdir(join(REPO, "sessions"), { recursive: true });
async function smokeFile(name, steps) {
  const p = join(REPO, "sessions", `r2-smoke-${name}.json`);
  await writeFile(p, JSON.stringify(steps, null, 2) + "\n");
  return p;
}
const finish = async ok => {
  const done = c.report();
  if (EVIDENCE_ON) {
    await writeEvidence(ok && done);
  }
  process.exit(ok && done ? 0 : 1);
};

let evidenceFiles = [];
async function writeEvidence(ok) {
  const dir = evidenceDir("v1.1.1", "r2");
  const files = [...evidenceFiles];
  if (sessions.A && sessions.B) {
    const tape = await readFile(join(sessions.B, "tape.jsonl"), "utf8").catch(() => "");
    const head = join(REPO, "sessions", "r2-tape-resumed-head.jsonl");
    await writeFile(head, tape.split(/\r?\n/).slice(0, 40).join("\n") + "\n");
    files.push([head, "tape-resumed-head.jsonl"]);
  }
  const ev = await evidence("r2", files, "v1.1.1");
  await writeFile(join(dir, "checks.json"),
    JSON.stringify({ gate: "R2", date: new Date().toISOString(), sessions, ok, checks: c.items }, null, 2) + "\n");
  process.stdout.write(`evidence: ${ev.length + 1} files in private/evidence/v1.1.1/r2/\n`);
}

/** Run `play` and return { dir, run }; checks exit code and the result JSON. */
async function play(label, args) {
  const run = await snapper(["play", GAME, ...args, "--out", OUT], { timeoutMs: TIMEOUT });
  c.check(`${label}: play exits 0 and the result JSON is ok`, run.code === 0 && run.last?.ok === true, `exit ${run.code} ${run.lastLine.slice(0, 160)}`);
  const dir = run.last?.session;
  if (!dir || !(await exists(dir))) { c.check(`${label}: session folder exists`, false, String(dir)); return { dir: null, run }; }
  process.stdout.write(`${label} session: ${dir}\n`);
  return { dir, run };
}

// ---- Phase A: the source session
const stepsA = [
  { wait: 2500 }, { keys: ["KeyD", "Space"], hold: 900 }, { wait: 300 }, { hotkey: "save" }, { wait: 300 },
  { keys: ["KeyA"], hold: 500 }, { mark: "r2 mark before exit" }, { wait: 400 }, { keys: ["KeyD"], hold: 400 }, { wait: 300 }, { end: true },
];
const A = await play("A", ["--smoke", await smokeFile("a", stepsA)]);
if (!A.dir) await finish(false);
sessions.A = A.dir;
const idA = basename(A.dir);
const cpOf = {};
for (const name of ["0001", "mark-0001", "exit"]) {
  cpOf[name] = await readCheckpoint(A.dir, name);
  c.check(`A: checkpoints/${name}.json exists, restorable, integer frame`,
    cpOf[name] && cpOf[name].restorable === true && Number.isInteger(cpOf[name].frame) && cpOf[name].frame >= 0,
    cpOf[name] ? `frame ${cpOf[name].frame} restorable ${cpOf[name].restorable} ${cpOf[name].reason || ""}` : "missing");
}
const fr = n => cpOf[n]?.frame;
c.check("A: exit frame >= mark frame >= 0001 frame", fr("exit") >= fr("mark-0001") && fr("mark-0001") >= fr("0001"),
  `exit ${fr("exit")} mark ${fr("mark-0001")} 0001 ${fr("0001")}`);
const sA = await readSession(A.dir);
c.check("A: three checkpoint lines in session.jsonl", sA.checkpoints.length === 3, sA.checkpoints.map(l => `${l.name}@${l.frame}`).join(" "));
const listA = await listCheckpoints(A.dir);
c.check("A: listCheckpoints sees 0001, mark-0001, exit (all restorable)",
  listA.length === 3 && listA.every(x => x.restorable) && ["0001", "mark-0001", "exit"].every(n => listA.some(x => x.name === n)),
  listA.map(x => x.name).join(","));
const mdA = await readFile(join(A.dir, "SESSION.md"), "utf8").catch(() => "");
c.check("A: SESSION.md header shows `states 3 (exit @ frame N)`", mdA.includes(`states 3 (exit @ frame ${fr("exit")})`));
evidenceFiles.push([join(A.dir, "SESSION.md"), "SESSION-source.md"], [join(A.dir, "checkpoints", "exit.json"), "exit.json"]);
if (!cpOf.exit || !Number.isInteger(fr("exit"))) await finish(false);

// ---- Phase B: resume at exit
const stepsB = [{ wait: 1000 }, { keys: ["KeyD"], hold: 700 }, { mark: "r2 after resume" }, { wait: 300 }, { end: true }];
const B = await play("B", ["--resume", A.dir, "--at", "exit", "--smoke", await smokeFile("b", stepsB)]);
if (!B.dir) await finish(false);
sessions.B = B.dir;
const envB = (await json(join(B.dir, "env.json"))) || {};
c.check("B: env.resumedFrom is the source session, checkpoint exit, exit frame",
  envB.resumedFrom?.session === idA && envB.resumedFrom?.checkpoint === "exit" && envB.resumedFrom?.frame === fr("exit"), JSON.stringify(envB.resumedFrom));
c.check("B: env.resumeMatched === true", envB.resumeMatched === true, `resumeMatched ${envB.resumeMatched}${envB.firstDiff ? ` firstDiff ${envB.firstDiff}` : ""}${envB.resumeError ? ` error ${envB.resumeError}` : ""}`);
c.check("B: env.restore.fps is a number", typeof envB.restore?.fps === "number", `restore ${JSON.stringify(envB.restore)}`);
process.stdout.write(`B restore: ${envB.restore?.frames} frames in ${envB.restore?.ms} ms = ${envB.restore?.fps} frames/s (${envB.restore?.chunks} chunks)\n`);
const sB = await readSession(B.dir);
const sessLine = sB.lines.find(l => l.kind === "session");
c.check("B: the session line carries resumedFrom", sessLine?.resumedFrom?.session === idA && sessLine?.resumedFrom?.checkpoint === "exit", JSON.stringify(sessLine?.resumedFrom));
c.check("B: a resume line with matched true", sB.resume?.matched === true && sB.resume?.from === `${idA}/exit`, JSON.stringify(sB.resume));

const tapeA = await readTape(A.dir);
const tapeB = await readTape(B.dir);
c.check("B: tape.jsonl starts with the header", tapeB.header?.kind === "tape", JSON.stringify(tapeB.header));
const segA = pickSegment(tapeA.lines, cpOf.exit.segment, cpOf.exit.t);
const expectFrames = segA.lines.filter(l => isFrameLine(l) && l.f <= fr("exit")).map(l => ({ f: l.f, m: l.m }));
const markerAt = tapeB.lines.findIndex(l => l.ev === "resume" && l.f === fr("exit") && l.from === `${idA}/exit`);
c.check("B: tape has the resume marker {f:frame, ev:resume, from:<A>/exit}", markerAt >= 0, markerAt >= 0 ? JSON.stringify(tapeB.lines[markerAt]) : "missing");
const gotFrames = tapeB.lines.slice(0, Math.max(markerAt, 0)).filter(isFrameLine).map(l => ({ f: l.f, m: l.m }));
c.check("B: tape frame lines before the marker equal the source's (f <= frame)", expectFrames.length > 0 && JSON.stringify(gotFrames) === JSON.stringify(expectFrames),
  `source ${expectFrames.length} lines, resumed ${gotFrames.length} lines`);
const mdB = await readFile(join(B.dir, "SESSION.md"), "utf8").catch(() => "");
c.check("B: SESSION.md says `resumed from <A>/exit @ frame N (matched)`", mdB.includes(`resumed from ${idA}/exit @ frame ${fr("exit")} (matched)`));

const mB = sB.marks.find(m => m.trigger === "smoke") || sB.marks[sB.marks.length - 1];
let replayDir = null;
c.check("B: a mark was taken after the resume", !!mB, sB.marks.map(m => `${m.id}:${m.trigger}`).join(" "));
if (mB) {
  const rep = await snapper(["replay", B.dir, mB.id], { timeoutMs: TIMEOUT });
  c.check("B: replay of the after-resume mark exits 0", rep.code === 0, `exit ${rep.code}`);
  replayDir = join(B.dir, ...mB.dir.split("/"), "replay");
  const rj = await json(join(replayDir, "replay.json"));
  c.check("B: replay.json stateMatches: true", rj?.stateMatches === true, rj ? `stateMatches ${rj.stateMatches}${rj.firstDiff ? ` firstDiff ${rj.firstDiff}` : ""}` : "missing");
}
evidenceFiles.push([join(B.dir, "SESSION.md"), "SESSION-resumed.md"], ...(replayDir ? [[join(replayDir, "replay.md"), "replay.md"]] : []));

// ---- Phase C / D: resume at a manual state and at a mark state
const stepsShort = [{ wait: 800 }, { end: true }];
const C = await play("C", ["--resume", A.dir, "--at", "0001", "--smoke", await smokeFile("short", stepsShort)]);
if (C.dir) {
  sessions.C = C.dir;
  const e = (await json(join(C.dir, "env.json"))) || {};
  c.check("C: --at 0001 → resumeMatched true, resumedFrom.frame = the 0001 frame",
    e.resumeMatched === true && e.resumedFrom?.checkpoint === "0001" && e.resumedFrom?.frame === fr("0001"),
    `matched ${e.resumeMatched} from ${JSON.stringify(e.resumedFrom)}${e.firstDiff ? ` firstDiff ${e.firstDiff}` : ""}${e.resumeError ? ` error ${e.resumeError}` : ""}`);
}
const D = await play("D", ["--resume", A.dir, "--at", "mark-0001", "--smoke", await smokeFile("short", stepsShort)]);
if (D.dir) {
  sessions.D = D.dir;
  const e = (await json(join(D.dir, "env.json"))) || {};
  c.check("D: --at mark-0001 → resumeMatched true, resumedFrom.frame = the mark frame",
    e.resumeMatched === true && e.resumedFrom?.checkpoint === "mark-0001" && e.resumedFrom?.frame === fr("mark-0001"),
    `matched ${e.resumeMatched} from ${JSON.stringify(e.resumedFrom)}${e.firstDiff ? ` firstDiff ${e.firstDiff}` : ""}${e.resumeError ? ` error ${e.resumeError}` : ""}`);
}

// ---- Phase E: --resume last picks the newest session that has states (D wrote an exit state too)
const E = await play("E", ["--resume", "last", "--smoke", await smokeFile("e", [{ wait: 500 }, { end: true }])]);
if (E.dir) {
  sessions.E = E.dir;
  const e = (await json(join(E.dir, "env.json"))) || {};
  const want = D.dir ? basename(D.dir) : "(no D session)";
  c.check("E: --resume last resumes the newest session with states (D)", e.resumedFrom?.session === want && e.resumeMatched === true,
    `from ${JSON.stringify(e.resumedFrom)} want ${want} matched ${e.resumeMatched}`);
}

// ---- Phase F (D-022): a navigation mid-session; a mark after it restores and replays with the segment's query
const stepsF = [
  { wait: 2500 }, { keys: ["KeyD", "Space"], hold: 700 }, { mark: "f segment 0" }, { wait: 300 },
  { navigate: "?seed=2" }, { wait: 800 }, { keys: ["KeyD"], hold: 600 }, { keys: ["KeyA"], hold: 300 }, { mark: "f segment 1" }, { wait: 300 }, { end: true },
];
const F = await play("F", ["--smoke", await smokeFile("f", stepsF)]);
if (F.dir) {
  sessions.F = F.dir;
  const sF = await readSession(F.dir);
  const tapeF = await readTape(F.dir);
  const relS = sF.lines.find(l => l.kind === "reload");
  const relT = tapeF.lines.find(l => l.ev === "reload");
  c.check("F: session.jsonl reload line carries query ?seed=2 and a url", relS?.query === "?seed=2" && /seed=2/.test(relS?.url || ""), JSON.stringify(relS));
  c.check("F: tape.jsonl reload marker carries query ?seed=2 and a url", relT?.query === "?seed=2" && /seed=2/.test(relT?.url || ""), JSON.stringify(relT));
  const marksF = sF.marks.filter(m => m.trigger === "smoke");
  c.check("F: two smoke marks, one per segment", marksF.length === 2, marksF.map(m => m.id).join(","));
  const m2 = marksF[1];
  if (m2) {
    const G = await play("F-resume", ["--resume", F.dir, "--at", "mark-" + m2.id, "--smoke", await smokeFile("short", stepsShort)]);
    if (G.dir) {
      sessions.FR = G.dir;
      const e = (await json(join(G.dir, "env.json"))) || {};
      const rl = (await readSession(G.dir)).resume;
      c.check("F: --at mark-" + m2.id + " boots the segment's query: env.game.query ?seed=2, resumeMatched true",
        e.resumeMatched === true && e.game?.query === "?seed=2" && !e.game?.queryOverride,
        `matched ${e.resumeMatched} query ${JSON.stringify(e.game?.query)}${e.firstDiff ? ` firstDiff ${e.firstDiff}` : ""}${e.resumeError ? ` error ${e.resumeError}` : ""}`);
      c.check("F: the resume line carries query ?seed=2 (no queryOverride)", rl?.query === "?seed=2" && rl?.queryOverride === undefined, JSON.stringify(rl));
      evidenceFiles.push([join(G.dir, "SESSION.md"), "SESSION-segquery-resumed.md"]);
    }
    const O = await play("F-override", ["--resume", F.dir, "--at", "mark-" + m2.id, "--query", "?seed=3", "--smoke", await smokeFile("short", stepsShort)]);
    if (O.dir) {
      sessions.FO = O.dir;
      const e = (await json(join(O.dir, "env.json"))) || {};
      const rl = (await readSession(O.dir)).resume;
      c.check("F: --query ?seed=3 with --resume is accepted as an override: queryOverride true in env and resume line, warned",
        e.game?.query === "?seed=3" && e.game?.queryOverride === true && rl?.queryOverride === true && rl?.query === "?seed=3" && /overrides the segment query/.test(O.run.stderr),
        `query ${JSON.stringify(e.game?.query)} override ${e.game?.queryOverride}/${rl?.queryOverride} matched ${e.resumeMatched} firstDiff ${e.firstDiff}`);
      c.check("F: a wrong override is caught by the state compare (resumeMatched false)", e.resumeMatched === false, `matched ${e.resumeMatched} firstDiff ${e.firstDiff}`);
    }
    const rep = await snapper(["replay", F.dir, m2.id], { timeoutMs: TIMEOUT });
    c.check("F: replay of the segment-1 mark exits 0", rep.code === 0, `exit ${rep.code}`);
    const repDir = join(F.dir, ...m2.dir.split("/"), "replay");
    const rj = await json(join(repDir, "replay.json"));
    c.check("F: replay stateMatches true, booted with ?seed=2 from the segment marker",
      rj?.stateMatches === true && rj?.query === "?seed=2" && rj?.querySource === "marker",
      rj ? `stateMatches ${rj.stateMatches} query ${rj.query} (${rj.querySource})${rj.firstDiff ? ` firstDiff ${rj.firstDiff}` : ""}` : "missing");
    const rep0 = await snapper(["replay", F.dir, m2.id, "--query", "?seed=3", "--before", "5", "--after", "5", "--out", join(F.dir, "replay-override")], { timeoutMs: TIMEOUT });
    const rj0 = await json(join(F.dir, "replay-override", "replay.json"));
    c.check("F: replay --query ?seed=3 overrides (querySource override) and the wrong query shows stateMatches false",
      rep0.code === 0 && rj0?.querySource === "override" && rj0?.stateMatches === false, rj0 ? `query ${rj0.query} (${rj0.querySource}) stateMatches ${rj0.stateMatches} firstDiff ${rj0.firstDiff}` : "missing");
    evidenceFiles.push([join(repDir, "replay.md"), "replay-segquery.md"]);
  }
}

await finish(true);
