// snapper check <game-root> [--sessions N | --session <dir>] [--marks 0001,0003] [--accept] [--query "?..."] [--out <dir>] [--json]
// Regression from playtests (BRIEF-v1.3 §3): every replayable mark of past sessions is replayed on the CURRENT code of
// the game root and its state compared with the expectation (marks/NNNN/expected.json, else the recorded state.json).
// Exit codes: 0 no mark differs or errors, 1 any differs or errors, 2 usage or refusal.
// This module is plain Node (no Electron import): the refusals, the plan and the table happen here; the replays run in
// an Electron child (replay/check-child.mjs on the single entry) that reports through a result file, exactly like
// replay/cli.mjs. The same plan/summarize/format code is used by replay/inprocess.mjs `checkInProcess`.
import { spawn } from "node:child_process";
import { existsSync, statSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readSession, readTape, readJson, findSessions, resolveConfig, gitInfo, segmentForMark, SNAPPER_VERSION,
} from "../../core/index.mjs";
import { electronCommand, electronChildEnv } from "../main/electron-bin.mjs";
import { Refusal } from "../replay/runner.mjs";

const err = s => process.stderr.write(s.endsWith("\n") ? s : s + "\n");
const readResult = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const oneLine = (s, n = 100) => {
  const t = String(s ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export const USAGE = "usage: snapper check <game-root> [--sessions N | --session <dir>] [--marks 0001,0003] [--accept] [--query \"?...\"] [--out <dir>] [--json]";

const padMark = s => String(s).padStart(4, "0");

/**
 * Pure: CLI arguments → the JSON-serialisable request
 * { root (absolute), sessions (N | null), session (absolute dir | null), marks (["0001", …] | null), accept, query, out (absolute | null), json }.
 * Throws Refusal. Existence of the root is checked by planCheck (it is an fs question).
 */
export function checkArgs({ positional = [], flags = {} } = {}) {
  const [rootArg] = positional;
  if (!rootArg) throw new Refusal(USAGE);
  let sessions = null;
  if (flags.sessions !== undefined) {
    const n = Number(flags.sessions);
    if (flags.sessions === true || !Number.isInteger(n) || n < 1) throw new Refusal(`--sessions must be an integer >= 1 (got "${flags.sessions}")`);
    sessions = n;
  }
  let session = null;
  if (flags.session !== undefined) {
    if (flags.session === true || !String(flags.session).trim()) throw new Refusal("--session needs a session folder");
    session = resolve(String(flags.session));
  }
  if (sessions !== null && session !== null) throw new Refusal("--sessions and --session are exclusive");
  let marks = null;
  if (flags.marks !== undefined) {
    if (flags.marks === true) throw new Refusal("--marks needs a list, e.g. --marks 0001,0003");
    marks = String(flags.marks).split(",").map(x => x.trim()).filter(Boolean);
    for (const m of marks) if (!/^\d{1,4}$/.test(m)) throw new Refusal(`--marks: "${m}" is not a mark id (0001, 3, …)`);
    marks = [...new Set(marks.map(padMark))];
    if (!marks.length) throw new Refusal("--marks needs a list, e.g. --marks 0001,0003");
  }
  if (flags.query === true) throw new Refusal("--query needs a value, e.g. --query \"?scene=stage&level=2-1\"");
  if (flags.out === true) throw new Refusal("--out needs a folder");
  return {
    root: resolve(String(rootArg)),
    sessions, session, marks,
    accept: flags.accept === true || flags.accept === "true",
    query: typeof flags.query === "string" ? flags.query : undefined,
    out: flags.out ? resolve(String(flags.out)) : null,
    json: flags.json === true || flags.json === "true",
  };
}

/** Pure: the expectation of a mark. { source: "expected" | "state", state } or null. expected = parsed expected.json, state = parsed state.json. */
export function expectationFor({ expected = null, state = null } = {}) {
  if (expected && typeof expected === "object" && expected.state !== undefined) return { source: "expected", state: expected.state };
  if (state !== null && state !== undefined) return { source: "state", state };
  return null;
}

/** Pure: the "result" column text of a row. */
export function resultText(r) {
  if (r.result === "differs") return `differs ${r.diffs?.length ? r.diffs.join(", ") : r.firstDiff || "$"}${r.accepted ? " (accepted)" : ""}`;
  if (r.result === "skipped") return `skipped (${oneLine(r.reason || "?")})`;
  if (r.result === "error") return `error (${oneLine(r.message || "?")})`;
  return r.result + (r.accepted ? " (accepted)" : "");
}

/** Pure: the table (session, mark, trigger, note, status (v1.4 triage), result), no trailing newline. */
export function formatTable(rows) {
  const clip = (s, n) => { const t = oneLine(s, n); return t; };
  const cols = ["session", "mark", "trigger", "note", "status", "result"];
  const body = rows.map(r => [String(r.session), String(r.mark), String(r.trigger ?? ""), clip(r.note ?? "", 40), String(r.status ?? "-"), resultText(r)]);
  const widths = cols.map((c, i) => Math.max(c.length, ...body.map(b => b[i].length)));
  const line = cells => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  return [line(cols), line(widths.map(w => "-".repeat(Math.min(w, 24)))), ...body.map(line)].join("\n");
}

/** Pure: { total, match, differs, skipped, error, accepted, ms, exit }. */
export function summarize(rows, ms = 0) {
  const n = res => rows.filter(r => r.result === res).length;
  const bad = rows.some(r => r.result === "error" || (r.result === "differs" && !r.accepted));
  return {
    total: rows.length, match: n("match"), differs: n("differs"), skipped: n("skipped"), error: n("error"),
    accepted: rows.filter(r => r.accepted).length, ms: Math.round(ms), exit: bad ? 1 : 0,
  };
}

export const summaryLine = s => `match ${s.match} · differs ${s.differs} · skipped ${s.skipped} · error ${s.error} · ${(s.ms / 1000).toFixed(1)} s`;

// ---------------------------------------------------------------------------------------------------- planning

/** Folder of the sessions of the request (the `--out` folder, else the config's), without the slug. */
function sessionsFolder(req) {
  const cfg = resolveConfig({ root: req.root });
  return { slug: cfg.slug, folder: req.out || cfg.out };
}

/** The mark ids of `session` selected by the request's --marks. */
function selectMarks(session, req) {
  const wanted = req.marks ? new Set(req.marks) : null;
  return session.marks.filter(m => !wanted || wanted.has(m.id));
}

/**
 * Validate the request and plan the check (plain Node, async: it reads the sessions). Throws Refusal for everything the
 * user must fix (bad root, no sessions, --marks naming nothing). Returns
 * { req, root, slug, sessions: [{ dir, id, session, tape, items: [replayable marks], base }], rows: [skipped rows], checkDir }.
 * Every item: { ord, markId, mark, frame, segIndex, expectation: { source, state }, row (the row skeleton) }.
 */
export async function planCheck(req) {
  if (!existsSync(req.root) || !statSync(req.root).isDirectory()) throw new Refusal(`game root not found: ${req.root}`);
  const { slug, folder } = sessionsFolder(req);
  let dirs;
  if (req.session) {
    if (!existsSync(join(req.session, "session.jsonl"))) throw new Refusal(`not a session folder (no session.jsonl): ${req.session}`);
    dirs = [req.session];
  } else {
    dirs = folder ? await findSessions(join(folder, slug)) : [];
    if (!dirs.length) throw new Refusal(`no sessions of "${slug}" under ${folder ? join(folder, slug) : "(no sessions folder)"}`);
    if (req.sessions) dirs = dirs.slice(0, req.sessions);
  }
  const checkDir = req.out ? join(req.out, "checks") : join(req.root, ".snapper", "checks");
  const sessions = [];
  const rows = [];
  let ord = 0;
  let foundMarks = 0;
  for (const dir of dirs) {
    const session = await readSession(dir);
    const id = session.id;
    const tape = await readTape(dir);
    const stepper = session.ready?.stepper ?? session.env?.sdk?.stepper;
    const picked = selectMarks(session, req);
    foundMarks += picked.length;
    const items = [];
    for (const mark of picked) {
      const base = {
        session: id, sessionDir: dir, mark: mark.id, frame: Number.isInteger(mark.frame) ? mark.frame : -1,
        trigger: mark.trigger ?? "", note: oneLine(mark.note ?? "", 60), status: mark.info?.triage?.status ?? null, expectation: null,
      };
      const myOrd = ord++;
      const skip = reason => rows.push({ ...base, result: "skipped", reason, _ord: myOrd });
      if (!session.env?.game?.url) { skip("env.json has no game.url"); continue; }
      if (!stepper) { skip("no stepper: the game registered none"); continue; }
      if (mark.replayable === false) { skip(mark.replayableReason || "not replayable (attached without a reload)"); continue; }
      const seg = segmentForMark(tape.lines, mark);
      if (!seg) { skip("tape.jsonl has no frame lines"); continue; }
      if (!seg.frames.length) { skip("no frame lines for the mark's segment"); continue; }
      if (!Number.isInteger(mark.frame) || mark.frame < 0) { skip(`no game frame at this mark (frame ${mark.frame})`); continue; }
      const dirOf = join(dir, ...(mark.dir || `marks/${mark.id}`).split("/"));
      const expected = await readJson(join(dirOf, "expected.json"));
      const state = mark.info?.files?.["state.json"] ? await readJson(join(dirOf, "state.json")) : null;
      const exp = expectationFor({ expected, state });
      if (!exp) { skip("no state.json"); continue; }
      base.expectation = exp.source;
      items.push({ ord: myOrd, markId: mark.id, mark, frame: mark.frame, segIndex: seg.index, frames: seg.frames, expectation: exp, row: base });
    }
    sessions.push({ dir, id, session, tape, items });
  }
  if (req.session && req.marks && !foundMarks) {
    throw new Refusal(`none of the marks ${req.marks.join(", ")} exist in ${req.session} (marks: ${sessions[0].session.marks.map(m => m.id).join(", ") || "none"})`);
  }
  return { req, root: req.root, slug, sessions, rows, checkDir };
}

/** Sorts rows into plan order (session as listed, mark id). */
export function sortRows(rows) {
  return rows.slice().sort((a, b) => (a._ord ?? 0) - (b._ord ?? 0));
}

/** The row without its internal ordering key. */
export const publicRow = r => { const { _ord, ...rest } = r; return rest; };

/** Write check.json and return its path. */
export async function writeCheckFile(req, plan, rows, summary) {
  await mkdir(plan.checkDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  let file = join(plan.checkDir, `${stamp}.json`);
  for (let n = 2; existsSync(file); n++) file = join(plan.checkDir, `${stamp}-${n}.json`);
  const git = gitInfo(req.root);
  const request = { ...req };
  const doc = {
    v: 1, at: new Date().toISOString(), host: SNAPPER_VERSION, root: req.root,
    git: git ? { sha: git.sha, dirty: git.dirty } : null, request, summary, rows,
  };
  await writeFile(file, JSON.stringify(doc, null, 2) + "\n");
  return file;
}

/** Finish a check whose replays are done (or none were needed): rows, summary, check.json. */
export async function finishCheck(req, plan, rows, t0) {
  const ordered = sortRows(rows).map(publicRow);
  const summary = summarize(ordered, Date.now() - t0);
  const checkFile = await writeCheckFile(req, plan, ordered, summary);
  return { rows: ordered, summary, checkFile };
}

// ---------------------------------------------------------------------------------------------------- CLI

function printResult(req, { rows, summary, checkFile }) {
  if (req.json) {
    process.stdout.write(JSON.stringify({ rows, summary, checkFile }) + "\n");
    return;
  }
  if (rows.length) process.stdout.write(formatTable(rows) + "\n");
  else process.stdout.write("no marks to check\n");
  process.stdout.write(summaryLine(summary) + "\n");
  process.stdout.write(`check.json: ${checkFile}\n`);
}

export async function run({ positional, flags = {} }) {
  try {
    const req = checkArgs({ positional, flags });
    const t0 = Date.now();
    const plan = await planCheck(req);                  // every refusal, before any Electron process starts
    const jobs = plan.sessions.reduce((n, s) => n + s.items.length, 0);
    if (!jobs) {
      const out = await finishCheck(req, plan, plan.rows, t0);
      printResult(req, out);
      return out.summary.exit;
    }

    const command = electronCommand();
    const resultFile = join(tmpdir(), `snapper-check-result-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.json`);
    const env = electronChildEnv({ SNAPPER_CHECK_OPTS: JSON.stringify(req), SNAPPER_RESULT_FILE: resultFile });
    const child = spawn(command.exe, command.args, { env, stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
    const code = await new Promise(res => {
      child.on("error", e => { err(`snapper check: cannot start Electron (${command.exe}): ${e.message}`); res(null); });
      child.on("exit", (c, sig) => res(c ?? (sig ? 1 : 0)));
    });
    try { if (child.pid) rmSync(join(tmpdir(), `snapper-check-${child.pid}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    const result = readResult(resultFile);
    try { rmSync(resultFile, { force: true }); } catch {}
    if (code === null) return 1;
    if (!result) {
      err(`snapper check: the check process exited with code ${code} and reported no result`);
      return 1;
    }
    if (result.error) {
      err(`snapper check: ${result.error}`);
      return result.refusal ? 2 : 1;
    }
    printResult(req, result);
    return result.summary.exit;
  } catch (e) {
    if (e instanceof Refusal) {
      err(`snapper check: ${e.message}`);
      return 2;
    }
    err(`snapper check: ${e && e.stack || e}`);
    return 1;
  }
}
