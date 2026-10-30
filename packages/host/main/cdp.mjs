// One CDP interface, two backends (v1.4, D-028; BRIEF-v1.4 §2.2). The capture pipeline talks to this interface only.
//
//   cdp = {
//     kind:    "debugger" | "ws" | "fake",
//     send(method, params = {}) → Promise<result>   rejects with Error(message) on a CDP error, a timeout, or a closed connection
//     on(method, fn(params)) / off(method, fn)       one CDP event by name
//     onAny(fn(method, params)) → unsubscribe()      every event (the pipeline's single dispatcher)
//     onClose(fn(reason))                            once, when the connection ends (detach, socket closed, page gone)
//     detach() → Promise<void>                       ends it; idempotent; never throws
//     closed: boolean
//   }
//
// debuggerBackend(webContents)  Electron's wc.debugger (the play host and the replay driver): attaches protocol 1.3 if needed.
// wsBackend(wsUrl)               Node's global WebSocket (Node 22+, Electron 44 ships Node 24; no `ws` package): JSON-RPC ids,
//                                sessionId unused, a 30 s command timeout, no reconnect (a dropped socket ends the session).
// fakeBackend({ handlers })      for unit tests: handlers[method](params) → result (or throws); emit(method, params); close().
//
// HTTP endpoint helpers (attach mode): listTargets(http://host:port) → the page targets of /json/list,
// pickTarget(targets, match) → { target } | { error, list }, browserVersion(endpoint) → /json/version.
// CDP messages can be large (screencast frames are base64): nothing here logs a body.

const DEFAULT_TIMEOUT_MS = 30000;

function emitter() {
  const byMethod = new Map();
  const any = new Set();
  const closers = new Set();
  return {
    on(method, fn) { if (!byMethod.has(method)) byMethod.set(method, new Set()); byMethod.get(method).add(fn); },
    off(method, fn) { byMethod.get(method)?.delete(fn); },
    onAny(fn) { any.add(fn); return () => any.delete(fn); },
    onClose(fn) { closers.add(fn); },
    emit(method, params) {
      for (const fn of byMethod.get(method) || []) { try { fn(params); } catch {} }
      for (const fn of any) { try { fn(method, params); } catch {} }
    },
    close(reason) {
      const fns = [...closers];
      closers.clear();
      for (const fn of fns) { try { fn(reason); } catch {} }
    },
  };
}

/** Electron's webContents.debugger as a CDP interface. Attaches protocol 1.3 when it is not attached yet. */
export function debuggerBackend(wc, { timeoutMs = 0 } = {}) {
  const ev = emitter();
  const dbg = wc.debugger;
  if (!dbg.isAttached()) dbg.attach("1.3");
  let closed = false;
  const onMessage = (_e, method, params) => ev.emit(method, params);
  const onDetach = (_e, reason) => { if (closed) return; closed = true; api.closed = true; ev.close(String(reason || "detached")); };
  dbg.on("message", onMessage);
  dbg.on("detach", onDetach);
  const api = {
    kind: "debugger",
    closed: false,
    send(method, params = {}) {
      if (closed) return Promise.reject(new Error(`CDP ${method}: the debugger is detached`));
      const p = dbg.sendCommand(method, params);
      if (!timeoutMs) return p;
      let timer;
      return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`CDP ${method} timed out after ${timeoutMs} ms`)), timeoutMs); })])
        .finally(() => clearTimeout(timer));
    },
    on: ev.on, off: ev.off, onAny: ev.onAny, onClose: ev.onClose,
    async detach() {
      if (closed) return;
      closed = true; api.closed = true;
      try { dbg.removeListener("message", onMessage); } catch {}
      try { if (dbg.isAttached()) dbg.detach(); } catch {}
      try { dbg.removeListener("detach", onDetach); } catch {}
      ev.close("detached");
    },
  };
  return api;
}

/**
 * A CDP WebSocket (ws://host:port/devtools/page/<id>) as a CDP interface. Resolves once the socket is open.
 * opts: { timeoutMs (per command, default 30000), connectTimeoutMs (default 10000), WebSocketImpl (tests) }.
 */
