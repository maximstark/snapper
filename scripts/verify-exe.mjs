// X3 — the packaged CLI (BRIEF-v1.2 §6). Copies dist/win-unpacked to a fresh temp folder OUTSIDE the repo and drives
// `snapper.cmd` from there, with a cwd outside the repo and a PATH stripped of Node and of the repo's node_modules/.bin,
// so the exe cannot reach into the repo (a bare "@snapper/…" import would resolve through the repo's node_modules,
// because dist/ sits inside the repo; with the copy elsewhere it fails instead).
//   node scripts/verify-exe.mjs [--build] [--keep] [--game <game root> [--query "?level=1"]]     (EVIDENCE=1 writes private/evidence/v1.3/x3/, or EVIDENCE_VERSION/x3)
//     --build  run `npm run dist:dir` first (otherwise dist/win-unpacked/Snapper.exe must exist)
//     --keep   keep the temp copy and its sessions
// Writes sessions/x3/checks.json always.
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { readSession } from "../packages/core/index.mjs";
import { REPO, checklist, exists, json, EVIDENCE_ON, evidenceDir } from "./lib.mjs";

const argv = process.argv.slice(2);
const BUILD = argv.includes("--build");
const KEEP = argv.includes("--keep");
const optv = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const GAME2 = optv("--game");          // optional second game; its section is skipped without it
const GAME2_QUERY = optv("--query") || "";
const c = checklist("X3 packaged CLI");
const fwd = p => p.replace(/\\/g, "/");
const SRC = join(REPO, "dist", "win-unpacked");
const record = { startedAt: new Date().toISOString(), steps: [] };

// ---- a. build or find the unpacked app
if (BUILD) {
  process.stdout.write("building: npm run dist:dir\n");
  const b = spawnSync("npm run dist:dir", { cwd: REPO, shell: true, stdio: "inherit" });
  c.check("npm run dist:dir exits 0", b.status === 0, `exit ${b.status}`);
}
if (!existsSync(join(SRC, "Snapper.exe"))) {
  c.check("dist/win-unpacked/Snapper.exe exists", false, `${SRC} (run with --build or npm run dist:dir)`);
  await finish();
}

// ---- b. the copy, the cwd, the PATH
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const TMP = await mkdtemp(join(tmpdir(), `snapper-x3-${stamp}-`));
const APP = join(TMP, "Snapper");
const CWD = join(TMP, "cwd");
const SESS_DEMO = join(TMP, "sessions-demo");
const SESS_GAME2 = join(TMP, "sessions-game2");
await cp(SRC, APP, { recursive: true });
await mkdir(CWD, { recursive: true });
const CMD = join(APP, "snapper.cmd");
const RES = join(APP, "resources", "app");
process.stdout.write(`copy: ${APP}\ncwd:  ${CWD}\n`);

const norm = p => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
const repoBin = norm(join(REPO, "node_modules", ".bin"));
const dropped = [];
const pathDirs = [];
for (const d of (process.env.PATH || process.env.Path || "").split(delimiter).filter(Boolean)) {
  if (norm(d) === repoBin || norm(d).startsWith(norm(REPO) + sep.toLowerCase()) && /node_modules/i.test(d) || existsSync(join(d, "node.exe"))) dropped.push(d);
  else pathDirs.push(d);
}
const childEnv = { ...process.env };
for (const k of Object.keys(childEnv)) if (/^path$/i.test(k)) delete childEnv[k];
childEnv.PATH = pathDirs.join(delimiter);
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.SNAPPER_OPTS; delete childEnv.SNAPPER_REPLAY_OPTS; delete childEnv.SNAPPER_CLI_FORCE_MAIN;
record.pathDropped = dropped;
record.copy = APP;
process.stdout.write(`PATH: dropped ${dropped.length} dir(s): ${dropped.join(" ; ")}\n`);
c.check("node.exe is not reachable on the child PATH", !pathDirs.some(d => existsSync(join(d, "node.exe"))), `${pathDirs.length} dirs kept`);

