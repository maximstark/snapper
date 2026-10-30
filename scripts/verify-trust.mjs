// Y5 — trust A/B (BRIEF-v1.3 §2.4, §7): what the ring buffer / overlay cost. The demo and a second game (--game) are played with a
// fixed smoke (20 s of inputs, a mark at the end of each 10 s half so two perf.json windows cover the 20 s, no fault keys),
// ring on vs --bare, three runs each, alternating order (on, bare, on, bare, ...). Per run: the mean / max / p95 / drops of
// perf.json intervalsMs over both marks, and the mean markCaptureMs; then the means per condition and the differences
// (ring minus bare). The smoke is never tuned to hide a cost: whatever the numbers say is what gets written.
// Also asserts: bare sessions have env.json host.bare true and no before/ folder in any mark; ring sessions have before/sheet.png.
//   node scripts/verify-trust.mjs [--runs 3] [--game <game root> [--query "?level=1"]] [--only demo|game2]
//   EVIDENCE=1 writes private/evidence/<EVIDENCE_VERSION or v1.3>/y5/ (ab.json, ab.md, one bare SESSION.md; no images)
import { join } from "node:path";
import { readFile, writeFile, mkdir, rm, readdir, copyFile } from "node:fs/promises";
import { perfStats, readSession } from "../packages/core/index.mjs";
import { REPO, snapper, checklist, exists, EVIDENCE_ON, evidenceDir } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const RUNS = Number(opt("--runs", 3));
const GAME = opt("--game", null);
const GAME_QUERY = opt("--query", "");
const ONLY = opt("--only", null);
const Y5 = join(REPO, "sessions", "y5");
const c = checklist("Y5 trust A/B (ring vs --bare)");

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const json = async p => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } };

/** The fixed smoke: D (then A) held with a Space tap every ~0.75 s; a mark closes each half. */
function smokeSteps() {
  const steps = [{ wait: 2500 }, { down: "KeyD" }];
  for (let i = 0; i < 13; i++) steps.push({ key: "Space", ms: 120 }, { wait: 630 });
  steps.push({ mark: "half 1" }, { up: "KeyD" }, { down: "KeyA" });
  for (let i = 0; i < 14; i++) steps.push({ key: "Space", ms: 120 }, { wait: 630 });
  steps.push({ mark: "half 2" }, { up: "KeyA" }, { wait: 400 }, { end: true });
  return steps;
}

async function measure(dir, bare) {
  const s = await readSession(dir);
  const env = await json(join(dir, "env.json"));
  const ids = s.marks.map(m => m.id);
  const intervals = [];
  let drops = 0, expectedMs = null, ringFrames = [], ringFps = [];
  const capture = [];
  let hostBare = null, beforeDirs = 0, sheets = 0;
  for (const m of s.marks) {
    const mdir = join(dir, ...m.dir.split("/"));
    const perf = await json(join(mdir, "perf.json"));
    if (!perf) continue;
    intervals.push(...perf.intervalsMs);
    drops += perf.drops;
    expectedMs = perf.expectedMs;
    if (perf.host) {
      hostBare = perf.host.bare;
      ringFrames.push(perf.host.ringFrames);
      ringFps.push(perf.host.ringFps);
      capture.push(perf.host.markCaptureMs[m.id]);
    }
    if (await exists(join(mdir, "before"))) beforeDirs++;
    if (await exists(join(mdir, "before", "sheet.png"))) sheets++;
  }
  const st = perfStats(intervals, expectedMs || 1000 / 60);
  return {
    session: dir, marks: ids.length, samples: intervals.length, expectedMs,
    avgMs: r2(mean(intervals)), maxMs: st.max, p95Ms: st.p95, drops,
    markCaptureMsMean: r2(mean(capture)), markCaptureMs: capture,
    ringFramesMax: ringFrames.length ? Math.max(...ringFrames) : null, ringFpsMean: r2(mean(ringFps)),
    envHostBare: env?.host?.bare ?? null, perfHostBare: hostBare, beforeDirs, sheets,
    hz: env?.display?.hz ?? null, bareMarker: (await readFile(join(dir, "SESSION.md"), "utf8").catch(() => "")).split("\n")[1]?.includes(" bare") ?? false,
  };
}

