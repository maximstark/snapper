// Z3 — attach mode (BRIEF-v1.4 §2.8, §7). `snapper attach` against a browser we did not launch with Snapper:
//   (a) a second Electron (the repo's binary, tests/fixtures/attach-target/main.mjs) showing examples/demo from a static
//       server with --remote-debugging-port; attach with --game-root examples/demo and a smoke that holds KeyD, taps Space,
//       marks three times and presses the in-page mark hotkey (F8) and types a note; session shape, then `replay 0001`;
//   (b) the same against Microsoft Edge headless (when installed), browser version recorded;
//   (c) --no-reload: marks exist, none replayable, SESSION.md says so, replay refuses (exit 2);
//   (d) --bare under attach: no Page.startScreencast (no before/ folder), host.bare true.
// Also records, per run, perf.json host.hideRoundTripMs and markCaptureMs, and the same two numbers from one play-mode run of the
// same smoke, for TRUST.md.
//   node scripts/verify-attach.mjs [--out <dir>]   (EVIDENCE=1 also writes small files to private/evidence/v1.4/z3/)
// Always writes <out>/checks.json and <out>/numbers.json (default sessions/w1/z3).
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readSession, readTape, serveStatic, isFrameLine, isWallLine } from "../packages/core/index.mjs";
import { wsBackend, listTargets } from "../packages/host/main/cdp.mjs";
import { startElectronTarget, startEdgeTarget, EDGE_EXE } from "../tests/fixtures/attach-target/start.mjs";
import { REPO, snapper, checklist, png, json, exists, evidence, EVIDENCE_ON, evidenceDir } from "./lib.mjs";

const argv = process.argv.slice(2);
const OUT = argv.includes("--out") ? join(REPO, argv[argv.indexOf("--out") + 1]) : join(REPO, "sessions", "w1", "z3");
const SMOKE = join(REPO, "tests", "fixtures", "attach-target", "smoke.json");
const PASSIVE = join(REPO, "tests", "fixtures", "attach-target", "smoke-passive.json");
const DEMO = join(REPO, "examples", "demo");
let URL_ = null;                                   // the page under test (set once the static server is up)
const c = checklist("Z3 attach mode");
const numbers = { gate: "Z3", at: new Date().toISOString(), runs: {} };
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const stat = a => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return { n: a.length, min: s[0], median: s[s.length >> 1], mean: Math.round((a.reduce((p, q) => p + q, 0) / a.length) * 10) / 10, max: s[s.length - 1] };
};

/** hideRoundTripMs and markCaptureMs of every mark of a session. */
async function markNumbers(dir, s) {
  const hide = [], capture = [];
  for (const m of s.marks) {
    const perf = await json(join(dir, ...m.dir.split("/"), "perf.json"));
    if (typeof perf?.host?.hideRoundTripMs === "number") hide.push(perf.host.hideRoundTripMs);
    const cap = perf?.host?.markCaptureMs?.[m.id];
    if (typeof cap === "number") capture.push(cap);
  }
  return { hideRoundTripMs: stat(hide), markCaptureMs: stat(capture), hideAll: hide, captureAll: capture };
}

/** attach to `t`, with SNAPPER_DEBUG on so the host logs every CDP method it sends (stderr). */
async function attach(t, extra, out) {
  process.env.SNAPPER_DEBUG = "1";
  try { return await snapper(["attach", t.endpoint, "--target", URL_, "--out", out, ...extra], { timeoutMs: 150000, echo: false }); }   // --target: a browser may hold more than one page (Edge opens extras sometimes)
  finally { delete process.env.SNAPPER_DEBUG; }
}
const sent = run => new Set([...run.stderr.matchAll(/\[dbg\] cdp> (\S+)/g)].map(m => m[1]));

