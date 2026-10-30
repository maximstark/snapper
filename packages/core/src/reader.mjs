// Session reader. Tolerates a live (still-growing) session, half-written last lines,
// unknown kinds and unknown keys. Never throws for a missing optional file.
import { readFile, access, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseJsonl } from "./jsonl.mjs";
import { parseTape } from "./tape.mjs";

const exists = p => access(p).then(() => true, () => false);

export async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function readJson(path) {
  const s = await readText(path);
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Kinds that count as errors in a session. */
export const isErrorLine = l =>
  l.kind === "exception" || (l.kind === "console" && l.level === "error") || (l.kind === "log" && l.level === "error");

/** Error text of an error line. */
export const errorText = l => (l.kind === "log" ? l.msg : l.text) ?? "";

const MARK_FILES = ["shot.png", "frame.png", "before/sheet.png", "before/index.json", "state.json",
  "inputs.json", "log.json", "perf.json", "note.txt", "replay/replay.json", "replay/replay.md",
  "expected.json", "triage.json", "issue.md", "repro/README.md"];

/**
 * Read what a mark folder holds: which files exist, the state, the ring index, the note, any replay, perf.json's `host`
 * block (`perfHost`), and (v1.4) `triage` (triage.json or null).
 */
export async function readMark(sessionDir, markLine) {
  const rel = markLine.dir || `marks/${markLine.id}`;
  const dir = join(sessionDir, ...rel.split("/"));
  const files = {};
  await Promise.all(MARK_FILES.map(async f => { files[f] = await exists(join(dir, ...f.split("/"))); }));
  const state = files["state.json"] ? await readJson(join(dir, "state.json")) : null;
  const index = files["before/index.json"] ? await readJson(join(dir, "before", "index.json")) : null;
  const noteFile = files["note.txt"] ? (await readText(join(dir, "note.txt")))?.trim() : null;
  const replay = files["replay/replay.json"] ? await readJson(join(dir, "replay", "replay.json")) : null;
  let before = null;
  if (Array.isArray(index)) {
    const ts = index.map(e => Number(e.t)).filter(Number.isFinite);
    before = { count: index.length, seconds: ts.length > 1 ? Math.round((ts[ts.length - 1] - ts[0]) / 100) / 10 : 0 };
  }
  // v1.3: perf.json's `host` block (overhead telemetry), or null
  const perfHost = files["perf.json"] ? ((await readJson(join(dir, "perf.json")))?.host ?? null) : null;
  // v1.4: triage state (marks/NNNN/triage.json), or null
  let triage = files["triage.json"] ? await readJson(join(dir, "triage.json")) : null;
  if (!triage || typeof triage !== "object" || typeof triage.status !== "string") triage = null;
  return { dir, rel, files, state, before, noteFile, replay, perfHost, triage };
}

/**
 * Read a session folder.
 * Returns { dir, id, env, lines, bad, header, boot, ready, end, reloads, events, errors, marks, notes, lastT,
 * checkpoints (the `checkpoint` lines), resume (the `resume` line or null) }.
 * `marks` are the mark lines in order, each extended with `note` and (unless opts.marks === false) `info` from readMark.
 */
export async function readSession(dir, opts = {}) {
  const env = await readJson(join(dir, "env.json"));
  const { lines, bad } = parseJsonl(await readText(join(dir, "session.jsonl")));
  const header = lines.find(l => l.kind === "session") || null;
  const boot = lines.find(l => l.kind === "boot") || null;
  const ready = lines.filter(l => l.kind === "ready").pop() || null;
  const end = lines.filter(l => l.kind === "end").pop() || null;
  const reloads = lines.filter(l => l.kind === "reload");
  const events = lines.filter(l => l.kind === "event");
  const checkpoints = lines.filter(l => l.kind === "checkpoint");
  const resume = lines.filter(l => l.kind === "resume").pop() || null;
  const errors = lines.filter(isErrorLine);
  const notes = new Map();
  for (const l of lines) if (l.kind === "note" && l.mark != null) notes.set(String(l.mark), String(l.text ?? ""));
  const marks = [];
  for (const l of lines) {
    if (l.kind !== "mark" || l.id == null) continue;
    const m = { ...l, id: String(l.id), note: notes.get(String(l.id)) ?? null };
    if (opts.marks !== false) {
      m.info = await readMark(dir, m);
      if (m.note == null && m.info.noteFile) m.note = m.info.noteFile;
    }
    marks.push(m);
  }
  const lastT = lines.reduce((a, l) => (Number.isFinite(l.t) && l.t > a ? l.t : a), 0);
  return { dir, id: header?.id || env?.id || basename(dir), env, lines, bad, header, boot, ready, end,
    reloads, events, errors, marks, notes, lastT, checkpoints, resume };
}

/**
 * The game root a replay of this session serves (v1.4): env.json `game.root` when that folder exists on this machine,
 * else the `root` recorded by `snapper import` in import.json (a playtester's session names the tester's folder), else null.
 */
export async function sessionGameRoot(dir, env) {
  const { existsSync } = await import("node:fs");
  const r = env?.game?.root;
  if (r && existsSync(r)) return r;
  const imp = await readJson(join(dir, "import.json"));
  if (imp?.root && existsSync(imp.root)) return imp.root;
  return null;
}

/** Read tape.jsonl: { header, lines }. */
export async function readTape(dir) {
  return parseTape(await readText(join(dir, "tape.jsonl")));
}

/** Session folders under `<base>` (a `<out>/<slug>` folder or an `<out>` folder), newest first. */
export async function findSessions(base) {
  const found = [];
  async function walk(d, depth) {
    let ents;
    try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.isFile() && e.name === "session.jsonl")) { found.push(d); return; }
    if (depth <= 0) return;
    for (const e of ents) if (e.isDirectory() && e.name !== "marks") await walk(join(d, e.name), depth - 1);
  }
  await walk(base, 2);
  return found.sort((a, b) => basename(b).localeCompare(basename(a)));
}