async function target(name, gameArgs) {
  const smoke = join(Y5, `smoke-${name}.json`);
  await writeFile(smoke, JSON.stringify(smokeSteps(), null, 2) + "\n");
  const runs = [];
  for (let i = 0; i < RUNS * 2; i++) {
    const bare = i % 2 === 1;                          // on, bare, on, bare, ...
    const label = `${name} ${bare ? "bare" : "ring"} #${Math.floor(i / 2) + 1}`;
    const out = join(Y5, name, bare ? "bare" : "ring");
    const res = await snapper(["play", ...gameArgs, ...(bare ? ["--bare"] : []), "--smoke", smoke, "--out", out], { timeoutMs: 300000, echo: false });
    const ok = res.code === 0 && res.last?.ok === true && res.last?.marks === 2;
    c.check(`${label}: play ok, 2 marks`, ok, ok ? res.last.session : `exit ${res.code} ${res.lastLine.slice(0, 160)}`);
    if (!res.last?.session) continue;
    const m = await measure(res.last.session, bare);
    m.condition = bare ? "bare" : "ring";
    m.n = Math.floor(i / 2) + 1;
    m.order = i + 1;
    c.check(`${label}: env.json host.bare is ${bare}, perf.json host.bare is ${bare}`, m.envHostBare === bare && m.perfHostBare === bare, `env ${m.envHostBare} perf ${m.perfHostBare}`);
    if (bare) {
      c.check(`${label}: no before/ folder in any mark; SESSION.md line 2 shows bare`, m.beforeDirs === 0 && m.bareMarker, `before/ in ${m.beforeDirs} of ${m.marks} marks, marker ${m.bareMarker}`);
      c.check(`${label}: ringFrames 0`, m.ringFramesMax === 0);
    } else {
      c.check(`${label}: before/sheet.png in every mark`, m.sheets === m.marks && m.marks === 2, `${m.sheets} of ${m.marks}`);
    }
    process.stdout.write(`   ${label}: avg ${m.avgMs} ms · max ${m.maxMs} · p95 ${m.p95Ms} · drops ${m.drops} · capture ${m.markCaptureMsMean} ms · ${m.samples} samples\n`);
    runs.push(m);
  }
  const cond = k => {
    const rs = runs.filter(r => r.condition === k);
    return {
      runs: rs.length,
      avgMs: r2(mean(rs.map(r => r.avgMs))), maxMs: r2(mean(rs.map(r => r.maxMs))), p95Ms: r2(mean(rs.map(r => r.p95Ms))),
      drops: r2(mean(rs.map(r => r.drops))), markCaptureMs: r2(mean(rs.map(r => r.markCaptureMsMean))),
      ringFpsMean: r2(mean(rs.map(r => r.ringFpsMean))),
    };
  };
  const ring = cond("ring"), bare = cond("bare");
  const diff = {};
  for (const k of ["avgMs", "maxMs", "p95Ms", "drops", "markCaptureMs"]) diff[k] = r2(ring[k] - bare[k]);
  return { name, runs, ring, bare, diff, hz: runs[0]?.hz ?? null };
}

await rm(Y5, { recursive: true, force: true });
await mkdir(Y5, { recursive: true });
const results = [];
if (!ONLY || ONLY === "demo") results.push(await target("demo", [join(REPO, "examples", "demo")]));
if (!ONLY || ONLY === "game2") {
  if (!GAME) process.stdout.write("second-game target skipped (no --game <path>)\n");
  else if (!(await exists(GAME))) c.check("second game root exists", false, GAME);
  else results.push(await target("game2", [GAME, "--preset", "1080p", ...(GAME_QUERY ? ["--query", GAME_QUERY] : [])]));
}

// ------------------------------------------------------------------------------------------------ the table
const f = x => (x === null || x === undefined ? "–" : String(x));
const sgn = x => (x === null ? "–" : (x > 0 ? "+" : "") + x);
const md = [`# Y5 trust A/B: ring buffer on vs \`--bare\``, "",
  `Generated ${new Date().toISOString()} by scripts/verify-trust.mjs. ${RUNS} runs per condition, alternating order (ring, bare, ring, bare, ...). `
  + "Each run: 20 s of scripted input, a mark at the end of each 10 s half; the numbers are over both marks' perf.json windows (20 s of rAF intervals). "
  + "`--bare` removes the screencast ring buffer, the overlay chip with its 250 ms timer and the 500 ms status poll; the SDK's ticks, the rAF interval recorder, the pad poll and the 250 ms input flush run in both.", ""];
for (const t of results) {
  md.push(`## ${t.name}${t.hz ? ` (display ${t.hz} Hz)` : ""}`, "",
    "| run | condition | avg interval ms | max ms | p95 ms | drops | mark capture ms (mean) | samples |", "|---|---|---|---|---|---|---|---|");
  for (const r of t.runs) md.push(`| ${r.order} | ${r.condition} #${r.n} | ${f(r.avgMs)} | ${f(r.maxMs)} | ${f(r.p95Ms)} | ${r.drops} | ${f(r.markCaptureMsMean)} | ${r.samples} |`);
  md.push("", "| | avg interval ms | max ms | p95 ms | drops | mark capture ms |", "|---|---|---|---|---|---|");
  for (const k of ["ring", "bare"]) md.push(`| mean, ${k} (${t[k].runs} runs) | ${f(t[k].avgMs)} | ${f(t[k].maxMs)} | ${f(t[k].p95Ms)} | ${f(t[k].drops)} | ${f(t[k].markCaptureMs)} |`);
  md.push(`| **ring minus bare** | ${sgn(t.diff.avgMs)} | ${sgn(t.diff.maxMs)} | ${sgn(t.diff.p95Ms)} | ${sgn(t.diff.drops)} | ${sgn(t.diff.markCaptureMs)} |`, "");
}
const mdText = md.join("\n") + "\n";
await writeFile(join(Y5, "ab.md"), mdText);
const abJson = { gate: "Y5", date: new Date().toISOString(), runsPerCondition: RUNS, smoke: smokeSteps(), results };
await writeFile(join(Y5, "ab.json"), JSON.stringify(abJson, null, 2) + "\n");
process.stdout.write("\n" + mdText);

const ok = c.report();
if (EVIDENCE_ON) {
  const dir = evidenceDir("v1.3", "y5");
  await mkdir(dir, { recursive: true });
  await copyFile(join(Y5, "ab.json"), join(dir, "ab.json"));
  await copyFile(join(Y5, "ab.md"), join(dir, "ab.md"));
  const bareRun = results.flatMap(t => t.runs).find(r => r.condition === "bare");
  if (bareRun) await copyFile(join(bareRun.session, "SESSION.md"), join(dir, "SESSION-bare.md"));
  await writeFile(join(dir, "checks.json"), JSON.stringify({ gate: "Y5", date: new Date().toISOString(), ok, checks: c.items }, null, 2) + "\n");
  process.stdout.write(`evidence: files in ${dir}\n`);
}
process.exit(ok ? 0 : 1);
