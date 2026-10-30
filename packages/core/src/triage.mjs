// Triage state per mark (v1.4, D-028): marks/NNNN/triage.json. MIT, pure Node.
// { status: "open" | "fixed" | "wontfix" | "duplicate" | "cannot-reproduce", of?: "NNNN", by: <name>, at: <iso>,
//   note?: <text>, issue?: <url>, commit?: <sha> }
// triage.json is derived state, not evidence: it is rewritten (atomically) on every change. session.jsonl and
// tape.jsonl are never touched. Writers: `snapper triage`, `snapper issue --github` (records the URL), MCP set_triage,
// the launcher's status select.
import { join } from "node:path";
import { readJson, readText } from "./reader.mjs";
import { atomicWrite } from "./writer.mjs";            // (writer → render → triage → writer: a cycle used only at call time)
import { parseJsonl } from "./jsonl.mjs";

export const TRIAGE_STATUSES = Object.freeze(["open", "fixed", "wontfix", "duplicate", "cannot-reproduce"]);
export const TRIAGE_FILE = "triage.json";
const MARK_ID = /^\d{4}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const NOTE_MAX = 2000;

const isIso = s => typeof s === "string" && !Number.isNaN(Date.parse(s));
const isUrl = s => { try { const u = new URL(String(s)); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; } };

/** Pure: the first problem with a triage document (a user-facing message), or null when it is valid. */
export function triageProblem(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "triage must be an object";
  if (!TRIAGE_STATUSES.includes(doc.status)) return `status must be one of ${TRIAGE_STATUSES.join(", ")} (got ${JSON.stringify(doc.status)})`;
  if (doc.of !== undefined && !MARK_ID.test(String(doc.of))) return `--of must be a mark id like 0003 (got ${JSON.stringify(doc.of)})`;
  if (doc.status === "duplicate" && doc.of === undefined) return "a duplicate needs --of <mark id> (the mark it duplicates)";
  if (doc.status !== "duplicate" && doc.of !== undefined) return "--of only goes with status duplicate";
  if (typeof doc.by !== "string" || !doc.by.trim() || doc.by.length > 200) return "by must be a name (1-200 characters)";
  if (!isIso(doc.at)) return "at must be an ISO date";
  if (doc.note !== undefined && (typeof doc.note !== "string" || doc.note.length > NOTE_MAX)) return `note must be text of at most ${NOTE_MAX} characters`;
  if (doc.issue !== undefined && !isUrl(doc.issue)) return `issue must be an http(s) URL (got ${JSON.stringify(doc.issue)})`;
  if (doc.commit !== undefined && !SHA.test(String(doc.commit))) return `commit must be a git sha (7-40 hex characters, got ${JSON.stringify(doc.commit)})`;
  return null;
}

/**
 * Pure: the next triage document from the previous one (or null) and a patch { status, of?, by, note?, issue?, commit?, at? }.
 * Rules: `status` and `by` come from the patch (status defaults to the previous one, then "open"); `at` is now unless given;
 * `issue` carries over from the previous document unless the patch names one; `note`, `commit` and `of` carry over only
 * while the status stays the same. Throws Error(message) when the result is invalid.
 */
export function nextTriage(prev, patch = {}) {
  const p = prev && typeof prev === "object" ? prev : null;
  const status = patch.status ?? p?.status ?? "open";
  const same = p && p.status === status;
  const doc = { status };
  const of = patch.of ?? (same ? p.of : undefined);
  if (of !== undefined && of !== null && of !== "") doc.of = String(of).padStart(4, "0");
  doc.by = String(patch.by ?? p?.by ?? "").trim();
  doc.at = patch.at ?? new Date().toISOString();
  const note = patch.note ?? (same ? p.note : undefined);
  if (note !== undefined && note !== null && note !== "") doc.note = String(note);
  const issue = patch.issue ?? p?.issue;
  if (issue) doc.issue = String(issue);
  const commit = patch.commit ?? (same ? p.commit : undefined);
  if (commit) doc.commit = String(commit);
  const problem = triageProblem(doc);
  if (problem) throw new Error(problem);
  return doc;
}

/** marks/<id>/triage.json of a session, or null. */
export async function readTriage(sessionDir, markId) {
  const doc = await readJson(join(sessionDir, "marks", String(markId), TRIAGE_FILE));
  return doc && typeof doc === "object" && TRIAGE_STATUSES.includes(doc.status) ? doc : null;
}

/** Mark ids present in session.jsonl (`mark` lines). */
async function markIds(sessionDir) {
  const { lines } = parseJsonl(await readText(join(sessionDir, "session.jsonl")));
  return lines.filter(l => l.kind === "mark" && l.id != null).map(l => String(l.id));
}

/**
 * Set a mark's triage (merge with nextTriage, validate, write atomically). `markId` may be "3" or "0003".
 * Throws Error(message) for a missing session or mark or an invalid result. Returns { doc, path }.
 */
export async function writeTriage(sessionDir, markId, patch) {
  const raw = String(markId ?? "").trim();
  if (!/^\d{1,4}$/.test(raw)) throw new Error(`not a mark id: ${JSON.stringify(markId)}`);
  const id = raw.padStart(4, "0");
  const ids = await markIds(sessionDir);
  if (!ids.length && !(await readText(join(sessionDir, "session.jsonl")))) throw new Error(`not a session folder (no session.jsonl): ${sessionDir}`);
  if (!ids.includes(id)) throw new Error(`mark ${id} does not exist in ${sessionDir} (marks: ${ids.join(", ") || "none"})`);
  if (patch?.of !== undefined && patch.of !== null && patch.of !== "") {
    const of = String(patch.of).padStart(4, "0");
    if (!ids.includes(of)) throw new Error(`--of ${of}: no such mark in this session`);
    if (of === id) throw new Error("a mark cannot duplicate itself");
  }
  const prev = await readTriage(sessionDir, id);
  const doc = nextTriage(prev, patch);
  const path = join(sessionDir, "marks", id, TRIAGE_FILE);
  await atomicWrite(path, JSON.stringify(doc, null, 2) + "\n");
  return { doc, path };
}

/** Pure: counts per status over marks (each with `info.triage` from readMark, or `triage`); unset marks count as "untriaged". */
export function triageCounts(marks) {
  const counts = {};
  for (const m of marks || []) {
    const st = (m.info?.triage ?? m.triage)?.status ?? "untriaged";
    counts[st] = (counts[st] || 0) + 1;
  }
  return counts;
}

/** Pure: "1 fixed · 1 open · 3 untriaged" in TRIAGE_STATUSES order, or null when no mark has a triage.json. */
export function triageSummary(marks) {
  const c = triageCounts(marks);
  const any = TRIAGE_STATUSES.some(s => c[s]);
  if (!any) return null;
  return [...TRIAGE_STATUSES, "untriaged"].filter(s => c[s]).map(s => `${c[s]} ${s}`).join(" · ");
}

/** Pure: the one-line description of a triage document: `fixed by maxim 2026-10-22 · commit abc1234 · "note" · issue <url>`. */
export function triageLine(doc) {
  if (!doc) return null;
  const parts = [`${doc.status}${doc.of ? ` of ${doc.of}` : ""} by ${doc.by}${doc.at ? ` ${String(doc.at).slice(0, 10)}` : ""}`];
  if (doc.commit) parts.push(`commit ${String(doc.commit).slice(0, 12)}`);
  if (doc.note) parts.push(`"${String(doc.note).replace(/\s*[\r\n]+\s*/g, " ").slice(0, 160)}"`);
  if (doc.issue) parts.push(`issue ${doc.issue}`);
  return parts.join(" · ");
}
