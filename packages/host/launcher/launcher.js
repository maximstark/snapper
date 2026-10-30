// Launcher page logic. Classic script; talks to the main process only through window.snapperLauncher (preload.cjs).
"use strict";
(() => {
  const api = window.snapperLauncher;
  const $ = id => document.getElementById(id);
  const S = {
    playing: null, replaying: false, checking: false, rows: [], hook: false, replayDir: null, replaySession: null, replayMark: null,
    bundled: false, checkRows: [], checkRoot: "", attached: false, targets: [], rememberedTarget: "", setupRecipeShown: true,
  };
  const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";

  const fields = () => ({
    root: $("root").value.trim(), preset: $("preset").value, fullscreen: $("fullscreen").checked, query: $("query").value.trim(),
    url: $("url").value.trim(), hotkey: $("hotkey").value.trim(), padHoldMs: $("padHold").value.trim(), ringSeconds: $("ring").value.trim(),
    bare: $("bare").checked,
    endpoint: $("attach-endpoint").value.trim(), target: S.targets.length > 1 ? $("attach-target").value : "",
  });
  /** The differing paths of a check row / replay result: up to three `diffs`, else `firstDiff`. */
  const diffsOf = r => (Array.isArray(r.diffs) && r.diffs.length ? r.diffs.slice(0, 3).join(", ") : r.firstDiff || "");
  /** Render `code` spans of a plain string as <code> elements into `box`. */
  function richText(box, text) {
    box.replaceChildren();
    String(text).split("`").forEach((part, i) => { if (part) box.append(i % 2 ? el("code", {}, part) : document.createTextNode(part)); });
  }
  const setError = msg => { $("error").hidden = !msg; $("error").textContent = msg || ""; };
  const setCmd = cmd => { $("cmd").textContent = cmd ? `$ ${cmd}` : ""; };
  const el = (tag, attrs = {}, text = "") => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text) e.textContent = text;
    return e;
  };
  const failed = r => (r && r.error ? (setError(r.error), true) : false);

  let toastTimer = null;
  function toast(text) {
    const t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
  }

  /** Show a root's saved fields; the capture fields show the saved override, else the game's own (effective) value. */
  function applyInfo(info) {
    const f = info.fields, e = info.effective;
    S.bundled = !!info.bundled;
    $("root").value = info.root || "";
    $("preset").value = f.preset; $("fullscreen").checked = !!f.fullscreen; $("query").value = f.query || "";
    $("url").value = f.url || "";
    $("hotkey").value = f.hotkey || e.hotkey || "";
    $("padHold").value = f.padHoldMs ?? e.padHoldMs ?? "";
    $("ring").value = f.ringSeconds ?? e.ringSeconds ?? "";
    $("bare").checked = !!f.bare || e.bare === true;
    $("hotkey").placeholder = e.hotkey || "F8";
    $("attach-endpoint").value = info.attach?.endpoint || DEFAULT_ENDPOINT;
    S.rememberedTarget = info.attach?.target || "";
    if (!S.attached) loadTargets(true);
    $("capture-hint").textContent = `game's own: ${e.hotkey} · ${e.padHoldMs} ms · ${e.ringSeconds} s${e.bare ? " · bare" : ""}`;
    if (info.recent) renderRecent(info.recent);
    busy();
  }

  function renderRecent(recent) {
    const box = $("recent");
    box.replaceChildren();
    recent.forEach((root, i) => {
      const b = el("button", { id: `recent-${i}`, type: "button", title: root }, root);
      b.addEventListener("click", () => { $("root").value = root; rootChanged(); });
      box.append(b);
    });
  }

  function busy() {
    const idle = !S.playing && !S.replaying && !S.checking;
    const hasRoot = !!$("root").value.trim();
    $("play").disabled = !!S.playing || S.checking;
    $("try").disabled = !!S.playing || S.checking || !$("demos").options.length;
    $("setup").disabled = !hasRoot || S.bundled;
    $("attach").disabled = S.attached ? false : (!!S.playing || S.checking);
    $("attach").textContent = S.attached ? "Detach" : "Attach";
    $("attach-endpoint").disabled = S.attached;
    $("attach-target").disabled = S.attached;
    $("check").disabled = !hasRoot || !idle;
    document.querySelectorAll("[data-needs-idle]").forEach(b => { b.disabled = !!S.playing || S.checking; });
    document.querySelectorAll("[data-needs-noreplay]").forEach(b => { b.disabled = S.replaying || S.checking || b.dataset.empty === "1"; });
    document.querySelectorAll("[data-needs-checkidle]").forEach(b => { b.disabled = S.checking; });
    $("status").textContent = S.playing ? `${S.attached ? "Attached" : "Playing"} · ${S.playing === "starting" ? "starting…" : S.playing}`
      : S.checking ? "Checking…" : ($("status").dataset.last || "");
  }

  function rowEl(r, i) {
    const p = `row-${i}`;
    const card = el("div", { class: "session" });
    const head = el("div", { class: "head" }, r.id);
    if (r.tester) head.append(" ", el("span", { class: "from" }, `from ${r.tester}`));
    card.append(head);
    const states = r.checkpoints > 0 ? `  ·  states ${r.checkpoints}${r.exitFrame != null ? ` (exit f${r.exitFrame})` : ""}` : "";
    card.append(el("div", { class: "meta" }, `marks ${r.marks}  ·  errors ${r.errors}  ·  ${r.duration}${r.live ? "  ·  live" : ""}${states}`));
    const acts = el("div", { class: "actions" });

    const resume = el("button", { id: `${p}-resume`, type: "button", "data-needs-idle": "" }, "Resume");
    const at = el("select", { id: `${p}-at`, class: "resume-at", "aria-label": "Resume from" });
    at.append(new Option("exit", "exit"));
    const rg = el("div", { class: "group" }); rg.append(resume, at);

    const replay = el("button", { id: `${p}-replay`, type: "button", "data-needs-noreplay": "", "data-empty": "1" }, "Replay");
    const rm = el("select", { id: `${p}-replay-mark`, class: "picker", "aria-label": "Replay mark" });
    const pg = el("div", { class: "group" }); pg.append(replay, rm);

    const open = el("button", { id: `${p}-open`, type: "button" }, "Open folder");
    const md = el("button", { id: `${p}-md`, type: "button" }, "SESSION.md");
    const report = el("button", { id: `report-${p}`, type: "button", title: "Open SESSION.html (regenerated now) in your browser" }, "Open report");
    // Copy for Claude on a row copies the session line (no mark); the replay result's button carries the mark.
    const copy = el("button", { id: `copy-${p}`, type: "button", title: "Copy a line that tells Claude to read this session" }, "Copy for Claude");
    acts.append(rg, pg, open, md, report, copy);
    card.append(acts);

    resume.addEventListener("click", () => doResume(r, at.value));
    replay.addEventListener("click", () => doReplay(r, rm.value));
    open.addEventListener("click", async () => { failed(await api.openPath(r.path)); });
    md.addEventListener("click", async () => { failed(await api.openPath(r.path + "/SESSION.md")); });
    copy.addEventListener("click", async () => { if (!failed(await api.copyForClaude(r.path, ""))) toast("Copied"); });
    report.addEventListener("click", async () => { setError(null); failed(await api.openReport(r.path)); });

    api.checkpoints(r.path).then(res => {
      if (res.error || !res.list.length) { resume.dataset.noStates = "1"; at.replaceChildren(); resume.disabled = true; resume.removeAttribute("data-needs-idle"); resume.title = "no saved states"; return; }
      at.replaceChildren();
      for (const c of res.list) if (c.restorable) at.append(new Option(c.label || `${c.name} (f${c.frame})`, c.name));
      if (!at.options.length) { resume.disabled = true; resume.removeAttribute("data-needs-idle"); resume.title = "no restorable states"; return; }
      const ex = [...at.options].find(o => o.value === "exit");
      if (ex) at.value = "exit";
      busy();
    });
    api.marks(r.path).then(res => {
      if (res.error || !res.marks.length) { replay.disabled = true; replay.title = "no marks"; return; }
      for (const m of res.marks) rm.append(new Option(m.label, m.id));
      replay.dataset.empty = "0"; busy();
    });
    return card;
  }

  async function refresh() {
    const root = $("root").value.trim();
    const list = $("list");
    if (!root) { list.replaceChildren(el("div", { class: "empty" }, "Pick a game folder to see its sessions.")); S.rows = []; return; }
    const res = await api.listSessions(root);
    if (res.error) { list.replaceChildren(el("div", { class: "empty" }, res.error)); return; }
    S.rows = res.rows;
    list.replaceChildren(...(res.rows.length ? res.rows.map(rowEl) : [el("div", { class: "empty" }, `No sessions yet under ${res.out}`)]));
    busy();
  }

  async function rootChanged() {
    setError(null);
    const info = await api.setRoot($("root").value);
    if (failed(info)) return;
    applyInfo(info);
    refresh();
  }

  async function start(call) {
    setError(null);
    S.playing = "starting"; busy();
    const res = await call();
    if (res.error) { S.playing = null; setError(res.error); busy(); return res; }
    setCmd(res.command);
    return res;
  }
  const doPlay = () => start(() => api.play(fields()));
  const doResume = (r, at) => start(() => api.resume(r.path, at, fields()));

  async function doTry() {
    const slug = $("demos").value;
    if (!slug) return;
    const res = await start(() => api.tryDemo(slug));
    if (res && res.ok) { $("root").value = res.root; rootChanged(); }   // the root field shows the example; the list shows its demo sessions
  }

  async function doReplay(r, markId) {
    setError(null);
    if (!markId) return;
    S.replaying = true; busy();
    $("replay-box").hidden = false; $("replay-open").hidden = true; $("copy-replay").hidden = true; $("copy-issue").hidden = true;
    $("status-select").hidden = true; $("status-of").hidden = true; $("status-apply").hidden = true; $("triage-line").hidden = true;
    $("replay-line").textContent = `Replaying mark ${markId}…`;
    const res = await api.replay(r.path, markId);
    if (res.error) { S.replaying = false; $("replay-box").hidden = true; setError(res.error); busy(); return; }
    setCmd(res.command);
  }

  // ---- Set up for Claude
  async function doSetup() {
    setError(null);
    const root = $("root").value.trim();
    if (!root) return;
    const res = await api.setupClaude(root);
    if (failed(res)) return;
    setCmd(res.command);
    const where = $("setup-where");
    where.replaceChildren(el("div", {}, `Installed the Snapper skill into ${res.dest}`));
    where.append(el("div", { class: "hint" }, res.installed.join("\n")));
    where.lastChild.style.whiteSpace = "pre-wrap";
    $("setup-recipe").textContent = res.recipe;
    const m = res.model || { integrated: false, headline: "Paste this into the file that starts your game loop", seen: "", candidatesLine: "" };
    $("setup-found").hidden = !m.integrated;
    $("setup-candidates").hidden = m.integrated;
    if (m.integrated) {
      richText($("setup-found-line"), m.headline);
      $("setup-seen").textContent = m.seen;
    } else {
      $("setup-paste-line").textContent = m.headline;
      $("setup-guess").textContent = m.candidatesLine;
    }
    $("setup-recipe-toggle").hidden = !m.integrated;
    showRecipe(!m.integrated);
    $("dialog").hidden = false;
    ($("setup-copy").hidden ? $("setup-close") : $("setup-copy")).focus();
  }
  function showRecipe(on) {
    S.setupRecipeShown = on;
    $("setup-recipe-box").hidden = !on;
    $("setup-copy").hidden = !on;
    $("setup-recipe-toggle").textContent = on ? "Hide the recipe" : "Show the recipe anyway";
  }
  const closeDialog = () => { $("dialog").hidden = true; $("setup").focus(); };

  // ---- Triage status of the replayed mark (select; "duplicate" asks for the mark it duplicates in a small inline field)
  async function showTriage(sessionDir, markId) {
    $("status-of").hidden = true; $("status-apply").hidden = true;
    const sel = $("status-select");
    sel.hidden = false; sel.value = "";
    const res = await api.marks(sessionDir);
    const m = res && res.marks ? res.marks.find(x => x.id === String(markId)) : null;
    if (m && m.status) sel.value = m.status;
  }
  async function applyTriage(status, of) {
    setError(null);
    if (!S.replaySession || !S.replayMark) return;
    const res = await api.setTriage(S.replaySession, S.replayMark, status, of || "");
    if (failed(res)) return;
    const t = res.triage || {};
    const line = $("triage-line");
    line.hidden = false;
    line.replaceChildren(el("span", { class: "triage-ok" }, `Mark ${S.replayMark}: ${t.status}${t.of ? ` of ${t.of}` : ""}`), ` · by ${t.by || "?"}`);
    $("status-of").hidden = true; $("status-apply").hidden = true;
    toast(`Marked ${t.status}`);
    refresh();
  }

  // ---- Attach
  /** Fill the page picker from the endpoint's pages; a picker only when several pages are listed. */
  async function loadTargets(quiet) {
    const ep = $("attach-endpoint").value.trim() || DEFAULT_ENDPOINT;
    const res = await api.attachTargets(ep);
    S.targets = res && res.targets ? res.targets : [];
    const sel = $("attach-target");
    sel.replaceChildren();
    for (const t of S.targets) sel.append(new Option(`${t.title || "(untitled)"} — ${t.url}`, t.url));
    if (S.rememberedTarget && S.targets.some(t => t.url === S.rememberedTarget)) sel.value = S.rememberedTarget;
    $("attach-target-field").hidden = S.targets.length < 2;
    if (res && res.error && !quiet) setError(res.error);
    return res;
  }
  async function doAttach() {
    setError(null);
    if (S.attached) { failed(await api.detach()); return; }
    if (!$("root").value.trim()) { setError("Pick a game folder first: Attach records into the game's own sessions folder."); return; }
    const lt = await loadTargets(false);
    if (lt && lt.error) return;
    if (!S.targets.length) { setError("No page is open at " + ($("attach-endpoint").value.trim() || DEFAULT_ENDPOINT) + ". Open your game in that browser first."); return; }
    S.attached = true; S.playing = "starting"; busy();
    const res = await api.attach(fields());
    if (res.error) {
      S.attached = false; S.playing = null; setError(res.error);
      if (res.targets && res.targets.length > 1) { S.targets = res.targets; await loadTargets(true); }
      busy(); return;
    }
    setCmd(res.command);
  }

  // ---- Check
  const resultText = r => {
    if (r.result === "match") return "match";
    if (r.result === "differs") return `differs ${diffsOf(r)}`.trim();
    if (r.result === "skipped") return `skipped (${r.reason || ""})`;
    return `error (${r.message || r.reason || ""})`;
  };

  function renderCheck() {
    const body = $("check-rows");
    body.replaceChildren();
    S.checkRows.forEach((r, n) => {
      const tr = el("tr");
      tr.append(el("td", {}, r.session || ""), el("td", {}, r.mark || ""), el("td", {}, r.note || ""));
      const res = el("td", { class: r.accepted ? "ok" : r.result === "match" ? "ok" : r.result === "differs" || r.result === "error" ? "bad" : "dim" },
        resultText(r) + (r.accepted ? " · accepted" : ""));
      const act = el("td");
      if (r.result === "differs" && !r.accepted) {
        const b = el("button", { id: `check-accept-${n}`, type: "button", "data-needs-checkidle": "" }, "Accept");
        b.addEventListener("click", () => {
          act.replaceChildren(
            el("div", { class: "confirm" }, `Accept records the replayed state of mark ${r.mark} as its new expectation (marks/${r.mark}/expected.json)`),
          );
          const yes = el("button", { id: `check-accept-${n}-yes`, type: "button" }, "Confirm");
          const no = el("button", { id: `check-accept-${n}-no`, type: "button" }, "Cancel");
          yes.addEventListener("click", () => doAccept(r));
          no.addEventListener("click", renderCheck);
          act.append(yes, " ", no);
        });
        act.append(b);
      }
      tr.append(res, act);
      body.append(tr);
    });
    busy();
  }

  async function doCheck() {
    setError(null);
    const root = $("root").value.trim();
    if (!root) return;
    S.checking = true; busy();
    S.checkRows = []; S.checkRoot = root;
    $("check-box").hidden = false;
    $("check-line").textContent = "Replaying marks on the current code…";
    $("check-summary").textContent = "";
    renderCheck();
    const res = await api.check(root);
    if (res.error) { S.checking = false; $("check-box").hidden = true; setError(res.error); busy(); return; }
    $("check-cmd").textContent = `$ ${res.command}`;
    setCmd(res.command);
  }

  async function doAccept(r) {
    setError(null);
    S.checking = true; busy();
    $("check-line").textContent = `Accepting mark ${r.mark}…`;
    const res = await api.accept(S.checkRoot, r.sessionDir, r.mark);
    if (res.error) { S.checking = false; $("check-line").textContent = ""; setError(res.error); renderCheck(); return; }
    $("check-cmd").textContent = `$ ${res.command}`;
    setCmd(res.command);
  }

  const summaryLine = s => (s ? `match ${s.match} · differs ${s.differs} · skipped ${s.skipped} · error ${s.error} · ${(s.ms / 1000).toFixed(1)} s` : "");

  api.onEvent(ev => {
    if (ev.type === "play-session") { S.playing = ev.id; if (ev.attach) S.attached = true; busy(); }
    else if (ev.type === "play-end") {
      S.playing = null;
      const was = S.attached || ev.attach;
      S.attached = false;
      $("status").dataset.last = was ? `Detached (exit ${ev.code})` : `Game closed (exit ${ev.code})`;
      if (ev.code) setError(`${was ? "The attach session" : "The game"} exited with code ${ev.code}.${ev.stderr ? "\n" + ev.stderr : ""}`);
      busy(); refresh();
    } else if (ev.type === "replay-log") {
      $("replay-line").textContent = ev.line;
    } else if (ev.type === "replay-done") {
      S.replaying = false;
      const line = $("replay-line");
      line.replaceChildren();
      line.append(`Replay of mark ${ev.markId}: `);
      line.append(el("span", { class: ev.stateMatches ? "ok" : "bad" }, ev.stateMatches ? "stateMatches true" : `stateMatches FALSE (differs ${diffsOf(ev) || "unknown"})`));
      S.replayDir = ev.outDir; S.replaySession = ev.sessionDir; S.replayMark = ev.markId;
      $("replay-open").hidden = false; $("copy-replay").hidden = false; $("copy-issue").hidden = false;
      showTriage(ev.sessionDir, ev.markId);
      busy(); refresh();
    } else if (ev.type === "replay-error") {
      S.replaying = false; $("replay-box").hidden = true; setError(ev.message); busy();
    } else if (ev.type === "check-log") {
      $("check-line").textContent = ev.line;
    } else if (ev.type === "check-row") {
      if (ev.row && !S.checkRows.some(r => r.sessionDir === ev.row.sessionDir && r.mark === ev.row.mark)) { S.checkRows.push(ev.row); renderCheck(); }
    } else if (ev.type === "check-done") {
      S.checking = false;
      if (ev.accepted) {
        for (const nr of ev.rows || []) {
          const i = S.checkRows.findIndex(r => r.sessionDir === nr.sessionDir && r.mark === nr.mark);
          if (i >= 0 && nr.accepted) S.checkRows[i] = { ...S.checkRows[i], accepted: true };
        }
        $("check-line").textContent = "Accepted";
      } else {
        S.checkRows = ev.rows || [];
        $("check-line").textContent = S.checkRows.length ? "Done" : "No replayable marks found";
        $("check-summary").textContent = `${summaryLine(ev.summary)}${ev.checkFile ? `\ncheck.json: ${ev.checkFile}` : ""}`;
        $("check-summary").style.whiteSpace = "pre-wrap";
      }
      renderCheck(); refresh();
    } else if (ev.type === "check-error") {
      S.checking = false; $("check-line").textContent = ""; setError(ev.message); if (!S.checkRows.length) $("check-box").hidden = true; renderCheck();
    } else if (ev.type === "error") setError(ev.message);
  });

  // Test hook: report control positions (CSS px, relative to the content area) when the main process asked for it.
  let layoutTimer = null;
  function layout() {
    if (!S.hook) return;
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      const out = {};
      document.querySelectorAll("button[id], input[id], select[id], [data-layout][id]").forEach(e => {
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out[e.id] = { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      api.reportLayout(out);
    }, 60);
  }

  async function saveFields() {
    const r = await api.saveFields(fields());
    if (r && r.warn) setError(r.warn); else if (!failed(r)) setError(null);
  }

  async function init() {
    $("browse").addEventListener("click", async () => { const p = await api.browse(); if (p && !failed({ error: p.error })) { $("root").value = p; rootChanged(); } });
    $("root").addEventListener("change", rootChanged);
    $("play").addEventListener("click", doPlay);
    $("try").addEventListener("click", doTry);
    $("setup").addEventListener("click", doSetup);
    $("check").addEventListener("click", doCheck);
    $("setup-close").addEventListener("click", closeDialog);
    $("setup-recipe-toggle").addEventListener("click", () => showRecipe(!S.setupRecipeShown));
    $("attach").addEventListener("click", doAttach);
    $("attach-endpoint").addEventListener("change", async () => { S.rememberedTarget = ""; await loadTargets(true); saveFields(); });
    $("attach-target").addEventListener("change", () => { S.rememberedTarget = $("attach-target").value; });
    $("copy-issue").addEventListener("click", async () => { if (S.replaySession && !failed(await api.copyIssue(S.replaySession, S.replayMark))) toast("Copied"); });
    $("status-select").addEventListener("change", () => {
      const v = $("status-select").value;
      const dup = v === "duplicate";
      $("status-of").hidden = !dup; $("status-apply").hidden = !dup;
      if (dup) $("status-of").focus(); else if (v) applyTriage(v, "");
    });
    $("status-apply").addEventListener("click", () => applyTriage("duplicate", $("status-of").value.trim()));
    $("setup-copy").addEventListener("click", async () => { if (!failed(await api.copyText("recipe"))) toast("Copied"); });
    $("copy-replay").addEventListener("click", async () => { if (S.replaySession && !failed(await api.copyForClaude(S.replaySession, S.replayMark))) toast("Copied"); });
    $("refresh").addEventListener("click", refresh);
    $("replay-open").addEventListener("click", async () => { if (S.replayDir) failed(await api.openPath(S.replayDir)); });
    $("capture-reset").addEventListener("click", async () => {
      const root = $("root").value.trim();
      if (!root) return;
      setError(null);
      const info = await api.resetCapture(root);
      if (failed(info)) return;
      const keep = fields();
      applyInfo({ ...info, fields: { ...info.fields, preset: keep.preset, fullscreen: keep.fullscreen, query: keep.query, url: keep.url } });
    });
    for (const id of ["preset", "fullscreen", "query", "url", "hotkey", "padHold", "ring", "bare", "attach-target"]) $(id).addEventListener("change", saveFields);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("dialog").hidden) closeDialog(); });
    $("root").addEventListener("input", busy);
    window.addEventListener("resize", layout);
    window.addEventListener("scroll", layout);
    new MutationObserver(layout).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "disabled"] });
    // Drag and drop: the preload turns the dropped File into a path (webUtils) and asks the main process to validate it.
    window.addEventListener("dragover", () => document.body.classList.add("dropping"));
    window.addEventListener("dragleave", e => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
    window.addEventListener("drop", () => document.body.classList.remove("dropping"));
    api.onDrop(info => {
      if (failed(info)) return;
      setError(null); applyInfo(info); refresh();
      if (info.imported) toast(info.imported.tester ? `Imported ${info.imported.id} from ${info.imported.tester}` : `Imported ${info.imported.id}`);
    }, () => $("root").value.trim());

    const st = await api.getState();
    S.hook = !!st.layoutHook;
    $("version").textContent = `v${st.version}`;
    const demos = await api.demos();
    for (const d of demos.list || []) $("demos").append(new Option(d.name, d.slug));
    applyInfo(st);
    S.playing = st.playing; S.attached = !!st.attached; S.replaying = st.replaying; S.checking = !!st.checking;
    busy();
    refresh();
    layout();
  }
  init();
})();
