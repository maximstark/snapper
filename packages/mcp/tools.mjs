// The Snapper MCP tools: the six of v1.3 (BRIEF-v1.3 §5.3) and four of v1.4 (BRIEF-v1.4 §4.5: set_triage, issue_markdown,
// import_session, export_repro). MIT. Reads and writes sessions through packages/core; replay, check, import and
// export-repro run the Snapper CLI (ctx.cli) as a child process, so nothing here knows about Electron or the host.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  readSession, readTape, readJson, segmentForMark, writeSummary, pngSize, resolveConfig, findSessions,
  listCheckpoints, fmtDuration, fmtT, writeTriage, TRIAGE_STATUSES, triageLine,
} from "../core/index.mjs";
import * as core from "../core/index.mjs";

const str = (desc, extra = {}) => ({ type: "string", description: desc, ...extra });

export const TOOLS = [
  {
    name: "list_sessions",
    title: "List Snapper sessions",
    description: "Sessions of a game, newest first: id, marks, errors, duration, live, saved states, path (what `snapper list --json` prints). Start here, then read_session on the newest.",
    inputSchema: { type: "object", properties: {
      root: str("The game root folder (the folder with index.html / snapper.config.json)."),
      out: str("Optional sessions folder to search instead of the game's (the --out a play used)."),
    }, required: ["root"], additionalProperties: false },
  },
  {
    name: "read_session",
    title: "Read SESSION.md",
    description: "The session's SESSION.md (header, mark table, one block per mark), regenerated first when it is older than session.jsonl. Read it before anything else.",
    inputSchema: { type: "object", properties: { session: str("The session folder (contains session.jsonl).") }, required: ["session"], additionalProperties: false },
  },
  {
    name: "read_mark",
    title: "Read one mark",
    description: "One mark's evidence: note, state.json, the tail of log.json, an inputs summary, a perf summary (incl. host overhead), the file list and whether it is replayable. Look at the images with mark_image.",
    inputSchema: { type: "object", properties: {
      session: str("The session folder."), mark: str("The mark id, e.g. 0003 (or 3)."),
    }, required: ["session", "mark"], additionalProperties: false },
  },
  {
    name: "mark_image",
    title: "A mark's image",
    description: "A mark image at full resolution as PNG: shot (the window as the player saw it), frame (the game's internal frame, when registered), sheet (before/sheet.png, the lead-up contact sheet; absent in bare sessions). Never judge a visual from the sheet alone.",
    inputSchema: { type: "object", properties: {
      session: str("The session folder."), mark: str("The mark id."),
      which: str("Which image.", { enum: ["shot", "frame", "sheet"] }),
    }, required: ["session", "mark", "which"], additionalProperties: false },
  },
  {
    name: "replay",
    title: "Replay a mark",
    description: "Replay a replayable mark deterministically on the current code (snapper replay): returns replay.md, stateMatches, firstDiff and the output folder (marks/NNNN/replay/ with fNNNNNN.png frames). stateMatches false means the replay is NOT trustworthy.",
    inputSchema: { type: "object", properties: {
      session: str("The session folder."), mark: str("The mark id."),
      query: str("Optional segment query override, e.g. ?scene=stage&level=2-1 (sessions recorded before 1.1.1)."),
    }, required: ["session", "mark"], additionalProperties: false },
  },
  {
    name: "check",
    title: "Regression check",
    description: "snapper check: replay every replayable mark of the game's past sessions on the current code and compare with each mark's expectation (expected.json, else state.json). A `differs` on a mark you did not touch is a regression. accept=true records the replayed states as the new expectations: only for marks whose new behaviour Maxim confirmed is right, never to make a check pass.",
    inputSchema: { type: "object", properties: {
      root: str("The game root folder."),
      sessions: { type: "integer", minimum: 1, description: "Only the newest N sessions (default all)." },
      accept: { type: "boolean", description: "Write marks/NNNN/expected.json for every checked mark. Only with Maxim's confirmation." },
      out: str("Optional sessions folder to search instead of the game's (also where check.json goes)."),
    }, required: ["root"], additionalProperties: false },
  },
  {
    name: "set_triage",
    title: "Set a mark's triage status",
    description: "Write marks/NNNN/triage.json (status open | fixed | wontfix | duplicate | cannot-reproduce, who, when, optional note, commit, and `of` for a duplicate) and regenerate SESSION.md/SESSION.html. After a fix: status fixed with the commit sha; cannot-reproduce with what was tried in the note. session.jsonl is never touched.",
    inputSchema: { type: "object", properties: {
      session: str("The session folder."), mark: str("The mark id."),
      status: str("The triage status.", { enum: [...TRIAGE_STATUSES] }),
      note: str("Optional note (what was found, what was tried)."),
      by: str("Who sets it (default \"claude\")."),
      commit: str("Optional git sha of the fix."),
      of: str("For duplicate: the mark id it duplicates."),
    }, required: ["session", "mark", "status"], additionalProperties: false },
  },
  {
    name: "issue_markdown",
    title: "A mark as an issue (Markdown)",
    description: "The mark as a ready-to-paste issue: title, what was seen, the state's keys, the environment line, the first errors, the held inputs, the replay and check commands, the file paths. Read-only (snapper issue --markdown also writes marks/NNNN/issue.md).",
    inputSchema: { type: "object", properties: {
      session: str("The session folder."), mark: str("The mark id."), title: str("Optional title override."),
    }, required: ["session", "mark"], additionalProperties: false },
  },
  {
    name: "import_session",
    title: "Import a tester's session zip",
    description: "snapper import: validate a playtester's outbox zip and unpack it into the game's sessions (<root>/.snapper/sessions/<slug>/<id>). Refuses an existing id. Then read_session on the returned folder; the note is the tester's words and env.json describes their machine.",
    inputSchema: { type: "object", properties: {
      zip: str("The zip file a tester sent (outbox/<slug>-<session id>.zip)."),
      root: str("The game root to import it into."),
    }, required: ["zip", "root"], additionalProperties: false },
  },
  {
    name: "export_repro",
    title: "Export a no-Snapper repro",
    description: "snapper export-repro --inject: a folder (marks/NNNN/repro/ by default) that replays the mark's tape in a stock browser with no Snapper host present and prints REPRO: match or differs. Returns its README. The answer to \"was it Snapper?\": run it (snapper serve <dir>/repro-game, open the URL in Chrome, Edge or Firefox).",
    inputSchema: { type: "object", properties: {
      session: str("The session folder."), mark: str("The mark id."), out: str("Optional output folder."),
    }, required: ["session", "mark"], additionalProperties: false },
  },
];

