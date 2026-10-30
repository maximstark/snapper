// The capture pipeline, shared by the play host (app.mjs, Electron's wc.debugger) and the attach host (attach.mjs, a CDP
// WebSocket) — v1.4, BRIEF-v1.4 §2.2. It talks to ONE CDP interface (cdp.mjs) and to a page channel:
//
//   cdp   { send(method, params), onAny(fn), onClose(fn), detach(), closed, kind }       (cdp.mjs backends)
//   page  { send(kind, data) → boolean }   host → page messages (play: wc.send("snapper:m"); attach: Runtime.evaluate)
//   the page → host direction is two calls the owner makes: capture.onPage(kind, data) and capture.onTape(frames, masks, count)
//
// What lives here: SDK ready/boot handling, console / exception / log listeners, the screencast ring + tuner, mark capture
// (marks.mjs), the perf recorder messages, the tape (header, gate, segments), checkpoints, the smoke runner, hotkey actions,
// reload segments and the final flush. What stays with the owner: the window or the socket, the way keyboard hotkeys arrive,
// navigation events (nav.start / nav.finish / nav.fail / nav.gone), the throwaway profile, the GPU query, the result file.
//
// hooks (all optional): focus(), setMuted(bool), fullscreen(), endSession() (a smoke finished), beforeDetach() (async),
//                       onClosed(reason) (the CDP connection ended).
//   tester mode (play, v1.4): onReady() (the first ready), onHello() (the page script (re)started), onPageKind(kind, data) (a page
//                       message the pipeline does not know, e.g. "tester-name"), noteTitle (string: the note box title after a mark).
import { readFileSync } from "node:fs";
import { tapeLinesFromFlush, round1, isReload, createActivity, noteActivity, activeTotal } from "../../core/index.mjs";
import { Cooldowns, jpegSize, nthFor, consoleText, consoleLevel, exceptionText, oneLine } from "./helpers.mjs";
import { takeMark } from "./marks.mjs";
import { runSmoke } from "./smoke.mjs";
import { saveCheckpoint } from "./checkpoints.mjs";
import { runRestore } from "./resume.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * ctx: { cdp, page, writer, config, composer, displayHz, warn, dbg, res (RES | null), adapter, baseUrl, query,
 *        smokePath, hooks, writeResult, markLineExtras ({replayable:false, replayableReason} | null), extraMarkNote }
 */
