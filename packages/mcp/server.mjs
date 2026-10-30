#!/usr/bin/env node
// Snapper MCP server (MIT, zero dependencies): JSON-RPC 2.0 over stdio, one message per line (BRIEF-v1.3 §5, D-027).
//
// Dual-era (modelcontextprotocol.io, revision 2026-07-28 "Versioning and Compatibility"):
//   modern  2026-07-28   every request carries `_meta["io.modelcontextprotocol/protocolVersion"]`; `server/discover`;
//                        results carry `resultType: "complete"`; an unknown version → error -32022 with the supported list.
//   legacy  2025-11-25 … 2024-11-05   the `initialize` handshake: the client's protocolVersion is echoed when known,
//                        else the latest legacy one is answered; `notifications/initialized`; capabilities `tools`.
// Methods: initialize, notifications/initialized, ping, server/discover, tools/list, tools/call (+ notifications/cancelled,
// ignored). stdout carries ONLY protocol messages; every log goes to stderr.
//
// No host imports: the package reads sessions through packages/core and runs replays and checks by spawning the Snapper
// CLI given to it (`cli`: [cmd, ...args]), so it knows nothing about Electron.
//   node packages/mcp/server.mjs --cli "node <snapper-repo>/bin/snapper.mjs"
//   snapper mcp                       (the host passes the right CLI spec, dev or packaged)
import { createInterface } from "node:readline";
import { TOOLS, callTool } from "./tools.mjs";

export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const SERVER_INFO = { name: "snapper", title: "Snapper", version: "1.4.0" };
export const INSTRUCTIONS = "Snapper playtest sessions: list_sessions for a game root, read_session (SESSION.md) first, then read_mark and "
  + "mark_image (shot/frame/sheet at full resolution) per mark, replay to reproduce a mark deterministically, check to replay every "
  + "replayable mark of past sessions on the current code; set_triage after a fix (status fixed + commit), issue_markdown to file a "
  + "mark elsewhere, import_session for a playtester's zip, export_repro to answer \"was it Snapper?\" with a repro that runs in a "
  + "stock browser. The session files on disk are the truth; this server reads them and writes only marks/NNNN/replay/ (replay), "
  + "marks/NNNN/expected.json (check with accept), marks/NNNN/triage.json (set_triage), marks/NNNN/repro/ (export_repro) and the "
  + "imported session folder (import_session).";

export const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, UNSUPPORTED_VERSION: -32022 };

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

/**
 * The protocol core, transport-free (unit-tested directly). handle(message) → Promise<response object | null>.
 * ctx: { cli: [cmd, ...args], env, log(msg) }.
 */
export function createHandler(ctx = {}) {
  const log = ctx.log || (() => {});
  let legacyVersion = null;          // set by `initialize` (legacy era for this process)

  const modernVersionOf = params => {
    const v = params && typeof params === "object" ? params._meta?.[META_VERSION] : undefined;
    return typeof v === "string" ? v : null;
  };
  const complete = (modern, result) => (modern ? { resultType: "complete", ...result } : result);

  async function dispatch(method, params, isNotification) {
    const requested = modernVersionOf(params);
    if (requested !== null && !MODERN_VERSIONS.includes(requested) && method !== "initialize") {
      // A modern request naming a version this server does not speak in the modern era.
      throw new RpcError(ERR.UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested });
    }
    const modern = requested !== null;
    switch (method) {
      case "initialize": {
        const want = params?.protocolVersion;
        legacyVersion = LEGACY_VERSIONS.includes(want) ? want : LEGACY_VERSIONS[0];
        log(`initialize: client ${JSON.stringify(params?.clientInfo || {})} asked ${want}, answering ${legacyVersion}`);
        return { protocolVersion: legacyVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return complete(modern, {});
      case "server/discover":
        return {
          resultType: "complete", supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} },
          _meta: { [META_SERVER_INFO]: SERVER_INFO }, instructions: INSTRUCTIONS,
        };
      case "tools/list":
        return complete(modern, { tools: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": {
        if (!params || typeof params !== "object" || typeof params.name !== "string") throw new RpcError(ERR.INVALID_PARAMS, "tools/call needs params.name (a string)");
        if (!TOOLS.some(t => t.name === params.name)) throw new RpcError(ERR.INVALID_PARAMS, `Unknown tool: ${params.name}`);
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new RpcError(ERR.INVALID_PARAMS, "tools/call params.arguments must be an object");
        return complete(modern, await callTool(params.name, args, ctx));
      }
      default:
        if (isNotification) return null;                        // unknown notifications are ignored
        throw new RpcError(ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  return async function handle(msg) {
    if (Array.isArray(msg) || !msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: msg && typeof msg === "object" && !Array.isArray(msg) && "id" in msg ? msg.id : null,
        error: { code: ERR.INVALID_REQUEST, message: "Invalid Request: expected one JSON-RPC 2.0 object" } };
    }
    if (!("method" in msg)) return null;                         // a response from the client: nothing to answer
    const isNotification = !("id" in msg);
    if (typeof msg.method !== "string") {
      return isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code: ERR.INVALID_REQUEST, message: "Invalid Request: method must be a string" } };
    }
    try {
      const result = await dispatch(msg.method, msg.params, isNotification);
      if (isNotification) return null;
      return { jsonrpc: "2.0", id: msg.id, result: result ?? {} };
    } catch (e) {
      if (isNotification) { log(`notification ${msg.method} failed: ${e.message}`); return null; }
      if (e instanceof RpcError) return { jsonrpc: "2.0", id: msg.id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } };
      log(`internal error in ${msg.method}: ${e && e.stack || e}`);
      return { jsonrpc: "2.0", id: msg.id, error: { code: ERR.INTERNAL, message: `Internal error: ${e && e.message || e}` } };
    }
  };
}

