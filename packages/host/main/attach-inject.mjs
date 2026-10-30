// The attach-mode page script (v1.4, CONTRACTS.md "W1"; BRIEF-v1.4 §2.3). There is no preload in a browser the user started,
// so everything the preload does is injected as ONE string: page.js (the shared page-side code) plus a CDP transport.
//
//   page -> host   window.__snapperHostBinding(JSON.stringify(["p", kind, data]))          (Runtime.addBinding + Runtime.bindingCalled)
//                  window.__snapperHostBinding(JSON.stringify(["tape", frames[], masks[], count]))
//   host -> page   Runtime.evaluate("globalThis.__snapperPage && globalThis.__snapperPage.msg(kind, data)")
//   the SDK        window.__snapperBridge  (non-enumerable; the same object the Electron preload exposes)
//
// Globals the page can see in attach mode: `snapper` (the SDK), `__snapperBridge`, `__snapperHostBinding`, `__snapperPage`.
// `__snapperPage` and `__snapperBridge` are non-enumerable. The script runs once per document (the guard), only in the top
// frame, and a `dispose` message removes the overlay, the listeners, the timers and the rAF loop (page.js) and makes the
// bridge and the binding inert. Nothing here has Node: the string is plain browser JavaScript.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ATTACH_BINDING = "__snapperHostBinding";
export const PAGE_JS = fileURLToPath(new URL("../preload/page.js", import.meta.url));

let cached = null;
export function readPageSource() {
  if (cached === null) cached = readFileSync(PAGE_JS, "utf8");
  return cached;
}

/**
 * The injected script. opts = page.js OPTS (the preload options + { attach: true, inPageHotkeys: true }); pageSource
 * defaults to packages/host/preload/page.js.
 */
export function buildAttachScript(opts, pageSource = readPageSource()) {
  return `(function () {
"use strict";
var G = globalThis;
try { if (G.window !== G.window.top) return; } catch (e) { return; }          // the top frame only (the preload does not run in subframes either)
if (G.__snapperPage) return;                                                  // once per document
var OPTS = ${JSON.stringify(opts)};
var stringify = JSON.stringify, toArray = Array.from;
var disposed = false, listener = null;
${pageSource}
var T = {
  send: function (kind, data) {
    if (disposed) return;
    var b = G.${ATTACH_BINDING};
    if (typeof b !== "function") return;
    b(stringify(["p", kind, data === undefined ? null : data]));
  },
  sendTape: function (frames, masks, count) {
    if (disposed) return;
    var b = G.${ATTACH_BINDING};
    if (typeof b !== "function") return;
    b(stringify(["tape", toArray(frames), toArray(masks), count]));
  },
  listen: function (fn) { listener = fn; },
  exposeBridge: function (api) {
    Object.defineProperty(G, "__snapperBridge", { value: api, enumerable: false, configurable: true, writable: false });
  }
};
Object.defineProperty(G, "__snapperPage", {
  value: {
    v: 1,
    msg: function (kind, data) {
      if (!listener) return;
      try { listener(kind, data); } catch (e) {}
      if (kind === "dispose") { disposed = true; try { delete G.__snapperPage; } catch (e) {} }
    }
  },
  enumerable: false, configurable: true, writable: false
});
snapperPage(OPTS, T);
})();`;
}

/** The Runtime.evaluate expression that delivers one host -> page message. */
export function pageMessageExpression(kind, data) {
  return `globalThis.__snapperPage&&globalThis.__snapperPage.msg(${JSON.stringify(String(kind))},${JSON.stringify(data === undefined ? null : data)})`;
}

/** Parse a Runtime.bindingCalled payload: { type: "p", kind, data } | { type: "tape", frames, masks, count } | null. */
export function parseBindingPayload(payload) {
  let m;
  try { m = JSON.parse(String(payload)); } catch { return null; }
  if (!Array.isArray(m)) return null;
  if (m[0] === "p" && typeof m[1] === "string") return { type: "p", kind: m[1], data: m[2] ?? {} };
  if (m[0] === "tape" && Array.isArray(m[1]) && Array.isArray(m[2])) {
    const n = Math.max(0, Math.min(m[3] | 0, m[1].length, m[2].length));
    return { type: "tape", frames: Int32Array.from(m[1].slice(0, n)), masks: Int32Array.from(m[2].slice(0, n)), count: n };
  }
  return null;
}