export function wsBackend(url, { timeoutMs = DEFAULT_TIMEOUT_MS, connectTimeoutMs = 10000, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (typeof WebSocketImpl !== "function") return Promise.reject(new Error("no WebSocket in this runtime (Node 22+ or Electron 44 needed)"));
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocketImpl(String(url)); } catch (e) { reject(new Error(`cannot open ${url}: ${e.message}`)); return; }
    const ev = emitter();
    const pending = new Map();
    let nextId = 1, opened = false, closed = false;
    const connectTimer = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} reject(new Error(`no CDP connection to ${url} within ${connectTimeoutMs} ms`)); } }, connectTimeoutMs);

    const finish = reason => {
      if (closed) return;
      closed = true; api.closed = true;
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`CDP ${p.method}: connection closed (${reason})`)); }
      pending.clear();
      ev.close(reason);
    };
    const api = {
      kind: "ws",
      closed: false,
      url: String(url),
      send(method, params = {}) {
        if (closed) return Promise.reject(new Error(`CDP ${method}: connection closed`));
        const id = nextId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
          }, timeoutMs);
          pending.set(id, { resolve: res, reject: rej, timer, method });
          try { ws.send(JSON.stringify({ id, method, params })); }
          catch (e) { clearTimeout(timer); pending.delete(id); rej(new Error(`CDP ${method}: send failed (${e.message})`)); }
        });
      },
      on: ev.on, off: ev.off, onAny: ev.onAny, onClose: ev.onClose,
      async detach() {
        if (closed) return;
        try { ws.close(); } catch {}
        finish("detached");
      },
    };
    const onMessage = async data => {
      let text = data;
      if (typeof text !== "string") {
        try { text = typeof text?.text === "function" ? await text.text() : Buffer.from(text).toString("utf8"); } catch { return; }
      }
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`CDP ${p.method}: ${msg.error.message || JSON.stringify(msg.error)}${msg.error.data ? ` (${msg.error.data})` : ""}`));
        else p.resolve(msg.result ?? {});
      } else if (typeof msg.method === "string") {
        ev.emit(msg.method, msg.params || {});
      }
    };
    const on = (name, fn) => (typeof ws.addEventListener === "function" ? ws.addEventListener(name, fn) : ws.on(name, fn));
    on("open", () => { opened = true; clearTimeout(connectTimer); resolve(api); });
    on("message", e => { onMessage(e && e.data !== undefined ? e.data : e); });
    on("error", e => { if (!opened) { clearTimeout(connectTimer); reject(new Error(`cannot connect to ${url}: ${e?.message || "WebSocket error"}`)); } });
    on("close", e => { clearTimeout(connectTimer); if (!opened) reject(new Error(`cannot connect to ${url} (closed${e?.code ? ` ${e.code}` : ""})`)); finish(`socket closed${e?.code ? ` (${e.code})` : ""}`); });
  });
}

/** A scripted CDP for unit tests. handlers: { [method]: params → result | Promise<result> } (throw = CDP error). */
export function fakeBackend({ handlers = {} } = {}) {
  const ev = emitter();
  const sent = [];
  let closed = false;
  const api = {
    kind: "fake",
    closed: false,
    sent,
    async send(method, params = {}) {
      if (closed) throw new Error(`CDP ${method}: connection closed`);
      sent.push({ method, params });
      const h = handlers[method];
      return h ? await h(params) : {};
    },
    on: ev.on, off: ev.off, onAny: ev.onAny, onClose: ev.onClose,
    emit: (method, params = {}) => ev.emit(method, params),
    async detach() { if (!closed) { closed = true; api.closed = true; ev.close("detached"); } },
    close(reason = "socket closed") { if (!closed) { closed = true; api.closed = true; ev.close(reason); } },
  };
  return api;
}

const httpBase = endpoint => String(endpoint).replace(/\/+$/, "").replace(/\/json(\/list|\/version)?$/, "");

/** GET <endpoint>/json/list → the page targets [{ id, type, title, url, webSocketDebuggerUrl }] (pages only). */
export async function listTargets(endpoint, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const base = httpBase(endpoint);
  let res;
  try { res = await fetchImpl(`${base}/json/list`, { signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new Error(`cannot reach ${base}/json/list (${e?.cause?.code || e.message}); start the browser with --remote-debugging-port and --user-data-dir`); }
  if (!res.ok) throw new Error(`${base}/json/list answered HTTP ${res.status}`);
  const list = await res.json();
  return (Array.isArray(list) ? list : []).filter(t => t && t.type === "page" && t.webSocketDebuggerUrl)
    .map(t => ({ id: t.id, type: t.type, title: t.title || "", url: t.url || "", webSocketDebuggerUrl: t.webSocketDebuggerUrl }));
}

/** GET <endpoint>/json/version → { Browser, "Protocol-Version", "User-Agent", ... } or null. */
export async function browserVersion(endpoint, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetchImpl(`${httpBase(endpoint)}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/**
 * Pure: choose the page to attach to. `match` (optional) is a URL or a title substring (case-insensitive) or a target id.
 * Returns { target } for exactly one candidate, else { error, list } (the CLI prints the list and exits 2).
 */
export function pickTarget(targets, match) {
  const list = (targets || []).map(t => ({ id: t.id, title: t.title, url: t.url }));
  if (!targets?.length) return { error: "no page targets at that endpoint (open the game in a tab first)", list };
  if (!match) return targets.length === 1 ? { target: targets[0] } : { error: `${targets.length} pages are open; pick one with --target <url or title substring>`, list };
  const m = String(match).toLowerCase();
  const exact = targets.filter(t => t.id === match || t.url === match);
  const hits = exact.length ? exact : targets.filter(t => t.url.toLowerCase().includes(m) || t.title.toLowerCase().includes(m));
  if (hits.length === 1) return { target: hits[0] };
  return { error: hits.length ? `--target "${match}" matches ${hits.length} pages; be more specific` : `--target "${match}" matches no page`, list };
}
