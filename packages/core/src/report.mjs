// SESSION.html: one self-contained static page per session (v1.4, D-028; BRIEF-v1.4 §4.1). MIT, pure Node.
// Inline CSS, no script, no external assets. Images are referenced by RELATIVE path (marks/0001/shot.png) so the
// folder and its zip carry them; nothing is inlined as base64. Every string that came from a session (a tester can
// type anything into a note) is HTML-escaped. Derived like SESSION.md: regenerable at any time, never evidence.
import { join } from "node:path";
import { fmtT } from "./time.mjs";
import { readSession, isErrorLine, errorText } from "./reader.mjs";
import { renderSessionMd } from "./render.mjs";
import { triageLine } from "./triage.mjs";
import { atomicWrite } from "./writer.mjs";            // (writer → report → writer: a cycle used only at call time)

/** Escape text for HTML content and double- or single-quoted attributes. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const oneLine = s => String(s ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const stackFrames = (stack, max = 3) =>
  String(stack || "").split(/\r?\n/).map(s => s.trim()).filter(s => s.startsWith("at ")).slice(0, max);

/** The mark's folder relative to the session, forward slashes; falls back to marks/<id> when the recorded one looks unsafe. */
function markRel(m) {
  const id = String(m.id).replace(/[^\w.-]/g, "_");
  const rel = String(m.dir || "");
  return /^marks\/[\w.-]+$/.test(rel) && rel !== "marks/.." ? rel : `marks/${id}`;
}

const CSS = `
:root{--bg:#f6f7f9;--fg:#1c2128;--mut:#5b6572;--card:#fff;--bd:#d6dbe1;--ac:#1565c0;--bad:#b3261e;--code:#eef1f4}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--fg:#e4e8ec;--mut:#98a3b0;--card:#1c2127;--bd:#323a44;--ac:#6cb2ff;--bad:#ff8a80;--code:#262d35}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{font-size:1.35rem;margin:0 0 6px;overflow-wrap:anywhere}
h2{font-size:1.1rem;margin:0 0 8px}
p{margin:2px 0}
.hdr p{color:var(--mut);overflow-wrap:anywhere}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:14px;margin:16px 0}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{border-bottom:1px solid var(--bd);padding:4px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{color:var(--mut);font-weight:600}
code,pre{font-family:ui-monospace,Consolas,Menlo,monospace;font-size:.88rem}
pre{background:var(--code);padding:8px;border-radius:6px;overflow:auto;margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}
code{background:var(--code);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
.note{font-size:1.05rem;font-weight:600;overflow-wrap:anywhere}
.imgs{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0}
.imgs figure{margin:0;flex:1 1 320px;min-width:0}
.imgs img{display:block;max-width:100%;height:auto;border:1px solid var(--bd);border-radius:4px;background:#000}
figcaption{color:var(--mut);font-size:.8rem}
.bad{color:var(--bad)}
.mut{color:var(--mut)}
a{color:var(--ac)}
details{margin:6px 0}
summary{cursor:pointer;color:var(--ac)}
`.replace(/\n+/g, "\n").trim();

function img(rel, file, caption) {
  const src = `${rel}/${file}`;
  return `<figure><a href="${esc(src)}"><img src="${esc(src)}" alt="${esc(`${caption} of mark ${rel.split("/").pop()}`)}" loading="lazy"></a><figcaption>${esc(caption)}</figcaption></figure>`;
}

