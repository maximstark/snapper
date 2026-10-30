// SESSION.md renderer, per SESSION_FORMAT.md "SESSION.md". Pure: takes readSession() output.
import { fmtT, fmtDuration, idToDisplay } from "./time.mjs";
import { isErrorLine, errorText } from "./reader.mjs";
import { triageLine, triageSummary } from "./triage.mjs";
import { fmtSessionDuration } from "./activity.mjs";

const oneLine = s => String(s ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const cell = s => clip(oneLine(s), 100).replace(/\|/g, "\\|");
const ck = b => (b ? "✓" : "✗");

function fmtNum(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return String(x);
  return String(Math.round(x * 100) / 100);
}

function fmtScalar(v) {
  if (v === null) return "null";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return oneLine(v);
  return null;
}

/** Small numeric tuples ({x,y} or [x,y], ≤ 4 entries) read as (x,y); everything else nested is skipped. */
function fmtTuple(v) {
  const vals = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : null;
  if (!vals || !vals.length || vals.length > 4 || !vals.every(x => typeof x === "number")) return null;
  return `(${vals.map(fmtNum).join(",")})`;
}

/** The state line: first-level scalars of state.json (and small numeric tuples), ≤ 200 characters. */
export function stateLine(state) {
  if (state == null) return "missing";
  if (typeof state !== "object" || Array.isArray(state)) return clip(oneLine(JSON.stringify(state)), 200);
  if (state.unavailable) return "unavailable (no state provider)";
  if (state.error !== undefined && Object.keys(state).length === 1) return clip(`error: ${oneLine(state.error)}`, 200);
  const parts = [];
  for (const [k, v] of Object.entries(state)) {
    if (k === "perf" || k === "_truncated") continue;
    const s = fmtScalar(v) ?? fmtTuple(v);
    if (s !== null) parts.push(`${k}=${s}`);
  }
  return clip(parts.join(" ") || "(no scalars)", 200);
}

function stackFrames(stack, max = 3) {
  return String(stack || "").split(/\r?\n/).map(s => s.trim()).filter(s => s.startsWith("at ")).slice(0, max);
}

/**
 * The header line of a resumed session (D-021):
 * "resumed from <session>/<checkpoint> @ frame N (matched|DIFFERS|not compared|restoring…)".
 */
export function resumedLine(resumedFrom, env = {}) {
  if (!resumedFrom) return null;
  const m = env.resumeMatched;
  const how = m === true ? "matched" : m === false ? "DIFFERS" : m === null ? "not compared" : "restoring…";
  const frame = Number.isInteger(resumedFrom.frame) ? resumedFrom.frame : "?";
  let s = `resumed from ${resumedFrom.session}/${resumedFrom.checkpoint} @ frame ${frame} (${how})`;
  if (m === false && env.firstDiff) s += ` · first diff ${env.firstDiff}`;
  if (env.resumeError) s += ` · restore failed: ${oneLine(env.resumeError)}`;
  return s;
}

/**
 * The "Host overhead:" line (v1.3, D-027) from the marks' perf.json `host` blocks, or null when no mark has one:
 * "ring 10.2 fps (52 frames held) · mark capture 61 ms avg, 88 ms max over 3 marks" or "bare (no ring buffer) · mark capture …".
 */
export function overheadLine(s) {
  const hosts = s.marks.map(m => m.info?.perfHost).filter(h => h && typeof h === "object");
  if (!hosts.length) return null;
  const last = hosts[hosts.length - 1];
  const parts = [];
  if (last.bare === true) parts.push("bare (no ring buffer)");
  else parts.push(`ring ${fmtNum(Number(last.ringFps) || 0)} fps (${Number(last.ringFrames) || 0} frames held)`);
  const ms = Object.values(last.markCaptureMs || {}).map(Number).filter(Number.isFinite);
  if (ms.length) {
    const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
    parts.push(`mark capture ${Math.round(avg)} ms avg, ${Math.round(Math.max(...ms))} ms max over ${ms.length} mark${ms.length === 1 ? "" : "s"}`);
  }
  return `Host overhead: ${parts.join(" · ")}`;
}

function header(s) {
  const env = s.env || {};
  const game = env.game || {};
  const git = game.git || {};
  const slug = game.slug || s.header?.game || "game";
  const sha = git.sha ? String(git.sha).slice(0, 7) + (git.dirty ? "*" : "") : "no git sha (code unknown)";
  const when = idToDisplay(s.id) || (s.header?.startedAt ? String(s.header.startedAt).slice(0, 16).replace("T", " ") : "");
  const out = [`# Snapper session ${s.id} — ${slug} @ ${sha}${when ? ` — ${when}` : ""}`];

  const url = (game.url || s.header?.url || "(no url)") + (game.query ?? s.header?.query ?? "");
  const win = env.window || {};
  const parts = [url];
  if (win.w && win.h) parts.push(`${win.preset || "window"} ${win.w}×${win.h}${win.fullscreen ? " fullscreen" : ""}`);
  if (env.display?.hz) parts.push(`${env.display.hz} Hz`);
  const chromium = env.host?.chromium;
  if (chromium) parts.push(`Chromium ${String(chromium).split(".")[0]}`);
  const pads = Array.isArray(env.gamepads) && env.gamepads.length ? env.gamepads.map(p => p.id).join(", ") : "no gamepad";
  parts.push(pads);
  if (env.host?.bare === true) parts.push("bare");
  if (env.host?.adapter === "cdp") parts.push(`attached to ${env.host.attach?.browser || "a browser"}`);
  if (env.tester?.name) parts.push(`tester: ${oneLine(env.tester.name)}`);
  out.push(parts.join(" · "));

  const boot = !s.boot ? "Boot pending"
    : s.boot.ok ? `Boot ok in ${Math.round(Number(s.boot.ms) || 0)} ms`
    : `Boot FAILED${s.boot.error ? `: ${clip(oneLine(s.boot.error), 120)}` : ""}`;
  const r = s.ready;
  const passive = env.host?.attach && env.host.attach.reloaded === false;
  const sdk = !r ? "SDK: pending"
    : !r.sdk ? "SDK: absent (not replayable)"
    : `SDK: state ${ck(r.state)} frame ${ck(r.frame)} stepper ${ck(r.stepper)} (${passive ? "not replayable: attached without a reload" : r.stepper ? "replayable" : "not replayable"})`;
  const dur = s.end ? fmtSessionDuration(s.end) : `${fmtDuration(s.lastT)} (live)`;
  const errors = s.end && Number.isFinite(s.end.errors) ? s.end.errors : s.errors.length;
  const third = [boot, sdk, dur, `errors ${errors}`, `marks ${s.marks.length}`];
  const cps = (s.checkpoints || []);
  if (cps.length) {
    const exit = cps.filter(c => c.name === "exit").pop();
    third.push(`states ${cps.length}${exit ? ` (exit @ frame ${exit.frame})` : ""}`);
  }
  out.push(third.join(" · "));
  const triage = triageSummary(s.marks);
  if (triage) out.push(`Triage: ${triage}`);
  const overhead = overheadLine(s);
  if (overhead) out.push(overhead);
  const resumed = resumedLine(env.resumedFrom || s.header?.resumedFrom, env);
  if (resumed) out.push(resumed);
  if (git.dirty) out.push("(* = working tree dirty when played)");
  return out;
}

function table(s) {
  if (!s.marks.length) return [];
  const out = ["| # | t | frame | trigger | summary | errors | worst ms |", "|---|---|---|---|---|---|---|"];
  for (const m of s.marks) {
    const frame = Number.isInteger(m.frame) && m.frame >= 0 ? String(m.frame) : "–";
    const worst = Number.isFinite(m.worstMs) ? (Math.round(m.worstMs * 10) / 10).toFixed(1) : "–";
    out.push(`| ${m.id} | ${fmtT(m.t)} | ${frame} | ${m.trigger} | ${cell(m.note ?? m.summary ?? m.trigger)} | ${m.errors ?? 0} | ${worst} |`);
  }
  return out;
}

function markSection(s, m) {
  const info = m.info || { files: {}, state: null, before: null, replay: null };
  const frame = Number.isInteger(m.frame) && m.frame >= 0 ? `frame ${m.frame}` : "no frame";
  const out = [`## ${m.id} · ${fmtT(m.t)} · ${frame} · ${m.trigger}`];
  if (m.note) out.push(`Note: ${oneLine(m.note)}`);
  out.push(`State: ${info.files["state.json"] ? stateLine(info.state) : "missing"}`);

  const evs = s.events.filter(e => e.t <= m.t).slice(-5);
  out.push(`Events before: ${evs.length ? evs.map(e => `${fmtT(e.t)} ${oneLine(e.name)}`).join(" · ") : "none"}`);

  const errsBefore = s.lines.filter(l => isErrorLine(l) && l.t <= m.t);
  if (m.trigger === "exception") {
    const ex = s.lines.filter(l => l.kind === "exception" && l.t <= m.t).pop();
    if (ex) {
      out.push(`Exception: ${clip(oneLine(ex.text), 200)}`);
      for (const f of stackFrames(ex.stack)) out.push(`    ${f}`);
    } else out.push("Exception: (line not found)");
  } else if ((m.errors ?? 0) > 0 && errsBefore.length) {
    out.push(`Errors: ${m.errors} · last: ${clip(oneLine(errorText(errsBefore[errsBefore.length - 1])), 160)}`);
  } else {
    out.push("Errors: none");
  }

  const f = info.files;
  const files = [];
  if (f["shot.png"]) files.push("shot.png");
  if (f["frame.png"]) files.push("frame.png");
  if (f["before/sheet.png"]) {
    files.push(info.before ? `before/sheet.png (${info.before.count} frames, ${info.before.seconds} s)` : "before/sheet.png");
  }
  for (const n of ["state.json", "inputs.json", "log.json", "perf.json"]) if (f[n]) files.push(n);
  out.push(`Files: ${files.length ? files.join(" · ") : "none (folder incomplete)"}`);

  if (info.replay) {
    const more = (info.replay.diffs || []).filter(p => p !== info.replay.firstDiff);
    const d = info.replay.firstDiff ? ` (first diff ${info.replay.firstDiff}${more.length ? `; also ${more.join(", ")}` : ""})` : "";
    out.push(`Replay: done · stateMatches ${info.replay.stateMatches}${d} · replay/replay.md`);
  } else if (m.replayable === false) {
    out.push(`Replay: not replayable (${m.replayableReason || "attached without a reload"})`);
  } else if (s.ready?.stepper && Number.isInteger(m.frame) && m.frame >= 0) {
    out.push(`Replay: snapper replay "${s.dir}" ${m.id}`);
  } else {
    out.push(`Replay: not replayable (${s.ready?.stepper ? "no frame at this mark" : "no stepper"})`);
  }
  if (info.triage) out.push(`Triage: ${triageLine(info.triage)}`);
  return out;
}

export function renderSessionMd(s) {
  const out = header(s);
  const t = table(s);
  if (t.length) out.push("", ...t);
  for (const m of s.marks) out.push("", ...markSection(s, m));
  return out.join("\n") + "\n";
}