/** The checks every attach session must pass. */
async function sessionShape(label, run, { reloaded = true, bare = false, marksMin = 1, adapterBrowser = null } = {}) {
  c.check(`${label}: attach exits 0 with ok:true`, run.code === 0 && run.last?.ok === true, `exit ${run.code} ${run.lastLine.slice(0, 160)}`);
  const dir = run.last?.session;
  if (!dir || !(await exists(dir))) { c.check(`${label}: session folder exists`, false, String(dir)); return null; }
  const s = await readSession(dir);
  const env = await json(join(dir, "env.json"));
  c.check(`${label}: >= ${marksMin} mark(s)`, s.marks.length >= marksMin, `${s.marks.length} marks`);
  c.check(`${label}: env host.adapter "cdp", host.attach.reloaded ${reloaded}`, env?.host?.adapter === "cdp" && env.host.attach?.reloaded === reloaded, JSON.stringify(env?.host?.attach?.reloaded));
  c.check(`${label}: env host.attach has endpoint, target, browser, userAgent`,
    /^http:\/\/127\.0\.0\.1:\d+$/.test(env?.host?.attach?.endpoint || "") && env.host.attach.target?.url && /\//.test(env.host.attach.browser || "") && env.host.attach.userAgent,
    `${env?.host?.attach?.browser} ${env?.host?.attach?.target?.url}`);
  c.check(`${label}: env host.chromium, gpu null, display and window from the page`,
    env?.host?.chromium && env.gpu === null && env.display?.dpr > 0 && env.window?.w > 0 && env.window?.h > 0 && env.game?.root === DEMO,
    `chromium ${env?.host?.chromium} display ${JSON.stringify(env?.display)} window ${JSON.stringify(env?.window)}`);
  c.check(`${label}: host.bare ${bare}`, env?.host?.bare === bare, String(env?.host?.bare));
  if (adapterBrowser) c.check(`${label}: recorded browser matches the one started (${adapterBrowser})`, env?.host?.attach?.browser === adapterBrowser, env?.host?.attach?.browser);
  c.check(`${label}: boot ok, end line`, s.boot?.ok === true && !!s.end, JSON.stringify(s.boot));
  return { dir, s, env };
}

async function markShape(label, dir, s, { bare = false } = {}) {
  for (const m of s.marks) {
    const d = join(dir, ...m.dir.split("/"));
    const shot = await png(join(d, "shot.png"));
    c.check(`${label} ${m.id} ${m.trigger}: shot.png non-black`, shot.stats && shot.stats.nonBlack > 0.05 && shot.stats.distinct > 2, shot.error || `${shot.size?.w}×${shot.size?.h} nonBlack ${shot.stats?.nonBlack.toFixed(3)}`);
    const state = await json(join(d, "state.json"));
    c.check(`${label} ${m.id}: state.json from the SDK (frame, player)`, state && Number.isInteger(state.frame) && state.player !== undefined, state ? `frame ${state.frame}` : "missing");
    const frame = await png(join(d, "frame.png"));
    c.check(`${label} ${m.id}: frame.png 320×180`, frame.size?.w === 320 && frame.size?.h === 180, frame.error || `${frame.size?.w}×${frame.size?.h}`);
    const perf = await json(join(d, "perf.json"));
    c.check(`${label} ${m.id}: perf.json intervalsMs + host adapter cdp + hideRoundTripMs`,
      perf?.intervalsMs?.length > 10 && perf.host?.adapter === "cdp" && typeof perf.host.hideRoundTripMs === "number" && typeof perf.host.markCaptureMs?.[m.id] === "number",
      `${perf?.intervalsMs?.length} intervals, hide ${perf?.host?.hideRoundTripMs} ms, capture ${perf?.host?.markCaptureMs?.[m.id]} ms`);
    if (bare) c.check(`${label} ${m.id}: bare has no before/ folder`, !(await exists(join(d, "before"))));
    else c.check(`${label} ${m.id}: before/sheet.png`, (await exists(join(d, "before", "sheet.png"))) && Array.isArray(await json(join(d, "before", "index.json"))));
  }
}

/** After the host detached: the page script is gone, the overlay is gone, the tab is still open. */
async function cleanDetach(label, t) {
  const list = await listTargets(t.endpoint).catch(() => []);
  c.check(`${label}: the tab is still open after the session`, list.length === 1, `${list.length} page(s)`);
  if (!list.length) return;
  const cdp = await wsBackend(list[0].webSocketDebuggerUrl);
  try {
    const r = await cdp.send("Runtime.evaluate", { expression: `JSON.stringify({ page: typeof globalThis.__snapperPage, overlays: document.querySelectorAll("[data-snapper-overlay]").length })`, returnByValue: true });
    const v = JSON.parse(r.result.value);
    c.check(`${label}: dispose removed the overlay and the host handle`, v.page === "undefined" && v.overlays === 0, r.result.value);
  } finally { await cdp.detach(); }
}

