// Snapper page script (v1.4, CONTRACTS.md "W1"): everything the preload used to do below the bridge, as ONE plain function
// with no module syntax and no require, so it runs unchanged in two places:
//   - the Electron preload (preload.cjs embeds this file VERBATIM between the marker lines; scripts/make-preload.mjs
//     regenerates it and tests/unit/page-js.test.mjs fails when they differ), over ipcRenderer, and
//   - the attach injection (main/attach-inject.mjs), in the page's main world, over a CDP binding.
// OPTS = the preload options { hotkeys, padMark, padMarkHoldMs, fpsDropMs, fpsDropRun, expectedMs, bare } plus
//        { attach: bool, inPageHotkeys: bool } (attach mode: hotkeys are this script's own keydown events).
// T    = { send(kind, data), sendTape(frames: Int32Array, masks: Int32Array, count), listen(fn(kind, data)), exposeBridge(obj) }.
// Page -> host kinds: hello, reply {id,out}, wall, rects, fps, padmark, pads, note {id,text}, command, sdk {type,payload},
//                     preload-error, active {now, pt} (v1.4.1, D-030: the last pointer activity, at most one per wall flush),
//                     and (attach only) hotkey {name}.
// Host -> page kinds: arm, mode, status, error, toast, restore, note, marks, commands, state, ask {id, what}, and (attach only) dispose.
// Tester mode (v1.4, play only): host -> page `name` {title} (the one-time name prompt, an input like the note box) and
// `hint` {text, ms} (the chip shows the text for ms, then the normal chip); page -> host `tester-name` {text} (Enter: the
// name; Esc: text ""). A `note` message may carry `plain: true`: its text is the whole box title (no "type a note" suffix).
function snapperPage(OPTS, T) {
  "use strict";
  OPTS = OPTS || {};
  const HK = Object.assign({ mark: "F8", overlay: "F9", pause: "F10", step: "F7", fullscreen: "F11", save: "F6" }, OPTS.hotkeys || {});

  const BARE = OPTS.bare === true;                     // v1.3 (--bare): nothing continuous on the host side; the overlay is built only when a toast / the note box must show
  const IN_PAGE_HK = OPTS.inPageHotkeys === true;      // v1.4 attach: the host never sees the keyboard, so this script turns hotkeys into messages

  let disposed = false;                                // attach: the host detached; nothing runs or is sent any more
  const cleanups = [];
  const P = (kind, data) => { if (disposed) return; try { T.send(kind, data); } catch {} };
  const listen = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); cleanups.push(() => { try { target.removeEventListener(type, fn, opt); } catch {} }); };
  const every = (fn, ms) => { const h = setInterval(fn, ms); cleanups.push(() => { try { clearInterval(h); } catch {} }); return h; };
  let rafHandle = 0;

  // ---------------------------------------------------------------- bridge (D-013)
  const BRIDGE_TYPES = new Set(["register", "log", "event", "mark", "assert", "seed"]);
  T.exposeBridge({
    send(type, payload) {
      try {
        if (BRIDGE_TYPES.has(type)) P("sdk", { type, payload: payload === undefined ? {} : payload });
      } catch {}
    },
    sendTape(frames, masks, count) {
      try {
        if (disposed) return;
        const n = Math.max(0, Math.min(count | 0, frames.length, masks.length));
        if (n) T.sendTape(Int32Array.from(frames.subarray(0, n)), Int32Array.from(masks.subarray(0, n)), n);
      } catch {}
    },
  });

  // ---------------------------------------------------------------- frame intervals
  const CAP = 6000;                                   // 20 s at 240 Hz
  const ivRing = new Float64Array(CAP), endRing = new Float64Array(CAP);
  let ivHead = 0, ivCount = 0, lastTs = 0;
  let armedAt = Infinity;                             // detection starts 2 s after ready
  let lastFpsAt = -1e9, run = 0, runMax = 0;
  const expectedFixed = Number(OPTS.expectedMs) > 0 ? Number(OPTS.expectedMs) : 0;

  function median(n) {
    const k = Math.min(n, ivCount);
    if (!k) return 16.7;
    const a = [];
    for (let i = 0; i < k; i++) a.push(ivRing[(ivHead - 1 - i + CAP) % CAP]);
    a.sort((x, y) => x - y);
    return a[k >> 1];
  }
  const expected = () => expectedFixed || median(120);

  function recentIntervals(windowMs) {
    const now = performance.now();
    const iv = [], en = [];
    for (let k = 0; k < ivCount; k++) {
      const j = (ivHead - ivCount + k + CAP) % CAP;
      if (now - endRing[j] <= windowMs) { iv.push(ivRing[j]); en.push(endRing[j]); }
    }
    return { iv, en };
  }

  // ---------------------------------------------------------------- keyboard + gamepad (wall lines)
  let wallBuf = [];
  const downSet = new Set();
  const swallowed = new Set();                        // codes whose keydown the game never saw: swallow the keyup too
  let typing = false;                                 // set by the capture listener (note box / panel input focused)

  const bits = pad => {
    let b = 0;
    for (let i = 0; i < pad.buttons.length && i < 31; i++) if (pad.buttons[i].pressed) b |= 1 << i;
    return b;
  };
  const axesOf = pad => Array.from(pad.axes, v => (Math.abs(v) < 0.04 ? 0 : Math.round(v * 100) / 100));

  const padLast = new Map();
  let comboSince = -1, comboFired = false, lastPadMarkAt = -1e9;
  const padMark = Array.isArray(OPTS.padMark) ? OPTS.padMark : [8, 9];
  const padHold = Number(OPTS.padMarkHoldMs) || 400;
  // standard-mapping button names (Gamepad API): 8 = Back/Select/View, 9 = Start/Menu
  const PAD_NAMES = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "LS", "RS", "Up", "Down", "Left", "Right", "Guide"];
  const padName = n => PAD_NAMES[n] ? `${PAD_NAMES[n]}(${n})` : String(n);

  function pollPads(ts) {
    let pads;
    try { pads = navigator.getGamepads(); } catch { return; }
    let held = false, any = false;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p) continue;
      any = true;
      const b = bits(p), ax = axesOf(p), key = ax.join(",");
      const last = padLast.get(i);
      if (!last || last.b !== b || last.key !== key) {
        padLast.set(i, { b, key });
        wallBuf.push({ pt: ts, p: i, b, ax });
      }
      if (padMark.length && padMark.every(n => p.buttons[n] && p.buttons[n].pressed)) held = true;
    }
    if (!any) return;
    if (!held) { comboSince = -1; comboFired = false; return; }
    if (comboSince < 0) comboSince = ts;
    if (!comboFired && ts - comboSince >= padHold) {
      comboFired = true;
      if (ts - lastPadMarkAt >= 2000) { lastPadMarkAt = ts; P("padmark", {}); }
    }
  }

  function onFrame(ts) {
    if (disposed) return;
    rafHandle = requestAnimationFrame(onFrame);
    if (document.visibilityState !== "visible") { lastTs = 0; run = 0; return; }
    if (lastTs) {
      const iv = ts - lastTs;
      ivRing[ivHead] = iv; endRing[ivHead] = ts;
      ivHead = (ivHead + 1) % CAP; if (ivCount < CAP) ivCount++;
      if (ts >= armedAt) detect(iv, ts);
    }
    lastTs = ts;
    pollPads(ts);
  }

  function detect(iv, ts) {
    const exp = expected();
    if (iv > 2 * exp) { run++; if (iv > runMax) runMax = iv; } else { run = 0; runMax = 0; }
    const single = iv >= (Number(OPTS.fpsDropMs) || 250);
    const runHit = run >= (Number(OPTS.fpsDropRun) || 10);
    if ((single || runHit) && ts - lastFpsAt >= 10000) {
      lastFpsAt = ts;
      P("fps", { worstMs: Math.round(Math.max(iv, runMax) * 10) / 10, drops: single ? 1 : run, expectedMs: Math.round(exp * 1000) / 1000, kind: single ? "single" : "run" });
      run = 0; runMax = 0;
    }
  }
  rafHandle = requestAnimationFrame(onFrame);

  // Played time (v1.4.1, D-030): pointer events are observed (passive, capture phase) for their time only, never recorded.
  let lastActive = performance.now(), pointerPt = 0, pointerSent = 0;
  const onPointer = () => { pointerPt = performance.now(); };
  function flushWall() {
    if (pointerPt > pointerSent) {
      pointerSent = pointerPt;
      if (pointerPt > lastActive) lastActive = pointerPt;
      P("active", { now: performance.now(), pt: pointerPt });
    }
    if (!wallBuf.length) return;
    const batch = wallBuf; wallBuf = [];
    const pt = batch[batch.length - 1].pt;
    if (pt > lastActive) lastActive = pt;
    P("wall", { now: performance.now(), ev: batch });
  }
  every(flushWall, 250);

  // ---------------------------------------------------------------- keyboard capture
  const hkHeld = new Set();                           // attach: hotkey codes whose keydown was taken (their keyup is taken too)
  const HK_NAMES = ["mark", "overlay", "save", "pause", "step"];   // attach: F11 / F12 / F5 stay the browser's
  const hotkeyFor = code => { for (const n of HK_NAMES) if (HK[n] === code) return n; return null; };
  const stopEv = e => { e.stopImmediatePropagation(); e.stopPropagation(); };
  function onKey(e) {
    const down = e.type === "keydown";
    if (e.type === "keypress") { if (noteOpen || (hostEl && document.activeElement === hostEl)) stopEv(e); return; }
    const code = e.code || e.key;
    if (IN_PAGE_HK) {
      // attach mode: the browser owns the keyboard, so the host's hotkeys are this script's own keydown events (the game never sees them)
      if (down) {
        const name = !e.ctrlKey && !e.altKey && !e.metaKey ? hotkeyFor(code) : null;
        if (name) {
          if (!e.repeat && !hkHeld.has(code)) { hkHeld.add(code); P("hotkey", { name }); }
          e.preventDefault(); stopEv(e);
          return;
        }
      } else if (hkHeld.has(code)) { hkHeld.delete(code); e.preventDefault(); stopEv(e); return; }
    }
    // While a save state is restored (D-021) the game must not see the player's keys: the host is stepping it.
    // Keyups still pass so nothing pressed before the restore stays stuck.
    if (restoring && e.type !== "keyup") { e.preventDefault(); stopEv(e); return; }
    typing = noteOpen || (hostEl && document.activeElement === hostEl);
    if (typing) {
      // A key pressed before the box opened still gets its keyup (no stuck keys in the game).
      if (!down && downSet.has(code)) {
        downSet.delete(code);
        wallBuf.push({ pt: performance.now(), k: code, d: 0 });
        return;
      }
      if (down && e.repeat && downSet.has(code)) { e.preventDefault(); stopEv(e); return; }
      stopEv(e);
      if (!down) { swallowed.delete(code); return; }
      swallowed.add(code);
      if (noteOpen) {
        if (e.key === "Enter") { e.preventDefault(); submitNote(); }
        else if (e.key === "Escape") { e.preventDefault(); cancelNote(); }
      } else {
        const a = shadow && shadow.activeElement;
        if (e.key === "Enter" && a === argInput) { e.preventDefault(); runCommand(selectedCmd); }
        else if (e.key === "Escape" && a) { e.preventDefault(); a.blur(); }
      }
      return;
    }
    if (!down && swallowed.has(code)) { swallowed.delete(code); stopEv(e); return; }
    if (down) { if (e.repeat || downSet.has(code)) return; downSet.add(code); }
    else downSet.delete(code);
    wallBuf.push({ pt: performance.now(), k: code, d: down ? 1 : 0 });
  }
  listen(window, "keydown", onKey, true);
  listen(window, "keyup", onKey, true);
  listen(window, "pointerdown", onPointer, { capture: true, passive: true });
  listen(window, "pointermove", onPointer, { capture: true, passive: true });
  listen(window, "wheel", onPointer, { capture: true, passive: true });
  listen(window, "keypress", onKey, true);
  listen(window, "blur", () => { /* keep downSet: keyups may still arrive */ });
  listen(window, "gamepadconnected", () => P("pads", padList()));
  listen(window, "gamepaddisconnected", () => P("pads", padList()));
  function padList() {
    try {
      return Array.from(navigator.getGamepads()).filter(Boolean).map(p => ({ index: p.index, id: p.id, mapping: p.mapping || "" }));
    } catch { return []; }
  }

  // ---------------------------------------------------------------- overlay
  let hostEl = null, shadow = null, mode = 0, captureHidden = false;
  let chip, errEl, toastEl, noteEl, noteInput, noteLabel, panel, marksEl, stateEl, cmdsEl, argInput, legendEl;
  let restoreEl, restoreText, restoreBar, restoring = false, restoreData = null;
  let noteOpen = false, noteId = null, noteKind = "note", toastTimer = 0, errTimer = 0, selectedCmd = null;
  let hintText = "", hintUntil = 0;                   // tester mode: the chip's first-seconds hint
  let status = { frame: null, marks: 0, errors: 0 };
  let commands = [], marksList = [];

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .wrap{position:fixed;inset:0;pointer-events:none;font:12px/1.35 ui-monospace,Consolas,"Cascadia Mono",monospace;color:#e8e8e8}
  .chip{position:absolute;top:8px;right:8px;padding:3px 8px;background:rgba(10,10,14,.62);border-radius:4px;white-space:nowrap}
  .chip b{color:#ff4d4d;font-weight:400}
  .err{position:absolute;top:30px;right:8px;max-width:46vw;padding:3px 8px;background:rgba(40,0,0,.7);color:#ff6b6b;border-radius:4px;opacity:0;transition:opacity .6s;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .err.on{opacity:1}
  .toast{position:absolute;left:50%;bottom:72px;transform:translateX(-50%);padding:5px 12px;background:rgba(10,10,14,.8);border-radius:4px;display:none}
  .note{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);width:min(560px,90vw);padding:8px;background:rgba(10,10,14,.9);border:1px solid #4a7;border-radius:6px;display:none;pointer-events:auto}
  .note div{margin-bottom:4px;color:#9c9}
  .note input,.panel input{width:100%;font:inherit;color:#fff;background:#000;border:1px solid #555;border-radius:3px;padding:4px 6px}
  .panel{position:absolute;top:56px;right:8px;width:min(380px,44vw);max-height:calc(100vh - 72px);overflow:auto;padding:8px;background:rgba(10,10,14,.82);border-radius:6px;display:none;pointer-events:auto}
  .panel h4{margin:8px 0 3px;font-size:11px;color:#8ab;font-weight:400;text-transform:uppercase}
  .panel h4:first-child{margin-top:0}
  .panel pre{margin:0;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;color:#cfc}
  .panel .m{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .panel button{font:inherit;color:#eee;background:#234;border:1px solid #567;border-radius:3px;padding:2px 7px;margin:0 4px 4px 0;cursor:pointer}
  .panel .hk{color:#aaa}
  .restore{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,86vw);padding:14px 18px;background:rgba(10,10,14,.92);border:1px solid #58a;border-radius:8px;display:none;text-align:center;font-size:15px}
  .restore .bar{height:6px;margin-top:10px;background:#223;border-radius:3px;overflow:hidden}
  .restore .bar i{display:block;height:100%;width:0;background:#6af}
  .restore small{display:block;margin-top:8px;color:#9ab;font-size:11px}
  `;

  function mk(tag, cls, parent) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
  }

  function buildOverlay() {
    if (hostEl || !document.documentElement) return;
    hostEl = document.createElement("div");
    hostEl.setAttribute("data-snapper-overlay", "");
    hostEl.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    shadow = hostEl.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);
    const wrap = mk("div", "wrap", shadow);
    chip = BARE ? null : mk("div", "chip", wrap);
    errEl = mk("div", "err", wrap);
    toastEl = mk("div", "toast", wrap);
    noteEl = mk("div", "note", wrap);
    noteLabel = mk("div", "", noteEl);
    noteInput = mk("input", "", noteEl);
    noteInput.type = "text";
    noteInput.placeholder = "what felt wrong?";
    noteInput.spellcheck = false;
    panel = mk("div", "panel", wrap);
    mk("h4", "", panel).textContent = "Marks";
    marksEl = mk("div", "", panel);
    mk("h4", "", panel).textContent = "State";
    stateEl = mk("pre", "", panel);
    mk("h4", "", panel).textContent = "Commands";
    cmdsEl = mk("div", "", panel);
    argInput = mk("input", "", panel);
    argInput.type = "text";
    argInput.placeholder = "argument";
    argInput.style.display = "none";
    mk("h4", "", panel).textContent = "Hotkeys";
    legendEl = mk("div", "hk", panel);
    legendEl.textContent = OPTS.attach === true
      ? `${HK.mark} mark · ${HK.save} save state · ${HK.overlay} overlay · ${HK.pause} pause · ${HK.step} step (only while this page has focus) · pad ${padMark.map(padName).join("+")} held ${(padHold / 1000).toFixed(1)} s = mark`
      : `${HK.mark} mark · ${HK.save} save state · ${HK.overlay} overlay · ${HK.pause} pause · ${HK.step} step · ${HK.fullscreen} fullscreen · F12 devtools · F5 reload · pad ${padMark.map(padName).join("+")} held ${(padHold / 1000).toFixed(1)} s = mark`;
    restoreEl = mk("div", "restore", wrap);
    restoreText = mk("div", "", restoreEl);
    restoreBar = mk("i", "", mk("div", "bar", restoreEl));
    mk("small", "", restoreEl).textContent = "replaying the saved run · audio muted · input ignored until it finishes";
    document.documentElement.appendChild(hostEl);
    renderRestore();
    applyMode();
    renderChip();
    reportRects();
  }

  function applyMode() {
    if (!hostEl) return;
    hostEl.style.display = mode === 2 || captureHidden ? "none" : "";
    panel.style.display = mode === 1 ? "block" : "none";
    reportRects();
  }

  const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");
  // " · idle N m" after a minute with no key, pad or pointer activity (D-030); a note box being typed in is not idle
  const idleText = () => {
    const ms = performance.now() - lastActive;
    return noteOpen || ms < 60000 ? "" : ` · idle ${Math.floor(ms / 60000)} m`;
  };
  function renderChip() {
    if (!chip) return;
    const { iv } = recentIntervals(1000);
    const avg = iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : NaN;
    chip.innerHTML = "";
    if (hintText && performance.now() < hintUntil) { chip.textContent = hintText; return; }
    const dot = mk("b", "", chip); dot.textContent = "●";
    chip.appendChild(document.createTextNode(
      ` REC · ${fmt(1000 / avg)} fps · ${fmt(avg)} ms · f ${status.frame == null || status.frame < 0 ? "–" : status.frame} · marks ${status.marks} · ⚠ ${status.errors}${idleText()}`));
  }

  function renderRestore() {
    if (!restoreEl) return;
    if (!restoreData) { restoreEl.style.display = "none"; reportRects(); return; }
    restoreText.textContent = String(restoreData.text || "Restoring…");
    restoreBar.style.width = `${Math.max(0, Math.min(100, Number(restoreData.pct) || 0)).toFixed(1)}%`;
    restoreEl.style.display = "block";
    reportRects();
  }

  function showToast(text, ms = 2500) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = "none"; }, ms);
  }
  function showError(text) {
    if (!errEl) return;
    errEl.textContent = text;
    errEl.classList.add("on");
    clearTimeout(errTimer);
    errTimer = setTimeout(() => errEl.classList.remove("on"), 8000);
  }

  function openNote(id, text, kind, plain) {
    if (noteOpen && noteInput.value.trim()) submitNote();
    noteOpen = true; noteId = id; noteKind = kind === "name" ? "name" : "note";
    noteLabel.textContent = noteKind === "name" ? `${text}` : plain ? `${text}` : `${text} · type a note (Enter saves, Esc skips)`;
    noteInput.placeholder = noteKind === "name" ? "your name (Enter saves, Esc skips)" : plain ? "type here (Enter sends, Esc skips)" : "what felt wrong?";
    noteInput.value = "";
    noteEl.style.display = "block";
    toastEl.style.display = "none";
    try { noteInput.focus(); } catch {}
  }
  function closeNote() {
    noteOpen = false;
    if (noteEl) noteEl.style.display = "none";
    try { noteInput.blur(); } catch {}
  }
  function submitNote() {
    const text = noteInput.value.trim();
    const id = noteId, kind = noteKind;
    closeNote();
    if (kind === "name") { P("tester-name", { text }); if (text) showToast("Thanks", 1200); return; }
    if (text) { P("note", { id, text }); showToast(`Note saved for mark ${id}`, 1500); }
  }
  function cancelNote() {
    const kind = noteKind;
    closeNote();
    if (kind === "name") P("tester-name", { text: "" });
  }

  function renderMarks() {
    if (!marksEl) return;
    marksEl.textContent = "";
    for (const m of marksList.slice(-12)) {
      const d = mk("div", "m", marksEl);
      d.textContent = `${m.id}  ${m.t}  ${m.trigger}  ${m.summary || ""}`;
    }
    if (!marksList.length) marksEl.textContent = "none yet";
  }

  function renderCommands() {
    if (!cmdsEl) return;
    cmdsEl.textContent = "";
    let needArg = false;
    for (const c of commands) {
      const b = mk("button", "", cmdsEl);
      b.textContent = c.label || c.id;
      if (c.arg) { needArg = true; b.title = "uses the argument box"; }
      b.addEventListener("click", () => runCommand(c));
    }
    if (!commands.length) cmdsEl.textContent = "none registered";
    argInput.style.display = needArg ? "block" : "none";
  }
  function runCommand(c) {
    if (!c) return;
    P("command", { id: c.id, arg: c.arg ? argInput.value : undefined });
  }

  // Report the overlay's visible rectangles (CSS px) whenever they change (D-015).
  let lastRects = "";
  function reportRects() {
    if (BARE || !hostEl || captureHidden) return;       // bare: no ring frames to blank, nothing to report
    const rects = [];
    if (mode !== 2) {
      const add = el => {
        if (!el || getComputedStyle(el).display === "none") return;
        if (el === errEl && !el.classList.contains("on")) return;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        const x = Math.floor(r.left / 8) * 8, y = Math.floor(r.top / 8) * 8;
        rects.push({ x, y, w: Math.ceil(r.right / 8) * 8 - x, h: Math.ceil(r.bottom / 8) * 8 - y });
      };
      add(chip); add(errEl); add(toastEl); add(noteEl); add(panel); add(restoreEl);
    }
    const s = JSON.stringify(rects) + innerWidth + "x" + innerHeight;
    if (s === lastRects) return;
    lastRects = s;
    P("rects", { vw: innerWidth, vh: innerHeight, rects });
  }

  function ensureOverlay() {
    if (!hostEl) { buildOverlay(); return; }
    if (!hostEl.isConnected && document.documentElement) document.documentElement.appendChild(hostEl);
  }

  if (!BARE) {
    every(() => {
      ensureOverlay();
      renderChip();
      reportRects();
    }, 250);
    if (document.readyState === "loading") listen(document, "DOMContentLoaded", buildOverlay, { once: true });
    else buildOverlay();
  }

  // ---------------------------------------------------------------- main → preload
  const raf2 = () => new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    requestAnimationFrame(() => requestAnimationFrame(fin));
    setTimeout(fin, 350);
  });

  T.listen(async (kind, data) => {
    try {
      if (disposed) return;
      if (kind === "dispose") { dispose(); return; }
      if (kind === "arm") { armedAt = performance.now() + 2000; run = 0; runMax = 0; lastFpsAt = -1e9; }
      else if (kind === "mode") { if (BARE) return; mode = data | 0; ensureOverlay(); applyMode(); lastRects = ""; }
      else if (kind === "status") { Object.assign(status, data); renderChip(); }
      else if (kind === "error") { if (!BARE) showError(String(data)); }
      else if (kind === "toast") {
        ensureOverlay();
        if (data && typeof data === "object") showToast(String(data.text), Number(data.ms) || 2500);
        else showToast(String(data));
      }
      else if (kind === "restore") { ensureOverlay(); restoreData = data || null; restoring = !!restoreData; renderRestore(); }
      else if (kind === "note") { ensureOverlay(); openNote(data.id, data.text, "note", data.plain === true); }
      else if (kind === "name") { ensureOverlay(); openNote(null, data && data.title ? String(data.title) : "Your name", "name", true); }
      else if (kind === "hint") { hintText = data && data.text ? String(data.text) : ""; hintUntil = performance.now() + (Number(data && data.ms) || 10000); renderChip(); }
      else if (kind === "marks") { marksList = data || []; renderMarks(); }
      else if (kind === "commands") { commands = data || []; selectedCmd = commands.find(c => c.arg) || null; renderCommands(); }
      else if (kind === "state") { if (stateEl) stateEl.textContent = String(data); }
      else if (kind === "ask") {
        const { id, what } = data;
        let out = null;
        if (what === "snap") {
          flushWall();
          const { iv, en } = recentIntervals(Number(data.windowMs) || 10000);
          out = { now: performance.now(), intervals: iv, ends: en, pads: padList() };
        } else if (what === "hide") {
          if (hostEl) { captureHidden = true; applyMode(); await raf2(); }
          out = true;
        } else if (what === "show") {
          captureHidden = false; applyMode(); lastRects = ""; out = true;
        } else if (what === "pads") out = padList();
        P("reply", { id, out });
      }
    } catch (err) {
      P("preload-error", String(err && err.stack || err));
    }
  });

  // attach: the host detaches. Remove everything this script added to the page (overlay, listeners, timers, the rAF loop).
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const f of cleanups.splice(0)) { try { f(); } catch {} }
    try { cancelAnimationFrame(rafHandle); } catch {}
    clearTimeout(toastTimer); clearTimeout(errTimer);
    try { if (hostEl) hostEl.remove(); } catch {}
    hostEl = null; shadow = null;
  }

  P("hello", { url: location.href });
}