/** Run snapper.cmd with args (always quoted). Resolves { code, stdout, stderr, lines, last, lastLine }. */
function snapperCmd(args, { timeoutMs = 120000 } = {}) {
  return new Promise(res => {
    const cmdline = [`"${CMD}"`, ...args.map(a => `"${String(a)}"`)].join(" ");
    const child = spawn(cmdline, { cwd: CWD, env: childEnv, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", killed = false;
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const timer = setTimeout(() => { killed = true; spawnSync(`taskkill /pid ${child.pid} /t /f`, { shell: true }); }, timeoutMs);
    child.on("close", code => {
      clearTimeout(timer);
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let last = null;
      try { last = JSON.parse(lines[lines.length - 1]); } catch {}
      res({ code: killed ? "timeout" : code, stdout, stderr, lines, last, lastLine: lines[lines.length - 1] ?? "", cmdline });
    });
  });
}
const note = (name, r) => record.steps.push({ name, code: r.code, lastLine: r.lastLine.slice(0, 300), stderr: r.stderr.trim().slice(-400) });

try {
  // ---- c. static checks on the copy
  const walk = dir => {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(p, ...walk(p)); else out.push(p);
    }
    return out;
  };
  const all = walk(RES);
  const badDirs = all.filter(p => /[\\/](node_modules|\.snapper)$/.test(p));
  c.check("no node_modules or .snapper under resources/app", badDirs.length === 0, badDirs.slice(0, 3).join(" ") || `${all.length} entries`);
  const hostMjs = walk(join(RES, "packages", "host")).filter(p => p.endsWith(".mjs"));
  const bare = [], pw = [];
  for (const f of hostMjs) {
    const src = await readFile(f, "utf8");
    if (/from\s+["']@snapper\/|import\(\s*["']@snapper\//.test(src)) bare.push(f.slice(APP.length + 1));
    if (/playwright/i.test(src)) pw.push(f.slice(APP.length + 1));
  }
  c.check('no bare "@snapper/…" import in resources/app/packages/host', bare.length === 0, bare.join(" ") || `${hostMjs.length} .mjs files`);
  c.check("no 'playwright' in resources/app/packages/host/**/*.mjs", pw.length === 0, pw.join(" ") || `${hostMjs.length} .mjs files`);
  c.check("snapper.cmd sits next to Snapper.exe", existsSync(CMD) && existsSync(join(APP, "Snapper.exe")), CMD);
  c.check("examples/demo shipped", existsSync(join(RES, "examples", "demo", "index.html")) && existsSync(join(RES, "examples", "demo", "smoke.json")));
  c.check("examples/{phaser,pixi,three}/index.html shipped (with vendor/)",
    ["phaser", "pixi", "three"].every(e => existsSync(join(RES, "examples", e, "index.html")) && existsSync(join(RES, "examples", e, "vendor"))),
    ["phaser", "pixi", "three"].map(e => `${e}:${existsSync(join(RES, "examples", e, "index.html"))}`).join(" "));
  c.check("no tests, docs, private, scripts or sessions in resources/app", !["tests", "docs", "private", "scripts", "sessions"].some(d => existsSync(join(RES, d))));

  // ---- d. --version and doctor
  const ver = await snapperCmd(["--version"], { timeoutMs: 60000 });
  note("--version", ver);
  c.check("snapper.cmd --version → `snapper 1.4.2`", ver.code === 0 && ver.stdout.trim() === "snapper 1.4.2", `exit ${ver.code} ${JSON.stringify(ver.stdout.trim())}`);
  const doc = await snapperCmd(["doctor"], { timeoutMs: 60000 });
  note("doctor", doc);
  c.check("snapper.cmd doctor exits 0 and says `all ok`", doc.code === 0 && doc.lastLine === "all ok", `exit ${doc.code} last ${JSON.stringify(doc.lastLine)}`);
  const exePath = join(APP, "Snapper.exe");
  c.check("doctor has a `packaged yes` line naming the copy's Snapper.exe",
    doc.lines.some(l => /packaged yes/.test(l) && l.toLowerCase().includes(exePath.toLowerCase())), doc.lines.find(l => /packaged/.test(l)) || "no packaged line");
  c.check("doctor mentions no Playwright", !/playwright/i.test(doc.stdout));
  const doctorTxt = doc.stdout.replace(/\r\n/g, "\n");

  // ---- e. play the shipped demo through the exe
  const demoDir = join(RES, "examples", "demo");
  const play = await snapperCmd(["play", demoDir, "--smoke", join(demoDir, "smoke.json"), "--out", SESS_DEMO], { timeoutMs: 180000 });
  note("play demo", play);
  c.check("play demo --smoke exits 0", play.code === 0, `exit ${play.code} ${play.stderr.trim().slice(-300)}`);
  c.check("last stdout line is JSON ok:true with 5 marks", play.last?.ok === true && play.last?.marks === 5, play.lastLine.slice(0, 200));
  const demoSession = play.last?.session;
  let demoMarkId = "0001";
  if (demoSession && await exists(demoSession)) {
    const env = await json(join(demoSession, "env.json"));
    c.check("env.json host.packaged === true", env?.host?.packaged === true, JSON.stringify(env?.host?.packaged));
    c.check("env.json host.exe is the copy's Snapper.exe", typeof env?.host?.exe === "string" && norm(env.host.exe) === norm(exePath), env?.host?.exe);
    c.check("env.json snapper 1.4.2, format 1", env?.snapper === "1.4.2" && env?.format === 1, `${env?.snapper} format ${env?.format}`);
    demoMarkId = (await readSession(demoSession)).marks[0]?.id ?? "0001";
  } else c.check("demo session folder exists", false, String(demoSession));

  // ---- f. replay through the exe
  if (demoSession && await exists(demoSession)) {
    const rep = await snapperCmd(["replay", demoSession, demoMarkId], { timeoutMs: 120000 });
    note("replay demo", rep);
    c.check(`replay demo ${demoMarkId} exits 0`, rep.code === 0, `exit ${rep.code} ${rep.stderr.trim().slice(-300)}`);
    const rj = rep.lastLine && await exists(join(rep.lastLine, "replay.json")) ? await json(join(rep.lastLine, "replay.json")) : null;
    c.check("last stdout line is the replay folder with replay.json", !!rj, rep.lastLine);
    c.check("replay.json stateMatches true, engine electron, chromium 152.x",
      rj?.stateMatches === true && rj?.engine === "electron" && /^152\./.test(rj?.chromium || ""), `stateMatches ${rj?.stateMatches} engine ${rj?.engine} chromium ${rj?.chromium}`);
    if (rj) record.demoReplay = { stateMatches: rj.stateMatches, engine: rj.engine, chromium: rj.chromium, dpr: rj.dpr };
  }

  // ---- f2. an engine demo (the smallest, pixi) through the exe: play with its smoke.json, replay mark 0001
  const engDir = join(RES, "examples", "pixi");
  const SESS_ENG = join(TMP, "sessions-engine");
  const eplay = await snapperCmd(["play", engDir, "--smoke", join(engDir, "smoke.json"), "--out", SESS_ENG], { timeoutMs: 180000 });
  note("play pixi demo", eplay);
  c.check("play pixi demo --smoke exits 0 with ok:true and >= 1 mark", eplay.code === 0 && eplay.last?.ok === true && eplay.last?.marks >= 1, `exit ${eplay.code} ${eplay.lastLine.slice(0, 160)} ${eplay.stderr.trim().slice(-200)}`);
  if (eplay.last?.session && await exists(eplay.last.session)) {
    const es = await readSession(eplay.last.session);
    const eid = es.marks[0]?.id ?? "0001";
    const est = await json(join(eplay.last.session, "marks", eid, "state.json"));
    c.check("pixi demo state.json carries engine pixi and a score", est?.engine === "pixi" && Number.isInteger(est?.score), `engine ${est?.engine} score ${est?.score}`);
    const erep = await snapperCmd(["replay", eplay.last.session, eid], { timeoutMs: 120000 });
    note("replay pixi demo", erep);
    const erj = erep.lastLine && await exists(join(erep.lastLine, "replay.json")) ? await json(join(erep.lastLine, "replay.json")) : null;
    c.check(`pixi demo replay ${eid} exits 0 with stateMatches true`, erep.code === 0 && erj?.stateMatches === true, `exit ${erep.code} stateMatches ${erj?.stateMatches} ${erep.stderr.trim().slice(-200)}`);
    if (erj) record.engineReplay = { demo: "pixi", stateMatches: erj.stateMatches, engine: erj.engine, chromium: erj.chromium };
  } else c.check("pixi demo session folder exists", false, String(eplay.last?.session));

  // ---- g. list: a temp game root whose snapper.config.json `out` points at the --out folder used above
  const gameRoot = join(TMP, "gameroot");
  await mkdir(gameRoot, { recursive: true });
  await writeFile(join(gameRoot, "snapper.config.json"), JSON.stringify({ out: fwd(SESS_DEMO) }));
  const lst = await snapperCmd(["list", gameRoot, "--json"], { timeoutMs: 60000 });
  note("list", lst);
  let rows = null;
  try { rows = JSON.parse(lst.stdout); } catch {}
  c.check("list <game root with config out> lists the demo session", lst.code === 0 && Array.isArray(rows) && rows.some(r => demoSession && norm(r.path) === norm(demoSession) && r.marks === 5),
    `exit ${lst.code} ${rows ? rows.map(r => `${r.id} marks ${r.marks}`).join("; ") : lst.stdout.slice(0, 200)}`);

  // ---- g2. v1.3: `snapper.cmd check` on the shipped demo (sessions from --out), then `snapper.cmd mcp` tools/list
  const chk = await snapperCmd(["check", demoDir, "--out", SESS_DEMO, "--json"], { timeoutMs: 180000 });
  note("check demo", chk);
  c.check("snapper.cmd check <demo> --out … --json exits 0, every replayable mark matches",
    chk.code === 0 && Array.isArray(chk.last?.rows) && chk.last.rows.length >= 5 && chk.last.summary?.differs === 0 && chk.last.summary?.error === 0 && chk.last.summary?.match >= 5,
    `exit ${chk.code} ${chk.last ? JSON.stringify(chk.last.summary) : chk.lastLine.slice(0, 200)} ${chk.stderr.trim().slice(-200)}`);
  c.check("check.json written under --out/checks", !!chk.last?.checkFile && existsSync(chk.last.checkFile) && norm(chk.last.checkFile).startsWith(norm(join(SESS_DEMO, "checks"))), chk.last?.checkFile);
  if (chk.last?.summary) record.check = chk.last.summary;
  const mcp = await new Promise(res => {
    const child = spawn(`"${CMD}" mcp`, { cwd: CWD, env: childEnv, shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const timer = setTimeout(() => spawnSync(`taskkill /pid ${child.pid} /t /f`, { shell: true }), 60000);
    child.on("close", code => { clearTimeout(timer); res({ code, stdout, stderr }); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x3", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sessions", arguments: { root: gameRoot } } }) + "\n");
    child.stdin.end();
  });
  let msgs = [];
  try { msgs = mcp.stdout.trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)); } catch (e) { msgs = null; }
  record.steps.push({ name: "mcp", code: mcp.code, lastLine: mcp.stdout.trim().slice(-300), stderr: mcp.stderr.trim().slice(-400) });
  const toolNames = msgs?.find(m => m.id === 2)?.result?.tools?.map(t => t.name) || [];
  c.check("snapper.cmd mcp: stdout is only JSON-RPC, initialize answers 2025-11-25, exit 0", Array.isArray(msgs) && msgs.every(m => m.jsonrpc === "2.0") && msgs.find(m => m.id === 1)?.result?.protocolVersion === "2025-11-25" && mcp.code === 0,
    `exit ${mcp.code} ${msgs ? msgs.length + " messages" : "non-JSON on stdout: " + mcp.stdout.slice(0, 200)}`);
  c.check("snapper.cmd mcp tools/list = the ten tools (v1.3 six + v1.4 four)", JSON.stringify(toolNames) === JSON.stringify(["list_sessions", "read_session", "read_mark", "mark_image", "replay", "check", "set_triage", "issue_markdown", "import_session", "export_repro"]), toolNames.join(","));
  const ls = msgs?.find(m => m.id === 3)?.result?.structuredContent?.rows;
  c.check("snapper.cmd mcp list_sessions sees the demo session", Array.isArray(ls) && ls.some(r => demoSession && norm(r.path) === norm(demoSession)), Array.isArray(ls) ? `${ls.length} rows` : JSON.stringify(msgs?.find(m => m.id === 3)).slice(0, 200));

  // ---- g3. v1.4 through the exe, Node off PATH: attach (against a second Electron with remote debugging), pack, import,
  //          triage, issue --markdown, export-repro --inject, doctor <root>
  if (demoSession && await exists(demoSession)) {
    const v14 = (record.v14 = {});
    // attach: the shipped demo served by this script, shown in the repo's Electron with --remote-debugging-port
    const { startElectronTarget } = await import("../tests/fixtures/attach-target/start.mjs");
    const { serveStatic } = await import("../packages/core/index.mjs");
    const srv = await serveStatic(demoDir);
    const url = `${srv.url}/index.html`;
    let target = null;
    try {
      target = await startElectronTarget({ url });
      const SESS_ATTACH = join(TMP, "sessions-attach");
      const at = await snapperCmd(["attach", target.endpoint, "--target", url, "--game-root", demoDir, "--out", SESS_ATTACH,
        "--smoke", join(REPO, "tests", "fixtures", "attach-target", "smoke-fast.json")], { timeoutMs: 180000 });
      note("attach", at);
      c.check("snapper.cmd attach <endpoint> --smoke exits 0 with ok:true and >= 1 mark", at.code === 0 && at.last?.ok === true && at.last?.marks >= 1,
        `exit ${at.code} ${at.lastLine.slice(0, 200)} ${at.stderr.trim().slice(-300)}`);
      const as = at.last?.session;
      if (as && await exists(as)) {
        const aenv = await json(join(as, "env.json"));
        c.check("attach env.json host.adapter cdp, reloaded true, packaged exe", aenv?.host?.adapter === "cdp" && aenv?.host?.attach?.reloaded === true,
          `adapter ${aenv?.host?.adapter} reloaded ${aenv?.host?.attach?.reloaded} browser ${aenv?.host?.attach?.browser}`);
        const amark = (await readSession(as)).marks[0]?.id ?? "0001";
        const ar = await snapperCmd(["replay", as, amark], { timeoutMs: 120000 });
        note("replay attach", ar);
        const arj = ar.lastLine && await exists(join(ar.lastLine, "replay.json")) ? await json(join(ar.lastLine, "replay.json")) : null;
        c.check(`the attach session's mark ${amark} replays through the exe with stateMatches true`, ar.code === 0 && arj?.stateMatches === true,
          `exit ${ar.code} stateMatches ${arj?.stateMatches} ${ar.stderr.trim().slice(-200)}`);
        v14.attach = { browser: aenv?.host?.attach?.browser, marks: at.last?.marks, stateMatches: arj?.stateMatches };
      } else c.check("attach session folder exists", false, String(as));
    } catch (e) {
      c.check("attach through the exe ran", false, e && e.stack || String(e));
    } finally {
      try { await target?.stop(); } catch {}
      await srv.close().catch(() => {});
    }
    // pack
    const kitZip = join(TMP, "kit", "demo-kit.zip");
    const pk = await snapperCmd(["pack", demoDir, "--out", kitZip, "--developer", "X3"], { timeoutMs: 120000 });
    note("pack", pk);
    c.check("snapper.cmd pack <demo> --out … exits 0 and writes the kit zip", pk.code === 0 && existsSync(kitZip), `exit ${pk.code} ${pk.stderr.trim().slice(-200)}`);
    // triage, issue, export-repro on the demo session
    const tr = await snapperCmd(["triage", demoSession, demoMarkId, "fixed", "--note", "x3", "--by", "x3"], { timeoutMs: 60000 });
    note("triage", tr);
    const tj = await json(join(demoSession, "marks", demoMarkId, "triage.json"));
    c.check("snapper.cmd triage … fixed writes triage.json", tr.code === 0 && tj?.status === "fixed" && tj?.by === "x3", `exit ${tr.code} ${JSON.stringify(tj)}`);
    const is = await snapperCmd(["issue", demoSession, demoMarkId], { timeoutMs: 60000 });
    note("issue", is);
    c.check("snapper.cmd issue --markdown (default) writes issue.md", is.code === 0 && existsSync(join(demoSession, "marks", demoMarkId, "issue.md")), `exit ${is.code} ${is.stderr.trim().slice(-200)}`);
    const er = await snapperCmd(["export-repro", demoSession, demoMarkId, "--inject"], { timeoutMs: 120000 });
    note("export-repro", er);
    c.check("snapper.cmd export-repro --inject writes the repro folder and repro-game/", er.code === 0 && existsSync(join(er.lastLine, "tape.json")) && existsSync(join(er.lastLine, "repro-game", "repro", "driver.js")),
      `exit ${er.code} ${er.lastLine} ${er.stderr.trim().slice(-200)}`);
    // import: the demo session zipped like a tester's outbox (core zipDir in this process), into a fresh game root
    const { zipDir } = await import("../packages/core/index.mjs");
    const outbox = join(TMP, "outbox", "demo-x3.zip");
    await zipDir(demoSession, outbox, { prefix: demoSession.split(/[\\/]/).pop() });
    const root2 = join(TMP, "gameroot2");
    await mkdir(root2, { recursive: true });
    const im = await snapperCmd(["import", outbox, "--root", root2], { timeoutMs: 60000 });
    note("import", im);
    c.check("snapper.cmd import <zip> --root … unpacks the session under the root's sessions", im.code === 0 && im.lines.some(l => existsSync(join(l.trim(), "session.jsonl")) && existsSync(join(l.trim(), "import.json"))),
      `exit ${im.code} ${im.stdout.trim().slice(0, 300)} ${im.stderr.trim().slice(-200)}`);
    const dr = await snapperCmd(["doctor", demoDir], { timeoutMs: 60000 });
    note("doctor root", dr);
    c.check("snapper.cmd doctor <demo> prints the integration line", dr.code === 0 && dr.lines.some(l => /integration: this game already talks to Snapper: game\.js/.test(l)), dr.lines.find(l => /integration/.test(l)) || dr.stdout.slice(-200));
  }

  // ---- h. second-game script through the exe, then replay its mark (only with --game)
  if (!GAME2) process.stdout.write("second-game section skipped (no --game <path>)\n");
  else if (!existsSync(GAME2)) c.check("second game checkout present", false, GAME2);
  else {
    const steps = [{ wait: 2500 }, { down: "KeyD" }];
    for (let i = 0; i < 8; i++) steps.push({ key: "Space", ms: 120 }, { wait: 630 });
    steps.push({ mark: "x3 smoke mark" }, { up: "KeyD" }, { wait: 800 },
      { expect: { marksAtLeast: 1, ready: { sdk: true, state: true, frame: true, stepper: true } } }, { end: true });
    const script = join(TMP, "g3-smoke.json");
    await writeFile(script, JSON.stringify(steps, null, 2) + "\n");
    const mp = await snapperCmd(["play", GAME2, "--preset", "1080p", ...(GAME2_QUERY ? ["--query", GAME2_QUERY] : []), "--smoke", script, "--out", SESS_GAME2], { timeoutMs: 240000 });
    note("play game2", mp);
    c.check("game2 play --smoke exits 0", mp.code === 0, `exit ${mp.code} ${mp.stderr.trim().slice(-300)}`);
    c.check("game2 result JSON ok:true", mp.last?.ok === true, mp.lastLine.slice(0, 200));
    const ms = mp.last?.session;
    if (ms && await exists(ms)) {
      const s = await readSession(ms);
      const m = s.marks.find(x => x.trigger === "smoke");
      c.check("a smoke mark exists", !!m, s.marks.map(x => `${x.id}:${x.trigger}`).join(" "));
      if (m) {
        const state = await json(join(ms, ...m.dir.split("/"), "state.json"));
        c.check("the smoke mark has a state.json", state != null, JSON.stringify(state)?.slice(0, 200));
        const mr = await snapperCmd(["replay", ms, m.id], { timeoutMs: 180000 });
        note("replay game2", mr);
        c.check(`game2 replay ${m.id} exits 0`, mr.code === 0, `exit ${mr.code} ${mr.stderr.trim().slice(-300)}`);
        const rj = mr.lastLine && await exists(join(mr.lastLine, "replay.json")) ? await json(join(mr.lastLine, "replay.json")) : null;
        c.check("game2 replay.json stateMatches true (engine electron, chromium 152.x)",
          rj?.stateMatches === true && rj?.engine === "electron" && /^152\./.test(rj?.chromium || ""), `stateMatches ${rj?.stateMatches} engine ${rj?.engine} chromium ${rj?.chromium}`);
        if (rj) record.game2Replay = { stateMatches: rj.stateMatches, engine: rj.engine, chromium: rj.chromium, dpr: rj.dpr };
      }
    } else c.check("game2 session folder exists", false, String(ms));
  }

  await writeOutputs(doctorTxt);
} finally {
  if (!KEEP) await rm(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(e => process.stdout.write(`cleanup failed: ${e.message}\n`));
  else process.stdout.write(`kept: ${TMP}\n`);
}
await finish();

async function writeOutputs(doctorTxt) {
  const body = () => JSON.stringify({ gate: "X3", ...record, finishedAt: new Date().toISOString(), checks: c.items }, null, 2) + "\n";
  const local = join(REPO, "sessions", "x3");
  await mkdir(local, { recursive: true });
  await writeFile(join(local, "checks.json"), body());
  await writeFile(join(local, "doctor.txt"), doctorTxt);
  if (EVIDENCE_ON) {
    const dir = evidenceDir("v1.4", "x3");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "checks.json"), body());
    await writeFile(join(dir, "doctor.txt"), doctorTxt);
  }
}

async function finish() {
  const ok = c.report();
  // checks.json is also written when an early exit skipped writeOutputs
  const local = join(REPO, "sessions", "x3");
  await mkdir(local, { recursive: true });
  await writeFile(join(local, "checks.json"), JSON.stringify({ gate: "X3", ...record, ok, checks: c.items }, null, 2) + "\n");
  process.exit(ok ? 0 : 1);
}