class ToolError extends Error {}

const text = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });
const fail = msg => ({ content: [{ type: "text", text: msg }], isError: true });
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };

function needString(args, key, { optional = false } = {}) {
  const v = args[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`"${key}" must be a non-empty string`);
  return v.trim();
}

function folderArg(args, key, what) {
  const p = needString(args, key);
  const abs = resolve(p);
  if (!isAbsolute(p) && !existsSync(abs)) throw new ToolError(`${what} not found: ${p} (give an absolute path)`);
  if (!isDir(abs)) throw new ToolError(`${what} not found: ${abs}`);
  return abs;
}

function sessionArg(args) {
  const dir = folderArg(args, "session", "session folder");
  if (!existsSync(join(dir, "session.jsonl"))) throw new ToolError(`not a Snapper session (no session.jsonl): ${dir}`);
  return dir;
}

async function markArg(args, dir) {
  const raw = needString(args, "mark");
  if (!/^\d{1,4}$/.test(raw)) throw new ToolError(`"mark" must be a mark id like 0003 (got ${JSON.stringify(raw)})`);
  const id = raw.padStart(4, "0");
  const s = await readSession(dir);
  const m = s.marks.find(x => x.id === id);
  if (!m) throw new ToolError(`mark ${id} does not exist in ${dir} (marks: ${s.marks.map(x => x.id).join(", ") || "none"})`);
  return { s, m, id, markDir: join(dir, ...(m.dir || `marks/${id}`).split("/")) };
}