async function replayCheck(label, dir, markId) {
  const rep = await snapper(["replay", dir, markId], { timeoutMs: 120000, echo: false });
  c.check(`${label}: replay ${markId} exits 0`, rep.code === 0, `exit ${rep.code} ${rep.stderr.trim().split("\n").pop()}`);
  const s = await readSession(dir);
  const m = s.marks.find(x => x.id === markId);
  const rj = await json(join(dir, ...m.dir.split("/"), "replay", "replay.json"));
  c.check(`${label}: replay.json stateMatches true`, rj?.stateMatches === true, rj ? `stateMatches ${rj.stateMatches}${rj.firstDiff ? ` firstDiff ${rj.firstDiff}` : ""}` : "missing");
  return rj;
}

// ------------------------------------------------------------------ the page we attach to
const srv = await serveStatic(DEMO);
URL_ = `${srv.url}/index.html`;
const targets = [];
const keep = t => { targets.push(t); return t; };
let evidencePaths = {};

try {
  // ---------------------------------------------------------------- (a) second Electron
  process.stdout.write("\n== (a) second Electron\n");
  const ta = keep(await startElectronTarget({ url: URL_ }));
  process.stdout.write(`   target ${ta.endpoint} ${ta.browser}\n`);
  const ra = await attach(ta, ["--game-root", DEMO, "--smoke", SMOKE], join(OUT, "a"));
  const sa = await sessionShape("a", ra, { marksMin: 4, adapterBrowser: ta.browser });
  if (sa) {
    await markShape("a", sa.dir, sa.s);
    const sent_ = sent(ra);
    c.check("a: the host used Page.startScreencast, Page.reload, Page.addScriptToEvaluateOnNewDocument, Page.captureScreenshot",
      ["Page.startScreencast", "Page.reload", "Page.addScriptToEvaluateOnNewDocument", "Page.captureScreenshot"].every(m => sent_.has(m)), [...sent_].sort().join(" "));
    c.check("a: no Network/Fetch/Emulation of the page beyond focus emulation (smoke only)", ![...sent_].some(m => /^(Network|Fetch|Storage|Target|Browser\.set|Emulation\.(?!setFocusEmulationEnabled))/.test(m)), [...sent_].join(" "));
    const trig = sa.s.marks.map(m => m.trigger);
    c.check("a: smoke marks + a hotkey mark (the page's own F8 keydown)", trig.filter(t => t === "smoke").length >= 3 && trig.includes("hotkey"), trig.join(","));
    const hot = sa.s.marks.find(m => m.trigger === "hotkey");
    const note = hot ? (await readFile(join(sa.dir, ...hot.dir.split("/"), "note.txt"), "utf8").catch(() => "")).trim() : "";
    c.check("a: the note typed into the in-page note box was saved", note === "found a bug", JSON.stringify(note));
    const m1 = sa.s.marks.find(m => m.trigger === "smoke");
    const inputs = await json(join(sa.dir, ...m1.dir.split("/"), "inputs.json"));
    const keys = new Set((inputs?.wall || []).filter(w => w.k).map(w => `${w.k}:${w.d}`));
    c.check("a: inputs.json recorded KeyD held and Space tapped (the injected key recorder)", keys.has("KeyD:1") && keys.has("Space:1") && keys.has("Space:0"), [...keys].join(","));
    c.check("a: inputs.json has game frame lines", inputs?.frames?.length > 0, `frames ${inputs?.frames?.length}`);
    const tape = await readTape(sa.dir);
    c.check("a: tape.jsonl header + frame lines (the tape starts at the reloaded boot)", tape.header && tape.lines.some(isFrameLine) && tape.lines.some(isWallLine), `lines ${tape.lines.length}`);
    c.check("a: session.jsonl has ready{sdk,state,frame,stepper}", sa.s.ready?.sdk && sa.s.ready.state && sa.s.ready.frame && sa.s.ready.stepper, JSON.stringify(sa.s.ready));
    const md = await readFile(join(sa.dir, "SESSION.md"), "utf8").catch(() => "");
    c.check("a: SESSION.md says attached to the browser, replayable", /attached to Chrome\//.test(md) && /\(replayable\)/.test(md), md.split("\n")[1] || "");
    await cleanDetach("a", ta);
    await replayCheck("a", sa.dir, m1.id);
    numbers.runs.attachElectron = { browser: ta.browser, session: sa.dir, ...(await markNumbers(sa.dir, sa.s)) };
    evidencePaths = { a: { dir: sa.dir, mark: m1 } };
  }
  await ta.stop();

  // ---------------------------------------------------------------- play, same smoke (the numbers to put beside attach)
  process.stdout.write("\n== play, same smoke\n");
  const rp = await snapper(["play", DEMO, "--smoke", SMOKE, "--out", join(OUT, "play")], { timeoutMs: 150000, echo: false });
  c.check("play (same smoke) exits 0 with ok:true", rp.code === 0 && rp.last?.ok === true, `exit ${rp.code} ${rp.lastLine.slice(0, 120)}`);
  if (rp.last?.session) {
    const sp = await readSession(rp.last.session);
    const penv = await json(join(rp.last.session, "env.json"));
    c.check("play: env host.adapter \"electron\", perf host.adapter + hideRoundTripMs", penv?.host?.adapter === "electron"
      && (await json(join(rp.last.session, ...sp.marks[0].dir.split("/"), "perf.json")))?.host?.adapter === "electron");
    numbers.runs.play = { session: rp.last.session, ...(await markNumbers(rp.last.session, sp)) };
  }

  // ---------------------------------------------------------------- (b) Edge headless
  process.stdout.write("\n== (b) Edge headless\n");
  if (!(await exists(EDGE_EXE))) {
    process.stdout.write(`   SKIP: ${EDGE_EXE} not installed\n`);
    numbers.edge = { skipped: true };
  } else {
    const tb = keep(await startEdgeTarget({ url: URL_ }));
    process.stdout.write(`   target ${tb.endpoint} ${tb.browser}\n`);
    numbers.edge = { browser: tb.browser };
    const rb = await attach(tb, ["--game-root", DEMO, "--smoke", SMOKE], join(OUT, "b"));
    const sb = await sessionShape("b", rb, { marksMin: 4, adapterBrowser: tb.browser });
    if (sb) {
      await markShape("b", sb.dir, sb.s);
      c.check("b: the browser is Edge headless (recorded userAgent says Edg/)", /Edg\//.test(sb.env.host.attach.userAgent), sb.env.host.attach.userAgent.slice(-60));
      const m1 = sb.s.marks.find(m => m.trigger === "smoke");
      const hot = sb.s.marks.find(m => m.trigger === "hotkey");
      c.check("b: a hotkey mark (in-page F8) exists", !!hot);
      await replayCheck("b", sb.dir, m1.id);
      numbers.runs.attachEdge = { browser: tb.browser, session: sb.dir, ...(await markNumbers(sb.dir, sb.s)) };
      evidencePaths.b = { dir: sb.dir, mark: m1 };
    }
    await tb.stop();
    c.check("b: Edge was stopped and its throwaway profile deleted", !(await exists(tb.profile)), tb.profile);
  }

  // ---------------------------------------------------------------- (c) --no-reload
  process.stdout.write("\n== (c) --no-reload\n");
  const tc = keep(await startElectronTarget({ url: URL_ }));
  const rc = await attach(tc, ["--game-root", DEMO, "--no-reload", "--smoke", PASSIVE], join(OUT, "c"));
  const sc = await sessionShape("c", rc, { reloaded: false, marksMin: 2 });
  if (sc) {
    c.check("c: every mark line says replayable:false with the reason",
      sc.s.marks.length > 0 && sc.s.marks.every(m => m.replayable === false && m.replayableReason === "attached without a reload: the game booted before Snapper was injected"),
      JSON.stringify(sc.s.marks.map(m => [m.replayable, m.replayableReason])));
    const md = await readFile(join(sc.dir, "SESSION.md"), "utf8").catch(() => "");
    c.check("c: SESSION.md says \"not replayable: attached without a reload\"", md.includes("not replayable: attached without a reload"), md.split("\n")[2] || "");
    const sent_ = sent(rc);
    c.check("c: no Page.reload was sent", !sent_.has("Page.reload"), [...sent_].join(" "));
    const rep = await snapper(["replay", sc.dir, sc.s.marks[0].id], { timeoutMs: 60000, echo: false });
    c.check("c: snapper replay refuses (exit 2)", rep.code === 2, `exit ${rep.code} ${rep.stderr.trim().split("\n").pop()}`);
    for (const m of sc.s.marks) {
      const shot = await png(join(sc.dir, ...m.dir.split("/"), "shot.png"));
      c.check(`c ${m.id}: shot.png non-black`, shot.stats && shot.stats.nonBlack > 0.05, shot.error || `nonBlack ${shot.stats?.nonBlack.toFixed(3)}`);
    }
    await cleanDetach("c", tc);
  }
  await tc.stop();

  // ---------------------------------------------------------------- (d) --bare
  process.stdout.write("\n== (d) --bare\n");
  const td = keep(await startElectronTarget({ url: URL_ }));
  const rd = await attach(td, ["--game-root", DEMO, "--bare", "--smoke", SMOKE], join(OUT, "d"));
  const sd = await sessionShape("d", rd, { bare: true, marksMin: 4 });
  if (sd) {
    await markShape("d", sd.dir, sd.s, { bare: true });
    const sent_ = sent(rd);
    c.check("d: no Page.startScreencast / Page.stopScreencast under --bare", !sent_.has("Page.startScreencast") && !sent_.has("Page.stopScreencast"), [...sent_].join(" "));
    c.check("d: the shot still runs (Page.captureScreenshot)", sent_.has("Page.captureScreenshot"));
    const md = await readFile(join(sd.dir, "SESSION.md"), "utf8").catch(() => "");
    c.check("d: SESSION.md line 2 says bare", /\bbare\b/.test(md.split("\n")[1] || ""), md.split("\n")[1] || "");
    numbers.runs.attachBare = { session: sd.dir, ...(await markNumbers(sd.dir, sd.s)) };
  }
  await td.stop();
} finally {
  for (const t of targets) await t.stop().catch(() => {});
  await srv.close();
}

// ------------------------------------------------------------------ the numbers
const row = (label, r) => r && `${label.padEnd(22)} hide ${String(r.hideRoundTripMs?.median ?? "-").padStart(6)} ms (mean ${r.hideRoundTripMs?.mean ?? "-"}, max ${r.hideRoundTripMs?.max ?? "-"})   capture ${String(r.markCaptureMs?.median ?? "-").padStart(6)} ms (mean ${r.markCaptureMs?.mean ?? "-"}, max ${r.markCaptureMs?.max ?? "-"})   n=${r.hideRoundTripMs?.n ?? 0}`;
process.stdout.write("\n== overlay hide round trip and mark capture (medians over the marks of one run)\n");
for (const [k, label] of [["play", "play (IPC)"], ["attachElectron", "attach, Electron"], ["attachEdge", "attach, Edge headless"], ["attachBare", "attach --bare"]]) {
  const r = row(label, numbers.runs[k]);
  if (r) process.stdout.write(`   ${r}\n`);
}
await writeFile(join(OUT, "numbers.json"), JSON.stringify(numbers, null, 2) + "\n");

const ok = c.report();
await writeFile(join(OUT, "checks.json"), JSON.stringify({ gate: "Z3", date: new Date().toISOString(), ok, checks: c.items }, null, 2) + "\n");
if (EVIDENCE_ON) {
  const pairs = [];
  for (const [k, e] of Object.entries(evidencePaths)) {
    const d = join(e.dir, ...e.mark.dir.split("/"));
    pairs.push([join(e.dir, "SESSION.md"), `SESSION-${k}.md`], [join(e.dir, "env.json"), `env-${k}.json`], [join(d, "shot.png"), `shot-${k}.png`],
      [join(d, "before", "sheet.png"), `before-sheet-${k}.png`], [join(d, "perf.json"), `perf-${k}.json`], [join(d, "replay", "replay.md"), `replay-${k}.md`]);
  }
  const ev = await evidence("z3", [...pairs, [join(OUT, "numbers.json"), "numbers.json"], [join(OUT, "checks.json"), "checks.json"]], "v1.4");
  process.stdout.write(`evidence: ${ev.length} files in ${evidenceDir("v1.4", "z3")}\n`);
}
process.exit(ok ? 0 : 1);