export function createCapture(ctx) {
  const { cdp, page, writer, config, composer, displayHz, warn, res: RES = null, adapter, baseUrl, smokePath = null, hooks = {}, writeResult = () => {} } = ctx;
  const dbg = ctx.dbg || (() => {});
  const bare = config.bare === true;
  const query = ctx.query || "";

  // ------------------------------------------------------------------ host state
  const host = {
    writer, config, composer, displayHz, warn, adapter,
    ring: [], logRing: [], wall: [], tapeFrames: [], overlayHistory: [],
    readyLine: null, errorCount: 0, markChain: Promise.resolve(), closing: false,
    cooldowns: new Cooldowns(),
    checkpointCount: 0, restoring: false,
    activity: createActivity(),   // played time (D-030): keys, pads, pointer, notes
    markLineExtras: ctx.markLineExtras || null,
    // during/after a restore (D-021): { restoring, upTo, buffer }; from boot when resuming so the copied segment comes first
    tapeGate: RES ? { restoring: true, upTo: RES.frame, buffer: [] } : null,
    setMuted: m => { try { hooks.setMuted?.(m); } catch {} },
  };
  const logCap = Math.max(500, config.logLines);

  // CDP helpers
  host.cdp = (method, params = {}) => { dbg("cdp> " + method); return cdp.send(method, params).then(r => { dbg("cdp< " + method); return r; }); };
  const withTimeout = (p, ms) => Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]);
  host.evalRaw = async (expression, ms = 5000) => {
    try {
      const r = await withTimeout(host.cdp("Runtime.evaluate", { expression, returnByValue: true }), ms);
      return r && !r.exceptionDetails ? r.result.value : null;
    } catch { return null; }
  };
  // Smoke `eval` step (D-023): awaits promises and THROWS on an exception, a rejection or a timeout.
  host.evalAwait = async (expression, ms = 30000) => {
    let timer;
    const r = await Promise.race([
      host.cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timed out after " + ms + " ms")), ms); }),
    ]).finally(() => clearTimeout(timer));
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || "evaluation failed");
    }
    return r.result.value;
  };
  host.evalJson = async (expression, ms) => {
    const v = await host.evalRaw(expression, ms);
    if (typeof v !== "string") return null;
    try { return JSON.parse(v); } catch { return null; }
  };

  // page round trips
  const pending = new Map();
  let askSeq = 0;
  host.ask = (what, data = {}, timeoutMs = 1500) => new Promise(res => {
    const id = ++askSeq;
    const to = setTimeout(() => { pending.delete(id); res(null); }, timeoutMs);
    pending.set(id, out => { clearTimeout(to); res(out); });
    let sent = false;
    try { sent = page.send("ask", { id, what, ...data }) !== false; } catch {}
    if (!sent) { clearTimeout(to); pending.delete(id); res(null); }
  });
  const toOverlay = (kind, data) => { try { page.send(kind, data); } catch {} };
  host.toOverlay = toOverlay;

  host.requestMark = (trigger, o = {}) => {
    const p = host.markChain.then(() => takeMark(host, trigger, o)).catch(err => { warn(`mark failed: ${err && err.stack || err}`); return null; });
    host.markChain = p;
    return p;
  };
  host.requestSave = (kind = "manual", o = {}) => {
    const p = host.markChain.then(() => saveCheckpoint(host, kind, o)).then(r => {
      if (r && kind === "manual") {
        toOverlay("toast", r.restorable ? `State ${r.name} saved · frame ${r.frame}`
          : `State ${r.name} saved · ${/^no stepper/.test(r.reason || "") ? "no stepper: not restorable" : `not restorable (${r.reason})`}`);
      }
      return r;
    }).catch(err => { warn(`save failed: ${err && err.stack || err}`); return null; });
    host.markChain = p;
    return p;
  };
  host.idle = async () => {
    for (let i = 0; i < 20; i++) {
      const c = host.markChain;
      await c;
      await sleep(60);
      if (c === host.markChain) break;
    }
  };

  // ------------------------------------------------------------------ session lines
  let marksShown = [];
  host.onMarkSaved = m => {
    marksShown.push({ id: m.id, t: m.t, trigger: m.trigger, summary: m.summary });
    toOverlay("marks", marksShown);
    pushStatus();
    if (m.openNote) {
      try { hooks.focus?.(); } catch {}
      if (hooks.noteTitle) toOverlay("note", { id: m.id, text: hooks.noteTitle, plain: true });
      else toOverlay("note", { id: m.id, text: `Mark ${m.id} saved` });
    } else toOverlay("toast", `Mark ${m.id} saved · ${m.trigger}`);
  };

  function pushLog(entry) {
    host.logRing.push(entry);
    if (host.logRing.length > logCap) host.logRing.splice(0, host.logRing.length - logCap);
  }
  function countError(text) {
    host.errorCount++;
    toOverlay("error", oneLine(text, 200));
    pushStatus();
  }

  // tape: the header must be the first line, so buffer until `ready` is known
  let headerWritten = false;
  const tapeBuf = [];
  function tapeOut(line, { remember = false } = {}) {
    if (host.tapeGate?.restoring) { host.tapeGate.buffer.push([line, remember]); return; }   // goes after the copied segment
    if (remember) {
      host.tapeFrames.push(line);
      if (host.tapeFrames.length > 50000) host.tapeFrames.splice(0, 10000);
    }
    if (headerWritten) writer.tape(line);
    else tapeBuf.push(line);
  }
  /** End of a restore: the copied segment + resume marker, then whatever was buffered meanwhile (wall lines). */
  host.finishRestoreTape = (lines, upTo) => {
    const g = host.tapeGate || { buffer: [] };
    host.tapeGate = { restoring: false, upTo, buffer: [] };
    if (!headerWritten) writeTapeHeader(host.readyLine?.sdk ? { keymap: RES?.keymap, pauseParam: RES?.pauseParam } : null);
    for (const l of lines) tapeOut(l, { remember: true });
    for (const [l, remember] of g.buffer) tapeOut(l, { remember });
  };

  function writeTapeHeader(r) {
    if (headerWritten) return;
    headerWritten = true;
    const header = { kind: "tape", v: 1, keymap: r?.keymap || [], pauseParam: r?.pauseParam || "" };
    writer.tapeMany([header, ...tapeBuf]);
    tapeBuf.length = 0;
  }

  // ------------------------------------------------------------------ boot / ready
  let loadStart = Date.now(), loadMs = null, loaded = false, bootWritten = false, navCount = 0;
  let registerPending = false, registerTimer = null, fallbackTimer = null, readyEvals = 0;
  let smokeStarted = false, lastReadyKey = null, lastFrame = -1, segChecked = false, readyNav = 0;
  let live = false;

  async function bootFail(error) {
    if (bootWritten) return;
    bootWritten = true;
    writer.line("boot", { ok: false, ms: round1(Date.now() - loadStart), error: oneLine(error, 500) });
    host.requestMark("boot", { summary: `boot failed: ${oneLine(error, 120)}` });
  }

  async function evalReady() {
    if (host.closing) return;
    readyEvals++;
    const navAtStart = navCount;
    const r = await host.evalJson(`(()=>{try{var s=globalThis.snapper;if(!s||!s.__host)return JSON.stringify(null);return JSON.stringify(s.__host.ready())}catch(e){return JSON.stringify(null)}})()`);
    const sdk = !!(r && r.sdk !== false);
    const fields = sdk
      ? { sdk: true, state: !!r.state, frame: !!r.frame, stepper: !!r.stepper, commands: Array.isArray(r.commands) ? r.commands.map(c => (typeof c === "string" ? c : c.id)) : [] }
      : { sdk: false, state: false, frame: false, stepper: false, commands: [] };
    if (sdk && r.version) fields.sdkVersion = r.version;
    if (sdk && r.pauseParam) pauseParamSeen = r.pauseParam;
    if (navCount > 1 && !segChecked) {
      // D-022: confirm the recorded query against what the new document really has.
      segChecked = true;
      const real = await host.evalRaw(`(()=>{try{var u=new URL(location.href);u.searchParams.delete(${JSON.stringify(pauseParamSeen)});return u.search}catch(e){return null}})()`, 2000);
      if (typeof real === "string" && real !== segQuery) warn(`navigation: recorded query "${segQuery}" but the page reports "${real}" (a redirect?); restores of this segment boot with the recorded one`);
    }
    const key = JSON.stringify(fields);
    const first = host.readyLine === null;
    host.readyLine = fields;
    if (first && !bootWritten) {
      bootWritten = true;
      writer.line("boot", { ok: true, ms: loadMs ?? round1(Date.now() - loadStart) });
    }
    if (first) writeTapeHeader(sdk ? r : null);
    if (key !== lastReadyKey) {
      lastReadyKey = key;
      writer.line("ready", fields);
      const pads = await host.ask("pads", {}, 800);
      writer.patchEnv({
        sdk: sdk
          ? { present: true, version: r.version, state: fields.state, frame: fields.frame, stepper: fields.stepper, keymap: r.keymap || [], pauseParam: r.pauseParam || "", commands: fields.commands }
          : { present: false },
        gamepads: Array.isArray(pads) ? pads : [],
      });
    }
    readyNav = Math.max(readyNav, navAtStart);
    toOverlay("arm", true);
    if (first) { try { hooks.onReady?.(); } catch (err) { warn(`onReady: ${err.message}`); } }
    if (sdk && fields.commands.length) {
      const list = await host.evalJson(`(()=>{try{return JSON.stringify(globalThis.snapper.__host.commandList())}catch(e){return "[]"}})()`);
      toOverlay("commands", Array.isArray(list) ? list : []);
    } else toOverlay("commands", []);
    if (RES && !resumeStarted) {
      if (fields.stepper) { resumeStarted = true; clearTimeout(resumeWait); startResume(); }
      else if (first) resumeWait = setTimeout(() => { if (!resumeStarted) { resumeStarted = true; resumeFailed("the game did not register a stepper within 30 s"); } }, 30000);
    } else if (first && !RES && smokePath && !smokeStarted) startSmoke();
  }

  // ------------------------------------------------------------------ resume (D-021)
  let resumeStarted = false, resumeWait = null;
  async function startResume() {
    host.restoring = true;
    host.tapeGate ||= { restoring: true, upTo: RES.frame, buffer: [] };
    try { await runRestore(host, RES); }
    catch (err) {
      warn(`restore crashed: ${err && err.stack || err}`);
      if (host.tapeGate?.restoring) host.finishRestoreTape([], -1);
      host.setMuted(false);
      toOverlay("restore", null);
    }
    host.restoring = false;
    host.ring.length = 0;                                // ring frames of the restore are not gameplay
    toOverlay("arm", true);                              // pacing detection restarts 2 s after the restore
    if (smokePath && !smokeStarted && !host.closing) startSmoke();
  }
  async function resumeFailed(error) {
    host.finishRestoreTape([], -1);
    await writer.patchEnv({ resumeMatched: false, resumeError: error });
    writer.line("resume", { frame: -1, from: `${RES.sessionId}/${RES.checkpoint}`, matched: false, error });
    host.setMuted(false);
    toOverlay("restore", null);
    toOverlay("toast", { text: `Restore FAILED: ${error}`, ms: 9000 });
    warn(`resume: ${error}`);
    if (smokePath && !smokeStarted && !host.closing) startSmoke();
  }
  host.hotkey = name => hotkey(name);

  function scheduleReady() {
    if (!loaded) { registerPending = true; return; }
    clearTimeout(registerTimer);
    registerTimer = setTimeout(() => evalReady(), 250);
  }

  // ------------------------------------------------------------------ CDP events
  const cdpEvent = (method, p) => {
    switch (method) {
      case "Runtime.consoleAPICalled": return onConsole(p);
      case "Log.entryAdded": return onLogEntry(p.entry);
      case "Runtime.exceptionThrown": return onException(p.exceptionDetails);
      case "Page.screencastFrame": return onScreencast(p);
      default:
    }
  };

  function onConsole(p) {
    const level = consoleLevel(p.type);
    const text = consoleText(p.args);
    if (text.startsWith("%cElectron Security Warning")) return;     // Electron's own dev-mode CSP nag, not the game's
    const f = p.stackTrace?.callFrames?.[0];
    const src = f && f.url ? `${f.url.split("/").pop()}:${f.lineNumber + 1}` : undefined;
    const t = writer.t();
    pushLog({ t, source: "console", level, text, ...(src ? { src } : {}) });
    if (level === "error" || level === "warn") {
      writer.line("console", { level, text: oneLine(text, 2000), ...(src ? { src } : {}) }, t);
    }
    if (level === "error") {
      countError(text);
      if (host.cooldowns.ok("error", t, 5000)) host.requestMark("error", { summary: text });
    }
  }

  function onLogEntry(e) {
    if (!e) return;
    const level = e.level === "warning" ? "warn" : e.level === "error" ? "error" : e.level === "verbose" ? "debug" : "info";
    const text = `${e.text || ""}${e.url ? ` (${e.url})` : ""}`;
    const t = writer.t();
    pushLog({ t, source: e.source || "browser", level, text });
    if (level === "error" || level === "warn") {
      writer.line("console", { level, text: oneLine(text, 2000), src: e.source }, t);
      if (level === "error") countError(text);       // browser-originated errors count but never raise a mark
    }
  }

  function onException(d) {
    const { text, stack } = exceptionText(d);
    const t = writer.t();
    writer.line("exception", { text, ...(stack ? { stack } : {}) }, t);
    pushLog({ t, source: "exception", level: "error", text: stack ? `${text}\n${stack}` : text });
    countError(text);
    if (!bootWritten) { bootFail(text); return; }
    if (host.cooldowns.ok("exception", t, 5000)) host.requestMark("exception", { summary: text });
  }

  let framePending = false, shotsInWindow = 0, nth = nthFor(displayHz);
  // Never log a frame body: screencast frames are base64 (BRIEF-v1.4 §9).
  const startScreencast = () => host.cdp("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 480, everyNthFrame: nth });
  // everyNthFrame counts compositor frames, whose rate depends on the game: retune toward ~10 captured fps.
  if (!bare) setInterval(async () => {
    const got = shotsInWindow; shotsInWindow = 0;
    if (host.closing || got < 4) return;
    const rate = got / 3;
    if (rate < 7.5 || rate > 14) {
      const next = Math.max(1, Math.min(60, Math.round(nth * rate / 10)));
      if (next !== nth) {
        nth = next;
        try { await host.cdp("Page.stopScreencast"); await startScreencast(); } catch {}
      }
    }
  }, 3000).unref?.();
  function onScreencast(p) {
    shotsInWindow++;
    host.cdp("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    const buf = Buffer.from(p.data, "base64");
    const sz = jpegSize(buf) || {};
    const entry = { t: writer.t(), buf, frame: -1, w: sz.w, h: sz.h };
    host.ring.push(entry);
    const keep = config.ringSeconds * 1000 + 1500;
    while (host.ring.length && entry.t - host.ring[0].t > keep) host.ring.shift();
    if (host.readyLine?.sdk && !framePending) {
      framePending = true;
      host.evalRaw("(()=>{try{return globalThis.snapper.frame()}catch(e){return -1}})()", 1500)
        .then(f => { if (Number.isInteger(f)) { entry.frame = f; lastFrame = f; } })
        .finally(() => { framePending = false; });
    }
  }

  // ------------------------------------------------------------------ page -> host messages
  /** The tape ring flushed by the SDK (Int32Array frames and masks, `count` valid). */
  function onTape(frames, masks, count) {
    try {
      const t = writer.t();
      for (const l of tapeLinesFromFlush(frames, masks, count, t)) {
        const g = host.tapeGate;
        if (g) {
          // ticks made by the restore itself are not tape: the copied source segment replaces them (D-021)
          if (g.restoring) continue;
          if (isReload(l)) host.tapeGate = null;          // a real reset after the resume: back to normal
          else if (l.f <= g.upTo) continue;              // a late flush of restore ticks
        }
        tapeOut(l, { remember: true });
      }
    } catch {}
  }

  function onPage(kind, data) {
    try { onPageMessage(kind, data || {}); } catch (err) { warn(`bad message ${kind}: ${err.message}`); }
  }

  function onPageMessage(kind, d) {
    if (kind === "hello") {
      toOverlay("mode", overlayMode);
      toOverlay("marks", marksShown);
      pushStatus();
      try { hooks.onHello?.(); } catch {}
    } else if (kind === "reply") {
      const fn = pending.get(d.id);
      if (fn) {
        pending.delete(d.id);
        const out = d.out;
        if (out && typeof out === "object" && !Array.isArray(out)) out._t = writer.t();
        fn(out);
      }
    } else if (kind === "wall") {
      const tr = writer.t();
      for (const ev of d.ev || []) {
        const t = Math.max(0, round1(tr - (d.now - ev.pt)));
        const line = ev.k !== undefined ? { t, k: ev.k, d: ev.d } : { t, p: ev.p, b: ev.b, ax: ev.ax };
        host.wall.push(line);
        tapeOut(line);
        noteActivity(host.activity, t);
      }
      const cut = tr - 40000;
      while (host.wall.length && host.wall[0].t < cut) host.wall.shift();
    } else if (kind === "active") {
      // pointer activity (D-030): observed in the page, never recorded in the tape
      noteActivity(host.activity, Math.max(0, round1(writer.t() - (d.now - d.pt))));
    } else if (kind === "rects") {
      host.overlayHistory.push({ t: writer.t(), vw: d.vw, vh: d.vh, rects: d.rects || [] });
      const cut = writer.t() - (config.ringSeconds * 1000 + 8000);
      while (host.overlayHistory.length > 1 && host.overlayHistory[1].t < cut) host.overlayHistory.shift();
    } else if (kind === "fps") {
      onFps(d);
    } else if (kind === "padmark") {
      if (host.cooldowns.ok("gamepad", writer.t(), 2000)) host.requestMark("gamepad", { openNote: true });
    } else if (kind === "pads") {
      writer.patchEnv({ gamepads: Array.isArray(d) ? d : [] });
    } else if (kind === "note") {
      noteActivity(host.activity, writer.t());
      onNote(String(d.id), String(d.text || ""));
    } else if (kind === "command") {
      runCommand(d);
    } else if (kind === "sdk") {
      onSdk(d.type, d.payload || {});
    } else if (kind === "hotkey") {
      if (typeof d.name === "string") hotkey(d.name);                // attach: the page script's own keydown events
    } else if (kind === "preload-error") {
      warn(`page script: ${d}`);
    } else {
      try { hooks.onPageKind?.(kind, d); } catch (err) { warn(`page message ${kind}: ${err.message}`); }
    }
  }

  async function onFps(d) {
    if (host.restoring) return;                          // a restore blocks frames on purpose (D-021): not a pacing drop
    const f = await host.evalRaw("(()=>{try{return globalThis.snapper.frame()}catch(e){return -1}})()", 1500);
    const frame = Number.isInteger(f) ? f : lastFrame;
    const t = writer.t();
    writer.line("fps", { frame, worstMs: d.worstMs, drops: d.drops, expectedMs: d.expectedMs }, t);
    if (host.cooldowns.ok("fps", t, 10000)) host.requestMark("fps", { summary: `frame pacing: ${d.worstMs} ms (expected ${d.expectedMs} ms)` });
  }

  function onSdk(type, p) {
    const t = writer.t();
    const frame = Number.isInteger(p.frame) ? p.frame : -1;
    if (type === "register") scheduleReady();
    else if (type === "log") {
      const level = ["debug", "info", "warn", "error"].includes(p.level) ? p.level : "info";
      pushLog({ t, source: "sdk", level, text: String(p.msg ?? "") + (p.data !== undefined ? " " + JSON.stringify(p.data) : ""), frame });
      if (level === "warn" || level === "error") {
        writer.line("log", { frame, level, msg: String(p.msg ?? ""), ...(p.data !== undefined ? { data: p.data } : {}) }, t);
        if (level === "error") countError(String(p.msg ?? ""));
      }
    } else if (type === "event") {
      writer.line("event", { frame, name: String(p.name), ...(p.data !== undefined ? { data: p.data } : {}) }, t);
    } else if (type === "mark") {
      host.requestMark("api", { note: p.note ? String(p.note) : undefined, summary: p.note ? undefined : "api mark", data: p.data });
    } else if (type === "assert") {
      const msg = String(p.msg ?? "assertion failed");
      pushLog({ t, source: "sdk", level: "error", text: `assert: ${msg}`, frame });
      if (host.cooldowns.ok("assert:" + msg, t, 2000)) host.requestMark("assert", { summary: msg, data: p.data });
    } else if (type === "seed") {
      tapeOut({ f: frame, ev: "seed", seed: p.seed }, { remember: true });
    }
  }

  async function onNote(id, text) {
    const t = text.trim();
    if (!t || !/^\d{4}$/.test(id)) return;
    try {
      await writer.writeMarkFile(id, "note.txt", t + "\n");
      writer.line("note", { mark: id, text: t });
      const m = marksShown.find(x => x.id === id);
      if (m) { m.summary = oneLine(t); toOverlay("marks", marksShown); }
      await writer.renderSummary();
    } catch (err) { warn(`note for ${id}: ${err.message}`); }
  }

  async function runCommand(d) {
    const id = JSON.stringify(String(d.id));
    const arg = d.arg === undefined ? "undefined" : JSON.stringify(String(d.arg));
    const out = await host.evalRaw(`(()=>{try{return globalThis.snapper.__host.command(${id},${arg})}catch(e){return JSON.stringify({error:String(e)})}})()`, 5000);
    toOverlay("toast", `${d.id}: ${out == null ? "ok" : oneLine(String(out), 120)}`);
  }

  // ------------------------------------------------------------------ overlay mode, status polling, hotkeys
  let overlayMode = 0, paused = false;
  function pushStatus() {
    toOverlay("status", { marks: writer.lines.filter(l => l.kind === "mark").length, errors: host.errorCount, frame: lastFrame });
  }
  if (!bare) setInterval(async () => {
    if (host.closing || overlayMode === 2 || !host.readyLine?.sdk) return;
    const wantState = overlayMode === 1;
    const r = await host.evalJson(
      `(()=>{try{var s=globalThis.snapper;var o={frame:s.frame()};${wantState ? "o.state=s.__host.state();" : ""}return JSON.stringify(o)}catch(e){return null}})()`, 1500);
    if (!r) return;
    if (Number.isInteger(r.frame)) lastFrame = r.frame;
    pushStatus();
    if (wantState && typeof r.state === "string") {
      let txt = r.state;
      try { txt = JSON.stringify(JSON.parse(r.state), null, 1); } catch {}
      toOverlay("state", txt.length > 3000 ? txt.slice(0, 3000) + "\n…" : txt);
    }
  }, 500).unref?.();

  function hotkey(name) {
    if (host.restoring && name !== "overlay" && name !== "fullscreen") { toOverlay("toast", "restoring: wait until it finishes"); return; }
    if (name === "save") host.requestSave("manual", { trigger: "save" });
    else if (name === "mark") host.requestMark("hotkey", { openNote: true });
    else if (name === "overlay" && bare) toOverlay("toast", "bare session: no overlay");
    else if (name === "overlay") { overlayMode = (overlayMode + 1) % 3; toOverlay("mode", overlayMode); }
    else if (name === "fullscreen") { if (hooks.fullscreen) hooks.fullscreen(); }
    else if (name === "pause" || name === "step") {
      if (!host.readyLine?.stepper) { toOverlay("toast", "no stepper registered"); return; }
      if (name === "pause") {
        paused = !paused;
        host.evalRaw(`(()=>{try{globalThis.snapper.__host.${paused ? "pause" : "resume"}()}catch(e){}return 1})()`);
        toOverlay("toast", paused ? "paused (F10 resumes, F7 steps)" : "resumed");
      } else {
        host.evalRaw("(()=>{try{globalThis.snapper.__host.step(1,[])}catch(e){}return 1})()");
      }
    }
  }
  // Keyboard hotkeys reach the host differently per adapter (play: before-input-event; attach: the page script's "hotkey"
  // message). Defaults for a host that has none; app.mjs replaces them.
  host.hostKey = () => false;
  host.isHostKey = () => false;

  // ------------------------------------------------------------------ navigation
  /** Smoke `navigate` (D-022): load the game URL with a new query through CDP Page.navigate, then wait for the new document's ready. */
  host.navigate = async q => {
    const nq = String(q || "");
    const before = navCount;
    const target = baseUrl + (nq && baseUrl.includes("?") && nq.startsWith("?") ? "&" + nq.slice(1) : nq);
    const r = await host.cdp("Page.navigate", { url: target });
    if (r && r.errorText) throw new Error(`navigate to ${target} failed: ${r.errorText}`);
    const t0 = Date.now();
    while (readyNav <= before) {
      if (host.closing) return;
      if (Date.now() - t0 > 30000) throw new Error(`navigate: no ready within 30 s at ${target}`);
      await sleep(50);
    }
    await sleep(300);
  };
  let pauseParamSeen = RES?.pauseParam || "paused";
  let segQuery = query;                                   // the query the current document was loaded with
  /** { query: "?a=b", url } of a navigation's target; the pause param is not part of the game's query. */
  function navQuery(raw) {
    try {
      const u = new URL(raw);
      if (u.searchParams.has(pauseParamSeen)) u.searchParams.delete(pauseParamSeen);
      return { query: u.search, url: u.origin + u.pathname + u.search };
    } catch { return { query: "", url: String(raw) }; }
  }
  const nav = {
    /** A main-frame navigation to a new document started (did-start-navigation / Page.frameNavigated). */
    start(url) {
      if (!live) return;
      navCount++;
      segChecked = false;
      loadStart = Date.now();
      loaded = false;
      clearTimeout(registerTimer);
      if (navCount > 1) {
        const t = writer.t();
        // D-022: the new document's query and url, so a restore/replay boots this segment the way the player saw it.
        const n = navQuery(url);
        segQuery = n.query;
        writer.line("reload", n, t);
        if (host.tapeGate && !host.tapeGate.restoring) host.tapeGate = null;
        tapeOut({ f: 0, ev: "reload", t, ...n }, { remember: true });
        host.overlayHistory.length = 0;
      }
    },
    /** The document finished loading. */
    finish() {
      if (!live) return;
      loaded = true;
      loadMs = round1(Date.now() - loadStart);
      clearTimeout(fallbackTimer);
      const evalsAtLoad = readyEvals;
      fallbackTimer = setTimeout(() => { if (readyEvals === evalsAtLoad) evalReady(); }, 3000);
      if (registerPending) { registerPending = false; scheduleReady(); }
    },
    /** The main frame failed to load. */
    fail(desc, code, url) {
      if (!live) return;
      loaded = true;
      bootFail(`did-fail-load ${desc} (${code}) ${url}`);
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => evalReady(), 3000);
    },
    /** The renderer process died. */
    gone(reason, exitCode) {
      const t = writer.t();
      writer.line("exception", { text: `renderer process gone: ${reason}`, stack: `exitCode ${exitCode}` }, t);
      countError(`renderer gone: ${reason}`);
    },
    /** Attach without a reload: the document that is already open counts as navigation 1 and as loaded. */
    adoptCurrent() {
      navCount = 1;
      loadStart = Date.now();
      nav.finish();
    },
  };

  // ------------------------------------------------------------------ smoke
  let smokeResult = null;
  async function startSmoke() {
    smokeStarted = true;
    let script;
    try { script = JSON.parse(readFileSync(smokePath, "utf8")); } catch (err) {
      smokeResult = { ok: false, failures: [`cannot read smoke script ${smokePath}: ${err.message}`] };
      hooks.endSession?.();
      return;
    }
    const hard = setTimeout(() => { smokeResult = { ok: false, failures: ["smoke script timed out (180 s)"] }; hooks.endSession?.(); }, 180000);
    try { smokeResult = await runSmoke(host, script); }
    catch (err) { smokeResult = { ok: false, failures: [`smoke runner crashed: ${err && err.message}`] }; }
    clearTimeout(hard);
    hooks.endSession?.();
  }

  // ------------------------------------------------------------------ connect / close
  let connected = false;
  /** Subscribe the pipeline to the CDP interface (call once, before Page.enable). */
  function connect() {
    if (connected) return;
    connected = true;
    cdp.onAny((method, params) => { try { cdpEvent(method, params); } catch (err) { warn(`cdp ${method}: ${err.message}`); } });
    cdp.onClose(reason => {
      if (!host.closing) warn(cdp.kind === "debugger" ? `debugger detached: ${reason}` : `CDP connection closed: ${reason}`);
      try { hooks.onClosed?.(reason); } catch {}
    });
  }

  let finalizing = null;
  /** Save the exit state, stop the ring, write the end line + SESSION.md, the result file. Resolves ok. */
  function finalize() {
    if (finalizing) return finalizing;
    host.closing = true;
    finalizing = (async () => {
      clearTimeout(registerTimer); clearTimeout(fallbackTimer);
      try { await host.markChain; } catch {}
      // the exit state, always (paused, mid-note, Ctrl+C): D-021. Not when the connection is already gone.
      if (!cdp.closed) await saveCheckpoint(host, "exit", { trigger: "exit", timeoutMs: 2500, ...(host.restoring ? { reason: "the window closed while restoring" } : {}) });
      if (!bare && !cdp.closed) { try { await cdp.send("Page.stopScreencast"); } catch {} }
      if (!headerWritten) writeTapeHeader(null);
      const marks = writer.lines.filter(l => l.kind === "mark").length;
      const durationMs = writer.t();
      writer.line("end", { marks, errors: host.errorCount, durationMs, activeMs: activeTotal(host.activity, durationMs), idleMs: host.activity.idleMs });
      try { await writer.renderSummary(); await writer.renderReport?.(); await writer.flush(); } catch (err) { warn(`final flush: ${err.message}`); }
      const failures = smokeResult?.failures || [];
      const ok = smokePath ? !!smokeResult?.ok : true;
      writeResult({ session: writer.dir, ok, marks, failures });
      for (const f of failures) warn(`smoke failure: ${f}`);
      try { await hooks.beforeDetach?.(); } catch {}
      try { await cdp.detach(); } catch {}
      return ok;
    })();
    return finalizing;
  }

  return {
    host, connect, nav, onPage, onTape, hotkey, startScreencast, finalize,
    setLive(v) { live = !!v; if (live) loadStart = Date.now(); },
    get finalizing() { return finalizing; },
    get smokeResult() { return smokeResult; },
    get smokeStarted() { return smokeStarted; },
    startSmoke,
  };
}