/**
 * Serve MCP on newline-delimited stdio until stdin ends. Resolves when every in-flight request has been answered.
 * opts: { cli: [cmd, ...args] (how to run the Snapper CLI), env (extra env for the CLI), stdin, stdout, stderr }.
 */
export function startMcp({ cli, env = {}, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (!Array.isArray(cli) || !cli.length || cli.some(x => typeof x !== "string" || !x)) throw new Error("startMcp: cli must be [cmd, ...args]");
  const log = msg => { try { stderr.write(`[snapper-mcp] ${msg}\n`); } catch {} };
  // Nothing but protocol may reach stdout: route stray console output to stderr while serving on the real stdout.
  if (stdout === process.stdout) {
    for (const k of ["log", "info", "debug", "warn"]) console[k] = (...a) => log(a.map(String).join(" "));
  }
  const handle = createHandler({ cli, env, log });
  const send = obj => { try { stdout.write(JSON.stringify(obj) + "\n"); } catch (e) { log(`write failed: ${e.message}`); } };
  const inflight = new Set();
  log(`ready (cli: ${cli.join(" ")})`);
  return new Promise(resolve => {
    const rl = createInterface({ input: stdin, crlfDelay: Infinity });
    rl.on("line", line => {
      const text = line.trim();
      if (!text) return;
      let msg;
      try { msg = JSON.parse(text); } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: ERR.PARSE, message: "Parse error: not JSON" } });
        return;
      }
      const p = handle(msg).then(r => { if (r) send(r); }, e => log(`handler crashed: ${e && e.stack || e}`));
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    });
    rl.on("close", async () => {
      await Promise.allSettled([...inflight]);
      log("stdin closed; exiting");
      resolve(0);
    });
  });
}

/** Split a command line on spaces, honouring double quotes: `node "C:/a b/snapper.mjs"` → ["node", "C:/a b/snapper.mjs"]. */
export function splitCommand(s) {
  const out = [];
  let cur = "", quoted = false, any = false;
  for (const ch of String(s)) {
    if (ch === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (any || cur) out.push(cur); cur = ""; any = false; continue; }
    cur += ch;
  }
  if (any || cur) out.push(cur);
  return out;
}

const isMain = process.argv[1] && /[\\/]mcp[\\/]server\.mjs$/i.test(process.argv[1]);
if (isMain) {
  const i = process.argv.indexOf("--cli");
  const cli = i > 0 && process.argv[i + 1] ? splitCommand(process.argv[i + 1]) : null;
  if (!cli || !cli.length) {
    process.stderr.write('usage: node packages/mcp/server.mjs --cli "node <snapper-repo>/bin/snapper.mjs"\n');
    process.exitCode = 2;
  } else {
    startMcp({ cli }).then(code => { process.exitCode = code; });
  }
}
