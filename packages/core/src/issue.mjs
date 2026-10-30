// Issue text for a mark (v1.4, D-028; BRIEF-v1.4 §4.3). MIT, pure Node. `issueMarkdown` is pure over a readSession()
// result plus the mark's files; `buildIssue` reads those files and returns what `issue.md` holds and what the
// launcher's "Copy issue" copies: `# <title>\n\n<body>`.
import { join } from "node:path";
import { fmtT } from "./time.mjs";
import { readSession, readJson, readTape, sessionGameRoot, isErrorLine, errorText } from "./reader.mjs";
import { stateLine } from "./render.mjs";
import { codesOf } from "./tape.mjs";

const oneLine = s => String(s ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fmtNum = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/** Pure: the issue title `<note or trigger> — <slug> <session id> mark NNNN`. */
export function issueTitle(session, mark) {
  const slug = session.env?.game?.slug || session.header?.game || "game";
  const what = clip(oneLine(mark.note || mark.trigger || "mark"), 80);
  return `${what} — ${slug} ${session.id} mark ${mark.id}`;
}

/** Pure: the environment line (host version, OS, GPU, display, Chromium, git sha, tester). */
export function envLine(env = {}) {
  const e = env || {};
  const parts = [`Snapper ${e.snapper || "?"}`];
  const os = e.host?.os || [e.host?.platform, e.host?.arch].filter(Boolean).join(" ");
  if (os) parts.push(os);
  parts.push(`GPU ${e.gpu ? oneLine(e.gpu) : "unknown"}`);
  const d = e.display || {};
  if (d.w && d.h) parts.push(`display ${d.w}×${d.h}${d.hz ? ` @ ${d.hz} Hz` : ""}${d.dpr ? ` dpr ${d.dpr}` : ""}`);
  if (e.host?.chromium) parts.push(`Chromium ${e.host.chromium}`);
  const git = e.game?.git;
  parts.push(git?.sha ? `git ${String(git.sha).slice(0, 7)}${git.dirty ? " (dirty)" : ""}` : "no git sha");
  if (e.tester?.name) parts.push(`tester ${oneLine(e.tester.name)}`);
  return parts.join(" · ");
}

/** Pure: "KeyD+Space" for a mask under a keymap, "(none)" for 0, "mask 18" when there is no keymap. */
function heldText(mask, keymap) {
  if (!mask) return "(none)";
  const codes = codesOf(mask, keymap || []);
  return codes.length ? codes.join("+") : `mask ${mask}`;
}

/** Pure: lines describing what was held, from inputs.json ({wall, frames}) and the tape keymap. */
export function inputsLines(inputs, keymap) {
  const out = [];
  const wall = Array.isArray(inputs?.wall) ? inputs.wall : [];
  const pressed = [];
  for (const w of wall) if (typeof w.k === "string" && w.d === 1 && !pressed.includes(w.k)) pressed.push(w.k);
  if (pressed.length) out.push(`keys pressed in the last seconds: ${pressed.join(", ")}`);
  const frames = Array.isArray(inputs?.frames) ? inputs.frames.filter(l => Number.isInteger(l.f) && Number.isInteger(l.m)) : [];
  if (frames.length) {
    const shown = frames.slice(-8);
    out.push(`held per frame (frame: keys), last ${shown.length} change${shown.length === 1 ? "" : "s"} of ${frames.length}: `
      + shown.map(l => `f${l.f}: ${heldText(l.m, keymap)}`).join(" · "));
  }
  if (!out.length) out.push("no input recorded in the last seconds");
  return out;
}

/**
 * Pure: the issue for one mark.
 *   session: readSession() output; mark: one of session.marks (with .info); opts.title overrides the title;
 *   opts.data = { state, log (array), inputs, keymap (array), gameRoot (string|null) } read from the mark's files.
 * Returns { title, body, markdown } where markdown = `# <title>\n\n<body>`.
 */
export function issueMarkdown(session, mark, { title, data = {} } = {}) {
  const t = oneLine(title || issueTitle(session, mark)) || issueTitle(session, mark);
  const dir = session.dir;
  const info = mark.info || { files: {} };
  const files = info.files || {};
  const markDir = info.dir || join(dir, "marks", mark.id);
  const out = [];

  out.push("## What was seen", "");
  if (mark.note) out.push(`- note: ${oneLine(mark.note)}`);
  out.push(`- trigger: ${mark.trigger} · t ${fmtT(mark.t)}${Number.isInteger(mark.frame) && mark.frame >= 0 ? ` · frame ${mark.frame}` : " · no frame"}`);
  if (mark.summary && mark.summary !== mark.trigger) out.push(`- summary: ${oneLine(mark.summary)}`);
  out.push(`- session: ${session.id} (${session.env?.game?.slug || session.header?.game || "game"})`);

  out.push("", "## State", "");
  const st = data.state ?? info.state;
  if (st && typeof st === "object" && !Array.isArray(st)) {
    out.push(stateLine(st), "", `top-level keys: ${Object.keys(st).join(", ") || "(none)"}`);
  } else out.push(st == null ? "state.json: missing" : stateLine(st));

  out.push("", "## Environment", "", envLine(session.env));

  const log = Array.isArray(data.log) ? data.log : [];
  const errs = log.filter(l => l && l.level === "error" || l?.kind === "exception");
  out.push("", "## First errors", "");
  if (errs.length) for (const e of errs.slice(0, 5)) out.push(`- ${clip(oneLine(e.text ?? e.msg ?? ""), 300)}`);
  else {
    const fromLines = session.lines.filter(l => isErrorLine(l) && l.t <= mark.t).slice(0, 5);
    if (fromLines.length) for (const e of fromLines) out.push(`- ${clip(oneLine(errorText(e)), 300)}`);
    else out.push("none");
  }

  out.push("", "## Inputs", "", ...inputsLines(data.inputs, data.keymap).map(l => `- ${l}`));

  out.push("", "## Reproduce", "");
  const replayable = mark.replayable !== false && session.ready?.stepper && Number.isInteger(mark.frame) && mark.frame >= 0;
  if (replayable) {
    out.push("```", `snapper replay "${dir}" ${mark.id}`,
      `snapper check "${data.gameRoot || "<game root>"}" --session "${dir}" --marks ${mark.id}`, "```");
  } else {
    out.push(`not replayable (${mark.replayable === false ? mark.replayableReason || "attached without a reload" : session.ready?.stepper ? "no frame at this mark" : "no stepper"}); read the files below.`);
  }

  out.push("", "## Files", "");
  const f = [["shot", "shot.png"], ["frame", "frame.png"], ["before", "before/sheet.png"], ["state", "state.json"]];
  for (const [label, rel] of f) if (files[rel]) out.push(`- ${label}: ${join(markDir, ...rel.split("/"))}`);

  const body = out.join("\n") + "\n";
  return { title: t, body, markdown: `# ${t}\n\n${body}` };
}

/**
 * Read a session + mark and build the issue. `markId` may be "1" or "0001". Throws Error(message) for a missing
 * session or mark. Returns { title, body, markdown, markDir }.
 */
export async function buildIssue(sessionDir, markId, { title } = {}) {
  const session = await readSession(sessionDir);
  if (!session.header && !session.lines.length) throw new Error(`not a session folder (no session.jsonl): ${sessionDir}`);
  const id = String(markId ?? "").trim().padStart(4, "0");
  const mark = session.marks.find(m => m.id === id);
  if (!mark) throw new Error(`mark ${id} does not exist in ${sessionDir} (marks: ${session.marks.map(m => m.id).join(", ") || "none"})`);
  const markDir = mark.info.dir;
  const [log, inputs, tape, gameRoot] = await Promise.all([
    readJson(join(markDir, "log.json")), readJson(join(markDir, "inputs.json")), readTape(sessionDir), sessionGameRoot(sessionDir, session.env),
  ]);
  const keymap = tape.header?.keymap?.length ? tape.header.keymap : session.env?.sdk?.keymap || [];
  const res = issueMarkdown(session, mark, { title, data: { state: mark.info.state, log, inputs, keymap, gameRoot } });
  return { ...res, markDir };
}
