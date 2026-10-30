// G2 — demo end to end (BRIEF §6). Runs the demo smoke in the Electron host, checks the session
// folder against the gate, replays the smoke mark, copies small evidence to private/evidence/v1.0/g2/.
//   node scripts/verify-demo.mjs [--out <dir>] (EVIDENCE=1 writes private/evidence)
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { readSession, readTape, isFrameLine, isWallLine } from "../packages/core/index.mjs";
import { REPO, snapper, checklist, png, json, evidence, exists, EVIDENCE_ON, evidenceDir } from "./lib.mjs";

const argv = process.argv.slice(2);
const outArg = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : join(REPO, "sessions", "g2");
const c = checklist("G2 demo end to end");

const run = await snapper(["play", "examples/demo", "--smoke", "examples/demo/smoke.json", "--out", outArg]);
c.check("play --smoke exits 0", run.code === 0, `exit ${run.code}`);
c.check("last stdout line is the result JSON with ok:true", run.last && run.last.ok === true, run.lastLine.slice(0, 200));
const dir = run.last?.session;
if (!dir || !(await exists(dir))) {
  c.check("session folder exists", false, String(dir));
  process.exit(c.report() ? 0 : 1);
}
process.stdout.write(`session: ${dir}\n`);

const s = await readSession(dir);
c.check("boot ok", s.boot?.ok === true, JSON.stringify(s.boot));
const r = s.ready || {};
c.check("ready: sdk, state, frame, stepper all true", r.sdk && r.state && r.frame && r.stepper, JSON.stringify(r));
c.check("end line present", !!s.end, JSON.stringify(s.end));
c.check(">= 5 marks", s.marks.length >= 5, `${s.marks.length} marks`);
const byTrigger = {};
for (const m of s.marks) (byTrigger[m.trigger] ||= []).push(m);
for (const t of ["smoke", "error", "exception", "fps", "assert"]) c.check(`a mark with trigger ${t}`, byTrigger[t]?.length > 0, (byTrigger[t] || []).map(m => m.id).join(","));

for (const m of s.marks) {
  const d = join(dir, ...m.dir.split("/"));
  const shot = await png(join(d, "shot.png"));
  c.check(`${m.id} ${m.trigger}: shot.png non-black`, shot.stats && shot.stats.nonBlack > 0.05, shot.error || `${shot.size?.w}×${shot.size?.h} nonBlack ${shot.stats?.nonBlack.toFixed(3)}`);
  const frame = await png(join(d, "frame.png"));
  c.check(`${m.id}: frame.png 320×180`, frame.size?.w === 320 && frame.size?.h === 180, frame.error || `${frame.size?.w}×${frame.size?.h}`);
  c.check(`${m.id}: before/sheet.png + index.json`, (await exists(join(d, "before", "sheet.png"))) && Array.isArray(await json(join(d, "before", "index.json"))));
  const state = await json(join(d, "state.json"));
  c.check(`${m.id}: state.json has frame`, state && Number.isInteger(state.frame), state ? `frame ${state.frame}` : "missing");
  const inputs = await json(join(d, "inputs.json"));
  c.check(`${m.id}: inputs.json has wall and frame lines`, inputs?.wall?.length > 0 && inputs?.frames?.length > 0, `wall ${inputs?.wall?.length} frames ${inputs?.frames?.length}`);
  c.check(`${m.id}: log.json + perf.json present`, (await json(join(d, "log.json"))) != null && (await json(join(d, "perf.json"))) != null);
}
const errMark = byTrigger.error?.[0];
if (errMark) {
  const log = await readFile(join(dir, ...errMark.dir.split("/"), "log.json"), "utf8").catch(() => "");
  c.check("error mark log.json contains the deliberate console.error", log.includes("demo: deliberate console.error"));
}
const fpsMark = byTrigger.fps?.[0];
if (fpsMark) {
  const perf = await json(join(dir, ...fpsMark.dir.split("/"), "perf.json"));
  c.check("fps mark perf.json max >= 250", perf?.max >= 250, `max ${perf?.max}`);
}
const md = await readFile(join(dir, "SESSION.md"), "utf8").catch(() => "");
c.check("SESSION.md per template (header, table, a section per mark)",
  /^# Snapper session \S+ — \S+ @ /.test(md) && md.includes("| # | t | frame | trigger | summary | errors | worst ms |") &&
  s.marks.every(m => md.includes(`## ${m.id} · `)));
const tape = await readTape(dir);
c.check("tape.jsonl: header with keymap", Array.isArray(tape.header?.keymap) && tape.header.keymap.length > 0, JSON.stringify(tape.header));
c.check("tape.jsonl: run-length frame lines", tape.lines.filter(isFrameLine).length >= 2, `${tape.lines.filter(isFrameLine).length} frame lines, ${tape.lines.filter(isWallLine).length} wall lines`);

// replay the smoke mark
const smoke = byTrigger.smoke?.[0];
let replayDir = null;
if (smoke) {
  const rep = await snapper(["replay", dir, smoke.id]);
  c.check("replay exits 0", rep.code === 0, `exit ${rep.code}`);
  replayDir = join(dir, ...smoke.dir.split("/"), "replay");
  const rj = await json(join(replayDir, "replay.json"));
  c.check("replay.json stateMatches: true", rj?.stateMatches === true, rj ? `stateMatches ${rj.stateMatches}${rj.firstDiff ? ` firstDiff ${rj.firstDiff}` : ""} chromium ${rj.chromium}` : "missing");
  c.check("replay sheet.png + replay.md", (await exists(join(replayDir, "sheet.png"))) && (await exists(join(replayDir, "replay.md"))));
  const fr = rj?.frames?.length ? await png(join(replayDir, `f${String(smoke.frame).padStart(6, "0")}.png`)) : {};
  c.check("replay frame png at the mark frame", fr.size?.w === 320, fr.error || `${fr.size?.w}×${fr.size?.h}`);
}

const ok = c.report();
if (EVIDENCE_ON) {
  const fm = smoke || s.marks[0];
  const md0 = fm ? join(dir, ...fm.dir.split("/")) : dir;
  const ev = await evidence("g2", [
    [join(dir, "SESSION.md"), "SESSION.md"],
    [join(md0, "shot.png"), `shot-${fm?.id}.png`],
    [join(md0, "frame.png"), `frame-${fm?.id}.png`],
    [join(md0, "before", "sheet.png"), `before-sheet-${fm?.id}.png`],
    ...(replayDir ? [[join(replayDir, "replay.md"), "replay.md"], [join(replayDir, "sheet.png"), "replay-sheet.png"]] : []),
    ...(fpsMark ? [[join(dir, ...fpsMark.dir.split("/"), "perf.json"), `perf-${fpsMark.id}-fps.json`]] : []),
  ]);
  await (await import("node:fs/promises")).writeFile(join(evidenceDir("v1.0", "g2"), "checks.json"),
    JSON.stringify({ gate: "G2", date: new Date().toISOString(), session: dir, ok, checks: c.items }, null, 2) + "\n");
  process.stdout.write(`evidence: ${ev.length + 1} files in private/evidence/v1.0/g2/\n`);
}
process.exit(ok ? 0 : 1);
