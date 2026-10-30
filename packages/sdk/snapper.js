/* Snapper SDK v1.0.0 (MIT). One classic script, no dependencies, no exports.
 * Contract: docs/SDK.md (the bridge protocol is decision D-013 in the maintainer's notes).
 * Invariants: never throws into the game; tick() allocates nothing at steady state;
 * with no host bridge every call is a cheap no-op that only fills small in-memory rings. */
(function () {
  "use strict";
  var G = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this);
  if (G.snapper && G.snapper.version) return; // injected AND imported: keep the first one

  var VERSION = "1.0.0";
  var RING = 4096, RING_MASK = RING - 1;     // tape rings (power of two)
  var FLUSH_MS = 250;
  var CAP_BYTES = 256 * 1024, CAP_ARRAY = 1000, MAX_KEYMAP = 31;
  var LOCAL_MAX = 500;                        // standalone logs/events/marks kept
  var ASSERT_COOLDOWN_MS = 2000;
  var LEVELS = { debug: 1, info: 1, warn: 1, error: 1 };

  // ---- state ----
  var stateFn = null, frameFn = null, stepper = null;
  var commands = {};                          // id -> {label, run, arg}
  var commandIds = [];
  var keymap = [];

  var tapeFrames = new Int32Array(RING), tapeMasks = new Int32Array(RING);
  var tapeTotal = 0, tapeFlushed = 0, tapeDropped = 0;
  var lastFrame = -1, lastMask = 0, started = false, timer = 0;

  var logs = [], events = [], marks = [];     // standalone rings only (not filled when attached)
  var assertTimes = {}, assertKeys = 0;

  // ---- helpers ----
  function bridge() {
    var b = G.__snapperBridge;
    return b && typeof b === "object" ? b : null;
  }
  function now() {
    try { var p = G.performance; if (p && typeof p.now === "function") return p.now(); } catch (e) { /* fall through */ }
    return Date.now();
  }
  function msgOf(e) {
    try { return String(e && e.message !== undefined ? e.message : e); } catch (x) { return "unknown error"; }
  }
  function errJson(text) { return '{"error":' + JSON.stringify(text) + "}"; }
  function utf8Len(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; } else n += 3;
    }
    return n;
  }
  function replacer(k, v) {
    if (Array.isArray(v) && v.length > CAP_ARRAY) {
      var a = v.slice(0, CAP_ARRAY);
      a.push({ _truncated: v.length - CAP_ARRAY });
      return a;
    }
    return v;
  }
  // value -> JSON string with the size caps applied; never throws.
  function serialize(v, what) {
    var s;
    try { s = JSON.stringify(v, replacer); } catch (e) { return errJson("not serialisable: " + msgOf(e)); }
    if (s === undefined) return "null";
    var bytes = utf8Len(s);
    if (bytes <= CAP_BYTES) return s;
    var out = { error: what + " exceeds 256 KB", _truncated: bytes };
    try {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        var ks = Object.keys(v);
        for (var i = 0; i < ks.length && i < 200; i++) {
          var x = v[ks[i]], t = typeof x;
          if (x === null || t === "number" || t === "boolean") out[ks[i]] = x;
          else if (t === "string") out[ks[i]] = x.length > 200 ? x.slice(0, 200) : x;
        }
      }
    } catch (e) { /* scalars are best effort */ }
    try { return JSON.stringify(out); } catch (e) { return errJson(what + " exceeds 256 KB"); }
  }
  function clone(data) {                      // capped plain copy of a `data` argument, or undefined
    if (data === undefined) return undefined;
    try { return JSON.parse(serialize(data, "data")); } catch (e) { return { error: "unserialisable data" }; }
  }
  function send(type, payload) {
    var b = bridge();
    if (!b || typeof b.send !== "function") return false;
    try { b.send(type, payload); return true; } catch (e) { return false; }
  }
  function keep(arr, item) { arr.push(item); if (arr.length > LOCAL_MAX) arr.shift(); }
  function str(v, max) { var s; try { s = String(v); } catch (e) { s = "?"; } return s.length > max ? s.slice(0, max) : s; }

  // ---- tape ----
  function push(f, m) {
    if (tapeTotal - tapeFlushed >= RING) { tapeDropped++; tapeFlushed++; } // overwrite oldest unflushed
    var i = tapeTotal & RING_MASK;
    tapeFrames[i] = f; tapeMasks[i] = m; tapeTotal++;
  }
  function flush() {
    try {
      var b = bridge();
      if (!b || typeof b.sendTape !== "function") return false;
      var n = tapeTotal - tapeFlushed;
      if (n <= 0) return false;
      var f = new Int32Array(n), m = new Int32Array(n);
      for (var k = 0; k < n; k++) { var i = (tapeFlushed + k) & RING_MASK; f[k] = tapeFrames[i]; m[k] = tapeMasks[i]; }
      tapeFlushed = tapeTotal;
      b.sendTape(f, m, n);
      return true;
    } catch (e) { return false; }
  }
  function ensureTimer() {
    if (timer !== 0 || !bridge()) return;
    try {
      var si = G.setInterval;
      if (typeof si === "function") timer = si(flush, FLUSH_MS) || -1;
    } catch (e) { /* retry on a later tick */ }
  }
  function tick(frame, mask) {
    try {
      frame = frame | 0; mask = mask | 0;
      if (mask < 0) mask = 0;
      if (timer === 0) ensureTimer();
      if (started && mask === lastMask && frame >= lastFrame) { lastFrame = frame; return; }
      if (started && frame < lastFrame) push(frame, -1);   // reset marker (D-012)
      push(frame, mask);
      started = true; lastFrame = frame; lastMask = mask;
    } catch (e) { /* never hurt the game */ }
  }
  function tickKeys(frame, codes) {
    try {
      var m = 0;
      if (codes) {
        for (var i = 0; i < keymap.length; i++) {
          for (var j = 0; j < codes.length; j++) if (codes[j] === keymap[i]) { m |= 1 << i; break; }
        }
      }
      tick(frame, m);
    } catch (e) { /* ignore */ }
  }
  function frameNow() { return lastFrame; }

  // ---- registrations ----
  function registerState(fn) { try { if (typeof fn === "function") { stateFn = fn; send("register", {}); } } catch (e) { /* ignore */ } }
  function registerFrame(fn) { try { if (typeof fn === "function") { frameFn = fn; send("register", {}); } } catch (e) { /* ignore */ } }
  function registerStepper(s) {
    try {
      if (!s || typeof s !== "object") return;
      stepper = s;
      var km = [];
      if (s.keymap && typeof s.keymap.length === "number") {
        for (var i = 0; i < s.keymap.length && km.length < MAX_KEYMAP; i++) km.push(String(s.keymap[i]));
      }
      keymap = km;
      send("register", {});
      if (typeof s.seed === "function") {
        var seed; try { seed = s.seed(); } catch (e) { seed = undefined; }
        if (seed !== undefined) send("seed", { frame: lastFrame, seed: seed });
      }
    } catch (e) { /* ignore */ }
  }
  function registerCommands(map) {
    try {
      if (!map || typeof map !== "object") return;
      var ks = Object.keys(map);
      for (var i = 0; i < ks.length; i++) {
        var c = map[ks[i]];
        if (!c || typeof c.run !== "function") continue;
        if (!commands[ks[i]]) commandIds.push(ks[i]);
        commands[ks[i]] = { label: c.label !== undefined ? String(c.label) : ks[i], run: c.run, arg: c.arg === undefined ? null : c.arg };
      }
      send("register", {});
    } catch (e) { /* ignore */ }
  }

  // ---- logging ----
  function log(level, msg, data) {
    try {
      if (!LEVELS[level]) level = "info";
      var p = { frame: lastFrame, level: level, msg: str(msg, 4000) };
      var d = clone(data); if (d !== undefined) p.data = d;
      if (!send("log", p)) keep(logs, { t: now(), frame: p.frame, level: level, msg: p.msg, data: d });
    } catch (e) { /* ignore */ }
  }
  function event(name, data) {
    try {
      var p = { frame: lastFrame, name: str(name, 200) };
      var d = clone(data); if (d !== undefined) p.data = d;
      if (!send("event", p)) keep(events, { t: now(), frame: p.frame, name: p.name, data: d });
    } catch (e) { /* ignore */ }
  }
  function mark(note, data) {
    try {
      var p = { frame: lastFrame, note: note === undefined ? undefined : str(note, 1000) };
      var d = clone(data); if (d !== undefined) p.data = d;
      if (!send("mark", p)) keep(marks, { t: now(), frame: p.frame, note: p.note, data: d, trigger: "api" });
    } catch (e) { /* ignore */ }
  }
  function assertFn(cond, msg, data) {
    try {
      if (cond) return cond;
      var key = str(msg, 200), t = now(), last = assertTimes[key];
      if (last !== undefined && t - last < ASSERT_COOLDOWN_MS) return cond;
      if (assertKeys > 100) { assertTimes = {}; assertKeys = 0; }
      if (last === undefined) assertKeys++;
      assertTimes[key] = t;
      var p = { frame: lastFrame, msg: key };
      var d = clone(data); if (d !== undefined) p.data = d;
      if (!send("assert", p)) keep(marks, { t: t, frame: p.frame, note: key, data: d, trigger: "assert" });
    } catch (e) { /* ignore */ }
    return cond;
  }

  function exportFn() {
    try {
      var tape = [], n = Math.min(tapeTotal, RING);
      for (var k = tapeTotal - n; k < tapeTotal; k++) {
        var i = k & RING_MASK;
        if (tapeMasks[i] === -1) tape.push({ f: tapeFrames[i], ev: "reload" });
        else tape.push({ f: tapeFrames[i], m: tapeMasks[i] });
      }
      return { logs: logs.slice(), events: events.slice(), marks: marks.slice(), tape: tape, tapeDropped: tapeDropped };
    } catch (e) { return { logs: [], events: [], marks: [], tape: [] }; }
  }

  // ---- host surface (private) ----
  function callStepper(name, a, b) {
    try { if (stepper && typeof stepper[name] === "function") stepper[name](a, b); } catch (e) { /* ignore */ }
  }
  var host = {
    ready: function () {
      try {
        var r = {
          sdk: true, state: !!stateFn, frame: !!frameFn, stepper: !!stepper,
          commands: commandIds.slice(), keymap: keymap.slice(),
          pauseParam: stepper ? (stepper.pauseParam ? String(stepper.pauseParam) : "paused") : "",
          version: VERSION,
        };
        if (stepper && typeof stepper.seed === "function") {
          try { var s = stepper.seed(); if (s !== undefined) r.seed = s; } catch (e) { /* no seed */ }
        }
        return r;
      } catch (e) { return { sdk: true, state: false, frame: false, stepper: false, commands: [], keymap: [], pauseParam: "", version: VERSION }; }
    },
    state: function () {
      try {
        if (!stateFn) return '{"unavailable":true}';
        var v;
        try { v = stateFn(); } catch (e) { return errJson(msgOf(e)); }
        return serialize(v, "state");
      } catch (e) { return errJson(msgOf(e)); }
    },
    frame: function () {
      try {
        if (!frameFn) return null;
        var v = frameFn();
        if (typeof v === "string") return v;
        if (v && typeof v.toDataURL === "function") { var u = v.toDataURL("image/png"); return typeof u === "string" ? u : null; }
        return null;
      } catch (e) { return null; }
    },
    pause: function () { callStepper("pause"); },
    resume: function () { callStepper("resume"); },
    step: function (n, codes) { callStepper("step", n, codes); return lastFrame; },
    command: function (id, arg) {
      try {
        var c = commands[id];
        if (!c) return errJson("unknown command: " + str(id, 100));
        var v;
        try { v = c.run(arg); } catch (e) { return errJson(msgOf(e)); }
        return serialize(v === undefined ? null : v, "result");
      } catch (e) { return errJson(msgOf(e)); }
    },
    commandList: function () {
      try {
        return commandIds.map(function (id) { return { id: id, label: commands[id].label, arg: commands[id].arg }; });
      } catch (e) { return []; }
    },
    flush: function () { return flush(); },
  };

  var snapper = {
    version: VERSION,
    frame: frameNow,
    registerState: registerState, registerFrame: registerFrame, registerStepper: registerStepper, registerCommands: registerCommands,
    tick: tick, tickKeys: tickKeys,
    log: log, event: event, mark: mark, assert: assertFn,
    export: exportFn,
  };
  Object.defineProperty(snapper, "attached", { get: function () { return !!bridge(); }, enumerable: true });
  Object.defineProperty(snapper, "__host", { value: host, enumerable: false });
  G.snapper = snapper;
})();
