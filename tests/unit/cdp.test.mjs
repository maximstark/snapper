// The CDP interface (packages/host/main/cdp.mjs): wsBackend against a hand-rolled RFC 6455 server (no dependency),
// debuggerBackend over a fake webContents.debugger, listTargets / browserVersion over a local http server, pickTarget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { wsBackend, debuggerBackend, fakeBackend, listTargets, browserVersion, pickTarget } from "../../packages/host/main/cdp.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A tiny WebSocket server: onText(conn, text) per client text frame. conn = { send(text), close(), socket }. */
function wsServer(onText) {
  const conns = [];
  const http = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  http.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = {
      socket,
      send(text) {
        const p = Buffer.from(text);
        const head = p.length < 126 ? Buffer.from([0x81, p.length]) : p.length < 65536
          ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255])
          : Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(8)]);
        if (p.length >= 65536) head.writeBigUInt64BE(BigInt(p.length), 2);
        socket.write(Buffer.concat([head, p]));
      },
      close() { try { socket.write(Buffer.from([0x88, 0])); socket.end(); } catch {} },
    };
    conns.push(conn);
    let buf = Buffer.alloc(0);
    socket.on("data", d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = (buf[1] & 128) !== 0;
        if (buf.length < off + (masked ? 4 : 0) + len) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(off + (masked ? 4 : 0) + len);
        if (op === 1) onText(conn, payload.toString("utf8"));
        else if (op === 8) { conn.close(); return; }
      }
    });
    socket.on("error", () => {});
  });
  return new Promise(res => http.listen(0, "127.0.0.1", () => res({
    url: `ws://127.0.0.1:${http.address().port}/devtools/page/x`, conns,
    close: () => new Promise(r => { for (const c of conns) c.socket.destroy(); http.close(() => r()); }),
  })));
}

test("wsBackend: request/response ids, events, onAny, CDP error replies", async () => {
  const srv = await wsServer((c, text) => {
    const m = JSON.parse(text);
    if (m.method === "Boom") c.send(JSON.stringify({ id: m.id, error: { code: -32000, message: "no such thing", data: "extra" } }));
    else if (m.method === "Page.enable") { c.send(JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 } })); c.send(JSON.stringify({ id: m.id, result: {} })); }
    else c.send(JSON.stringify({ id: m.id, result: { echo: m.method, params: m.params } }));
  });
  try {
    const cdp = await wsBackend(srv.url);
    assert.equal(cdp.kind, "ws");
    assert.equal(cdp.closed, false);
    const [a, b] = await Promise.all([cdp.send("A.one", { x: 1 }), cdp.send("B.two")]);
    assert.deepEqual(a, { echo: "A.one", params: { x: 1 } });
    assert.equal(b.echo, "B.two");
    const seen = [], any = [];
    cdp.on("Page.loadEventFired", p => seen.push(p));
    const unsub = cdp.onAny((m, p) => any.push(m));
    await cdp.send("Page.enable");
    assert.deepEqual(seen, [{ timestamp: 1 }]);
    assert.deepEqual(any, ["Page.loadEventFired"]);
    unsub();
    await assert.rejects(cdp.send("Boom"), /Boom: no such thing \(extra\)/);
    const fn = () => seen.push("again");
    cdp.on("Page.loadEventFired", fn); cdp.off("Page.loadEventFired", fn);
    // a large frame (screencast-sized) comes through whole
    const big = "x".repeat(200000);
    srv.conns[0].send(JSON.stringify({ method: "Page.screencastFrame", params: { data: big } }));
    await new Promise(r => cdp.on("Page.screencastFrame", p => { assert.equal(p.data.length, 200000); r(); }));
    await cdp.detach();
  } finally { await srv.close(); }
});

test("wsBackend: a command that gets no answer times out (timeoutMs)", async () => {
  const srv = await wsServer((c, text) => { const m = JSON.parse(text); if (m.method !== "Hang") c.send(JSON.stringify({ id: m.id, result: {} })); });
  try {
    const cdp = await wsBackend(srv.url, { timeoutMs: 80 });
    const t0 = Date.now();
    await assert.rejects(cdp.send("Hang"), /Hang timed out after 80 ms/);
    assert.ok(Date.now() - t0 < 2000);
    await cdp.send("Fine");                              // the connection still works
    await cdp.detach();
  } finally { await srv.close(); }
});

test("wsBackend: the socket closing rejects pending commands, fires onClose once, and later sends reject", async () => {
  const srv = await wsServer((c, text) => { const m = JSON.parse(text); if (m.method === "Die") c.close(); });
  try {
    const cdp = await wsBackend(srv.url);
    const reasons = [];
    cdp.onClose(r => reasons.push(r));
    await assert.rejects(cdp.send("Die"), /connection closed/);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /socket closed/);
    assert.equal(cdp.closed, true);
    await assert.rejects(cdp.send("After"), /connection closed/);
    await cdp.detach();                                   // idempotent, never throws
    assert.equal(reasons.length, 1);
  } finally { await srv.close(); }
});

test("wsBackend: detach() closes the socket, fires onClose('detached'), and is idempotent", async () => {
  const srv = await wsServer(() => {});
  try {
    const cdp = await wsBackend(srv.url);
    const reasons = [];
    cdp.onClose(r => reasons.push(r));
    const pending = cdp.send("Never");
    pending.catch(() => {});
    await cdp.detach();
    await cdp.detach();
    assert.deepEqual(reasons, ["detached"]);
    await assert.rejects(pending, /connection closed/);
  } finally { await srv.close(); }
});