/** Replayable by the runner's own rules (replay/inprocess.mjs prepareReplay): a stepper, frame lines for the mark's segment, a frame. */
async function replayable(s, dir, m) {
  if (!(s.ready?.stepper ?? s.env?.sdk?.stepper)) return { replayable: false, reason: "the game registered no stepper" };
  if (m.replayable === false) return { replayable: false, reason: m.replayableReason || "attached without a reload" };
  const tape = await readTape(dir);
  if (!segmentForMark(tape.lines, m)) return { replayable: false, reason: "tape.jsonl has no frame lines" };
  if (!Number.isInteger(m.frame) || m.frame < 0) return { replayable: false, reason: `the mark carries no game frame (${m.frame})` };
  return { replayable: true };
}

/** Run the Snapper CLI. Resolves { code, stdout, stderr }. */
function runCli(ctx, args, timeoutMs) {
  return new Promise(res => {
    const [cmd, ...pre] = ctx.cli;
    let child;
    try {
      child = spawn(cmd, [...pre, ...args], { env: { ...process.env, ...(ctx.env || {}) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) { res({ code: null, stdout: "", stderr: `cannot start the Snapper CLI (${cmd}): ${e.message}` }); return; }
    let stdout = "", stderr = "", done = false;
    const timer = setTimeout(() => { stderr += `\ntimed out after ${timeoutMs / 1000} s`; try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const finish = code => { if (done) return; done = true; clearTimeout(timer); res({ code, stdout, stderr }); };
    child.on("error", e => { stderr += `cannot start the Snapper CLI (${cmd}): ${e.message}`; finish(null); });
    child.on("close", code => finish(code));
  });
}
const lastLine = s => s.trim().split(/\r?\n/).filter(Boolean).pop() || "";
const tail = (s, n = 800) => (s.length > n ? "…" + s.slice(-n) : s).trim();

// ------------------------------------------------------------------------------------------------ tools

async function listSessionsTool(args) {
  const root = folderArg(args, "root", "game root");
  const outArg = needString(args, "out", { optional: true });
  const { out, slug } = resolveConfig({ root, flags: outArg ? { out: resolve(outArg) } : {} });
  const dirs = out ? await findSessions(out) : [];
  const rows = [];
  for (const dir of dirs) {
    const s = await readSession(dir, { marks: false });
    const cps = await listCheckpoints(dir);
    const exit = cps.filter(c => c.name === "exit").pop();
    const durationMs = s.end?.durationMs ?? s.lastT;
    rows.push({ id: basename(dir), slug: s.env?.game?.slug || s.header?.game || "", marks: s.marks.length, errors: s.errors.length,
      durationMs, duration: fmtDuration(durationMs), live: !s.end, checkpoints: cps.length,
      exitFrame: Number.isInteger(exit?.frame) ? exit.frame : null, path: dir });
  }
  const lines = rows.length
    ? rows.map(r => `${r.id}  marks ${r.marks}  errors ${r.errors}  ${r.duration}${r.live ? " (live)" : ""}${r.checkpoints ? `  states ${r.checkpoints}` : ""}  ${r.path}`)
    : [`no sessions under ${out} (slug ${slug})`];
  return text(lines.join("\n"), { structuredContent: { root, out, rows } });
}

async function readSessionTool(args) {
  const dir = sessionArg(args);
  const md = join(dir, "SESSION.md");
  let regenerated = false;
  const mtime = async p => (await stat(p).catch(() => null))?.mtimeMs ?? -1;
  if ((await mtime(md)) < (await mtime(join(dir, "session.jsonl")))) { await writeSummary(dir); regenerated = true; }
  const body = await readFile(md, "utf8");
  return text(body, { structuredContent: { session: dir, regenerated } });
}

async function listFiles(dir, base = "") {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await listFiles(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function inputsSummary(inputs) {
  const wall = Array.isArray(inputs?.wall) ? inputs.wall : [];
  const frames = Array.isArray(inputs?.frames) ? inputs.frames : [];
  const keys = [...new Set(wall.filter(w => w.k !== undefined && w.d === 1).map(w => w.k))];
  const pads = wall.filter(w => w.p !== undefined).length;
  const fl = frames.filter(f => Number.isInteger(f.f) && f.m !== undefined);
  return { wallEvents: wall.length, keysPressed: keys, padEvents: pads, frameLines: fl.length,
    firstFrame: fl.length ? fl[0].f : null, lastFrame: fl.length ? fl[fl.length - 1].f : null,
    lastMask: fl.length ? fl[fl.length - 1].m : null };
}

function perfSummary(perf) {
  if (!perf || typeof perf !== "object") return null;
  const iv = Array.isArray(perf.intervalsMs) ? perf.intervalsMs : [];
  const avg = iv.length ? Math.round(iv.reduce((a, b) => a + b, 0) / iv.length * 1000) / 1000 : null;
  return { expectedMs: perf.expectedMs ?? null, displayHz: perf.displayHz ?? null, samples: perf.window?.samples ?? iv.length,
    avgMs: avg, p50: perf.p50 ?? null, p95: perf.p95 ?? null, max: perf.max ?? null, drops: perf.drops ?? null,
    longTasks: Array.isArray(perf.longTasks) ? perf.longTasks.length : 0, ...(perf.host ? { host: perf.host } : {}) };
}

async function readMarkTool(args) {
  const dir = sessionArg(args);
  const { s, m, id, markDir } = await markArg(args, dir);
  const state = await readJson(join(markDir, "state.json"));
  const log = await readJson(join(markDir, "log.json"));
  const inputs = await readJson(join(markDir, "inputs.json"));
  const perf = await readJson(join(markDir, "perf.json"));
  const expected = await readJson(join(markDir, "expected.json"));
  const all = await listFiles(markDir);
  const ringJpgs = all.filter(f => /^before\/\d+\.jpg$/.test(f)).length;
  const files = all.filter(f => !/^before\/\d+\.jpg$/.test(f) && !/^replay\/f\d{6}\.png$/.test(f));
  const replayFrames = all.filter(f => /^replay\/f\d{6}\.png$/.test(f)).length;
  const rep = await replayable(s, dir, m);
  const triage = await readJson(join(markDir, "triage.json"));
  const out = {
    session: dir, mark: id, t: m.t, time: fmtT(m.t), frame: m.frame, trigger: m.trigger, summary: m.summary ?? null,
    note: m.note ?? null, errors: m.errors ?? 0, worstMs: m.worstMs ?? null,
    triage: triage && typeof triage === "object" && typeof triage.status === "string" ? triage : null,
    state, ...(expected ? { expected: { acceptedAt: expected.acceptedAt, git: expected.git ?? null, host: expected.host ?? null } } : {}),
    logTail: Array.isArray(log) ? log.slice(-20) : null,
    inputs: inputsSummary(inputs), perf: perfSummary(perf),
    files, ...(ringJpgs ? { ringFrames: ringJpgs } : {}), ...(replayFrames ? { replayFrames } : {}),
    ...rep,
    ...(rep.replayable ? { replayCommand: `snapper replay "${dir}" ${id}` } : {}),
  };
  return text(JSON.stringify(out, null, 2), { structuredContent: out });
}

const IMAGE_FILE = { shot: "shot.png", frame: "frame.png", sheet: "before/sheet.png" };

async function markImageTool(args) {
  const dir = sessionArg(args);
  const which = needString(args, "which");
  if (!IMAGE_FILE[which]) throw new ToolError(`"which" must be one of shot, frame, sheet (got ${JSON.stringify(which)})`);
  const { id, markDir } = await markArg(args, dir);
  const rel = IMAGE_FILE[which];
  const p = join(markDir, ...rel.split("/"));
  if (!existsSync(p)) {
    const why = which === "frame" ? "the game registered no frame provider" : which === "sheet" ? "no ring buffer (a bare session, or no frames yet)" : "the screenshot failed";
    throw new ToolError(`mark ${id} has no ${rel} (${why})`);
  }
  const buf = await readFile(p);
  const size = pngSize(buf);
  if (!size) throw new ToolError(`${p} is not a valid PNG`);
  const meta = { session: dir, mark: id, which, path: p, width: size.w, height: size.h, bytes: buf.length };
  return {
    content: [
      { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
      { type: "text", text: `${rel} of mark ${id}: ${size.w}x${size.h}, ${buf.length} bytes (${p})` },
    ],
    structuredContent: meta,
  };
}

async function replayTool(args, ctx) {
  const dir = sessionArg(args);
  const { id } = await markArg(args, dir);
  const query = needString(args, "query", { optional: true });
  const cliArgs = ["replay", dir, id, ...(query ? ["--query", query] : [])];
  const r = await runCli(ctx, cliArgs, 10 * 60 * 1000);
  if (r.code !== 0) return fail(`snapper replay exited ${r.code}: ${tail(r.stderr) || tail(r.stdout) || "(no output)"}`);
  const outDir = lastLine(r.stdout);
  const result = await readJson(join(outDir, "replay.json"));
  const md = await readFile(join(outDir, "replay.md"), "utf8").catch(() => null);
  if (!result || md == null) return fail(`snapper replay did not leave replay.json/replay.md in ${outDir}`);
  const meta = { session: dir, mark: id, outDir, stateMatches: result.stateMatches === true, firstDiff: result.firstDiff ?? null, diffs: result.diffs ?? (result.firstDiff ? [result.firstDiff] : []),
    frameAt: result.frameAt, chromium: result.chromium, warnings: result.warnings || [] };
  return text(md, { structuredContent: meta });
}

async function checkTool(args, ctx) {
  const root = folderArg(args, "root", "game root");
  const cliArgs = ["check", root, "--json"];
  if (args.sessions !== undefined) {
    if (!Number.isInteger(args.sessions) || args.sessions < 1) throw new ToolError(`"sessions" must be an integer >= 1`);
    cliArgs.push("--sessions", String(args.sessions));
  }
  if (args.accept !== undefined && typeof args.accept !== "boolean") throw new ToolError(`"accept" must be a boolean`);
  if (args.accept === true) cliArgs.push("--accept");
  const out = needString(args, "out", { optional: true });
  if (out) cliArgs.push("--out", resolve(out));
  const r = await runCli(ctx, cliArgs, 60 * 60 * 1000);
  let parsed = null;
  try { parsed = JSON.parse(lastLine(r.stdout)); } catch {}
  if ((r.code !== 0 && r.code !== 1) || !parsed || !Array.isArray(parsed.rows)) {
    return fail(`snapper check exited ${r.code}: ${tail(r.stderr) || tail(r.stdout) || "(no output)"}`);
  }
  const { rows, summary = {}, checkFile = null } = parsed;
  const res = row => row.result === "differs" ? `differs ${row.diffs?.length ? row.diffs.join(", ") : row.firstDiff ?? ""}`.trim()
    : row.result === "skipped" ? `skipped (${row.reason ?? ""})` : row.result === "error" ? `error (${row.message ?? ""})` : row.result;
  const lines = [`session | mark | trigger | note | result`];
  for (const row of rows) lines.push(`${row.session} | ${row.mark} | ${row.trigger ?? ""} | ${row.note ?? ""} | ${res(row)}${row.accepted ? " (accepted)" : ""}`);
  lines.push("", `match ${summary.match ?? 0} · differs ${summary.differs ?? 0} · skipped ${summary.skipped ?? 0} · error ${summary.error ?? 0}`
    + `${summary.accepted ? ` · accepted ${summary.accepted}` : ""}${Number.isFinite(summary.ms) ? ` · ${(summary.ms / 1000).toFixed(1)} s` : ""}`);
  if (checkFile) lines.push(`check.json: ${checkFile}`);
  return text(lines.join("\n"), { structuredContent: { root, rows, summary, checkFile, exit: r.code } });
}

async function setTriageTool(args) {
  const dir = sessionArg(args);
  const { id } = await markArg(args, dir);
  const status = needString(args, "status");
  if (!TRIAGE_STATUSES.includes(status)) throw new ToolError(`"status" must be one of ${TRIAGE_STATUSES.join(", ")} (got ${JSON.stringify(status)})`);
  const patch = { status, by: needString(args, "by", { optional: true }) ?? "claude" };
  for (const k of ["note", "commit", "of"]) { const v = needString(args, k, { optional: true }); if (v !== undefined) patch[k] = v; }
  let res;
  try { res = await writeTriage(dir, id, patch); } catch (e) { throw new ToolError(e.message); }
  await writeSummary(dir);
  return text(`mark ${id}: ${triageLine(res.doc)}\n${res.path}`, { structuredContent: { session: dir, mark: id, triage: res.doc, path: res.path } });
}

async function issueMarkdownTool(args) {
  const dir = sessionArg(args);
  const { id } = await markArg(args, dir);
  const title = needString(args, "title", { optional: true });
  if (typeof core.buildIssue !== "function") throw new ToolError("this Snapper build has no issue builder (core buildIssue)");
  const r = await core.buildIssue(dir, id, title ? { title } : {});
  return text(r.markdown, { structuredContent: { session: dir, mark: id, title: r.title, markdown: r.markdown } });
}

/** The first path in a CLI's stdout that is a session folder (a line, or the absolute path at the end of a line). */
function sessionPathIn(stdout) {
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    const m = /([A-Za-z]:[\\/].*|\/.*)$/.exec(line);
    for (const cand of [line, m && m[1]].filter(Boolean)) {
      const p = cand.replace(/^"|"$/g, "");
      if (existsSync(join(p, "session.jsonl"))) return p;
    }
  }
  return null;
}

async function importSessionTool(args, ctx) {
  const zip = resolve(needString(args, "zip"));
  if (!existsSync(zip) || isDir(zip)) throw new ToolError(`zip file not found: ${zip}`);
  const root = folderArg(args, "root", "game root");
  const r = await runCli(ctx, ["import", zip, "--root", root], 5 * 60 * 1000);
  if (r.code !== 0) return fail(`snapper import exited ${r.code}: ${tail(r.stderr) || tail(r.stdout) || "(no output)"}`);
  const dest = sessionPathIn(r.stdout);
  if (!dest) return fail(`snapper import printed no session folder: ${tail(r.stdout)}`);
  const s = await readSession(dest, { marks: false });
  const meta = { zip, root, session: dest, id: basename(dest), marks: s.marks.length, tester: s.env?.tester?.name ?? null };
  return text(`imported ${meta.id} (${meta.marks} marks${meta.tester ? `, from ${meta.tester}` : ""}) to ${dest}\nNext: read_session ${dest}`, { structuredContent: meta });
}

async function exportReproTool(args, ctx) {
  const dir = sessionArg(args);
  const { id } = await markArg(args, dir);
  const out = needString(args, "out", { optional: true });
  const r = await runCli(ctx, ["export-repro", dir, id, "--inject", ...(out ? ["--out", resolve(out)] : [])], 5 * 60 * 1000);
  if (r.code !== 0) return fail(`snapper export-repro exited ${r.code}: ${tail(r.stderr) || tail(r.stdout) || "(no output)"}`);
  const reproDir = lastLine(r.stdout);
  const readme = await readFile(join(reproDir, "README.md"), "utf8").catch(() => null);
  if (readme == null) return fail(`snapper export-repro left no README.md in ${reproDir}`);
  const files = (await listFiles(reproDir)).filter(x => !x.startsWith("repro-game/"));
  return text(readme, { structuredContent: { session: dir, mark: id, dir: reproDir, gameDir: existsSync(join(reproDir, "repro-game")) ? join(reproDir, "repro-game") : null, files } });
}

const HANDLERS = {
  list_sessions: listSessionsTool, read_session: readSessionTool, read_mark: readMarkTool, mark_image: markImageTool, replay: replayTool, check: checkTool,
  set_triage: setTriageTool, issue_markdown: issueMarkdownTool, import_session: importSessionTool, export_repro: exportReproTool,
};

/** Run a tool. Bad input and failures come back as `isError: true` results with a plain message, never as throws. */
export async function callTool(name, args, ctx = {}) {
  const fn = HANDLERS[name];
  if (!fn) return fail(`unknown tool ${name}`);
  try { return await fn(args || {}, ctx); }
  catch (e) {
    if (e instanceof ToolError) return fail(e.message);
    ctx.log?.(`tool ${name} failed: ${e && e.stack || e}`);
    return fail(`${name} failed: ${e && e.message || e}`);
  }
}