function markCard(s, m) {
  const info = m.info || { files: {}, state: null, replay: null, triage: null };
  const f = info.files || {};
  const rel = markRel(m);
  const frame = Number.isInteger(m.frame) && m.frame >= 0 ? `frame ${m.frame}` : "no frame";
  const out = [`<section class="card" id="mark-${esc(m.id)}">`, `<h2>${esc(m.id)} · ${esc(fmtT(m.t))} · ${esc(frame)} · ${esc(m.trigger)}</h2>`];
  if (m.note) out.push(`<p class="note">${esc(oneLine(m.note))}</p>`);
  else out.push(`<p class="mut">${esc(oneLine(m.summary ?? m.trigger))}</p>`);

  const imgs = [];
  if (f["shot.png"]) imgs.push(img(rel, "shot.png", "shot"));
  if (f["before/sheet.png"]) imgs.push(img(rel, "before/sheet.png", info.before ? `before: ${info.before.count} frames, ${info.before.seconds} s` : "before"));
  if (f["frame.png"]) imgs.push(img(rel, "frame.png", "frame (the canvas)"));
  if (imgs.length) out.push(`<div class="imgs">${imgs.join("")}</div>`);

  if (f["state.json"]) {
    let text;
    try { text = JSON.stringify(info.state, null, 2); } catch { text = String(info.state); }
    out.push(`<details><summary>State</summary><pre>${esc(text)}</pre></details>`);
  } else out.push(`<p class="mut">State: missing</p>`);

  const errsBefore = s.lines.filter(l => isErrorLine(l) && l.t <= m.t);
  if (m.trigger === "exception") {
    const ex = s.lines.filter(l => l.kind === "exception" && l.t <= m.t).pop();
    if (ex) out.push(`<p class="bad">Exception: ${esc(clip(oneLine(ex.text), 400))}</p>`, `<pre>${esc(stackFrames(ex.stack).join("\n"))}</pre>`);
    else out.push(`<p class="bad">Exception: (line not found)</p>`);
  } else if ((m.errors ?? 0) > 0 && errsBefore.length) {
    out.push(`<p class="bad">Errors: ${esc(m.errors)} · last: ${esc(clip(oneLine(errorText(errsBefore[errsBefore.length - 1])), 300))}</p>`);
  } else out.push(`<p class="mut">Errors: none</p>`);

  if (info.replay) {
    const more = (info.replay.diffs || []).filter(p => p !== info.replay.firstDiff);
    const d = info.replay.firstDiff ? ` (first diff ${info.replay.firstDiff}${more.length ? `; also ${more.join(", ")}` : ""})` : "";
    out.push(`<p>Replay: done · stateMatches ${esc(info.replay.stateMatches)}${esc(d)} · <code>${esc(rel)}/replay/replay.md</code></p>`);
  } else if (m.replayable === false) {
    out.push(`<p class="mut">Replay: not replayable (${esc(m.replayableReason || "attached without a reload")})</p>`);
  } else if (s.ready?.stepper && Number.isInteger(m.frame) && m.frame >= 0) {
    out.push(`<p>Replay: <code>snapper replay "${esc(s.dir)}" ${esc(m.id)}</code></p>`);
  } else {
    out.push(`<p class="mut">Replay: not replayable (${s.ready?.stepper ? "no frame at this mark" : "no stepper"})</p>`);
  }

  if (info.triage) {
    out.push(`<p>Triage: ${esc(triageLine(info.triage))}</p>`);
    const url = String(info.triage.issue ?? "");
    if (/^https?:\/\//i.test(url)) out.push(`<p>Issue: <a href="${esc(url)}">${esc(url)}</a></p>`);
  } else out.push(`<p class="mut">Triage: untriaged</p>`);
  out.push("</section>");
  return out.join("\n");
}

/** Pure: SESSION.html for a readSession() result. */
export function renderSessionHtml(s) {
  // The header block is SESSION.md's own (up to the first blank line): same facts, one source.
  const head = renderSessionMd(s).split("\n\n")[0].split("\n");
  const title = head[0].replace(/^#\s*/, "");
  const out = [
    "<!doctype html>", `<html lang="en">`, "<head>", `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(title)}</title>`, `<style>${CSS}</style>`, "</head>", "<body><main>",
    `<header class="hdr"><h1>${esc(title)}</h1>`,
    ...head.slice(1).map(l => `<p>${esc(l)}</p>`), "</header>",
  ];
  if (s.marks.length) {
    out.push(`<section class="card"><table><thead><tr><th>#</th><th>t</th><th>frame</th><th>trigger</th><th>summary</th><th>errors</th><th>worst ms</th></tr></thead><tbody>`);
    for (const m of s.marks) {
      const frame = Number.isInteger(m.frame) && m.frame >= 0 ? String(m.frame) : "–";
      const worst = Number.isFinite(m.worstMs) ? (Math.round(m.worstMs * 10) / 10).toFixed(1) : "–";
      out.push(`<tr><td><a href="#mark-${esc(m.id)}">${esc(m.id)}</a></td><td>${esc(fmtT(m.t))}</td><td>${esc(frame)}</td><td>${esc(m.trigger)}</td>`
        + `<td>${esc(clip(oneLine(m.note ?? m.summary ?? m.trigger), 100))}</td><td>${esc(m.errors ?? 0)}</td><td>${esc(worst)}</td></tr>`);
    }
    out.push("</tbody></table></section>");
  } else out.push(`<section class="card"><p class="mut">No marks in this session.</p></section>`);
  for (const m of s.marks) out.push(markCard(s, m));
  out.push(`<p class="mut">Derived from the session files (SESSION.md, marks/…). Regenerate with <code>snapper summary &lt;session-dir&gt;</code>.</p>`);
  out.push("</main></body>", "</html>", "");
  return out.join("\n");
}

/** Regenerate SESSION.html for any session folder. Returns its path. */
export async function writeReport(dir) {
  const html = renderSessionHtml(await readSession(dir));
  const path = join(dir, "SESSION.html");
  await atomicWrite(path, html);
  return path;
}