test("wsBackend: refuses cleanly when nothing listens, and without a WebSocket", async () => {
  await assert.rejects(wsBackend("ws://127.0.0.1:1/devtools/page/x", { connectTimeoutMs: 2000 }), /cannot connect|closed/);
  await assert.rejects(wsBackend("ws://127.0.0.1:1/x", { WebSocketImpl: null }), /no WebSocket/);
});

test("debuggerBackend: wc.debugger as the interface (attach, send, events, detach)", async () => {
  const dbg = new EventEmitter();
  const sent = [];
  let attached = false;
  dbg.isAttached = () => attached;
  dbg.attach = v => { attached = true; sent.push(["attach", v]); };
  dbg.detach = () => { attached = false; dbg.emit("detach", {}, "target closed"); };
  dbg.sendCommand = async (m, p) => { sent.push([m, p]); return { ok: m }; };
  const cdp = debuggerBackend({ debugger: dbg });
  assert.equal(cdp.kind, "debugger");
  assert.deepEqual(sent[0], ["attach", "1.3"]);
  assert.deepEqual(await cdp.send("Page.enable"), { ok: "Page.enable" });
  const got = [];
  cdp.on("Runtime.consoleAPICalled", p => got.push(p.type));
  dbg.emit("message", {}, "Runtime.consoleAPICalled", { type: "log" });
  assert.deepEqual(got, ["log"]);
  const reasons = [];
  cdp.onClose(r => reasons.push(r));
  await cdp.detach();
  assert.deepEqual(reasons, ["detached"]);
  assert.equal(cdp.closed, true);
  await assert.rejects(cdp.send("Page.enable"), /detached/);
});

test("fakeBackend: scripted handlers, emit, close", async () => {
  const f = fakeBackend({ handlers: { "A.b": p => ({ got: p.x }), "A.err": () => { throw new Error("bad"); } } });
  assert.deepEqual(await f.send("A.b", { x: 2 }), { got: 2 });
  await assert.rejects(f.send("A.err"), /bad/);
  assert.deepEqual(await f.send("Unknown"), {});
  const ev = [];
  f.onAny((m, p) => ev.push(m));
  f.emit("X.y", {});
  let closed = 0;
  f.onClose(() => closed++);
  f.close();
  assert.deepEqual(ev, ["X.y"]);
  assert.equal(closed, 1);
  await assert.rejects(f.send("A.b"), /closed/);
  assert.equal(f.sent.length, 3);
});

function httpJson(routes) {
  const http = createServer((req, res) => {
    const r = routes[req.url];
    if (!r) { res.statusCode = 404; res.end("no"); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(r));
  });
  return new Promise(res => http.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${http.address().port}`, close: () => new Promise(r => http.close(() => r())) })));
}

test("listTargets / browserVersion over a local http server (pages only; tolerant endpoint spellings)", async () => {
  const srv = await httpJson({
    "/json/list": [
      { id: "1", type: "page", title: "Game", url: "http://localhost:5173/", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/1" },
      { id: "2", type: "service_worker", title: "sw", url: "http://localhost:5173/sw.js", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/2" },
      { id: "3", type: "page", title: "no socket", url: "about:blank" },
    ],
    "/json/version": { Browser: "Chrome/141.0.7390.55", "User-Agent": "UA" },
  });
  try {
    const t = await listTargets(srv.url);
    assert.deepEqual(t.map(x => x.id), ["1"]);
    assert.equal(t[0].webSocketDebuggerUrl, "ws://127.0.0.1:1/devtools/page/1");
    assert.equal((await listTargets(srv.url + "/json/list")).length, 1);
    assert.equal((await listTargets(srv.url + "/")).length, 1);
    assert.equal((await browserVersion(srv.url)).Browser, "Chrome/141.0.7390.55");
  } finally { await srv.close(); }
  await assert.rejects(listTargets("http://127.0.0.1:1", { timeoutMs: 1500 }), /cannot reach .*--remote-debugging-port/);
  assert.equal(await browserVersion("http://127.0.0.1:1", { timeoutMs: 800 }), null);
  const bad = await httpJson({});
  try { await assert.rejects(listTargets(bad.url), /HTTP 404/); } finally { await bad.close(); }
});

test("pickTarget: one page, a unique match, an ambiguous or missing one", () => {
  const T = [
    { id: "A", title: "Moon Game", url: "http://localhost:5173/" },
    { id: "B", title: "Docs", url: "http://localhost:3000/docs" },
    { id: "C", title: "Moon Docs", url: "http://localhost:3000/moon" },
  ];
  assert.equal(pickTarget([T[0]]).target.id, "A");
  const many = pickTarget(T);
  assert.match(many.error, /3 pages are open/);
  assert.deepEqual(many.list.map(x => x.id), ["A", "B", "C"]);
  assert.equal(pickTarget(T, "5173").target.id, "A");
  assert.equal(pickTarget(T, "docs/docs").error ? 1 : 0, 1);
  assert.equal(pickTarget(T, "http://localhost:3000/docs").target.id, "B");   // exact url wins over substring hits
  assert.equal(pickTarget(T, "C").target.id, "C");                             // target id
  assert.equal(pickTarget(T, "game").target.id, "A");                          // title substring, case-insensitive
  assert.match(pickTarget(T, "moon").error, /matches 2 pages/);
  assert.match(pickTarget(T, "nothing").error, /matches no page/);
  assert.match(pickTarget([], undefined).error, /no page targets/);
});
