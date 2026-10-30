// Y6 (unit): the MCP server over real stdio with a scripted client. The CLI it shells out to is a fake (no Electron);
// tests/e2e/mcp.test.mjs drives the real CLI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionA } from "../fixtures/session-a.mjs";
import { isPng, pngSize } from "../../packages/core/index.mjs";
import { splitCommand, createHandler, SUPPORTED_VERSIONS } from "../../packages/mcp/server.mjs";
import { cliSpec } from "../../packages/host/tools/mcp.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = join(REPO, "packages", "mcp", "server.mjs");
const FAKE = join(REPO, "tests", "fixtures", "fake-cli.mjs");
const SIX = ["list_sessions", "read_session", "read_mark", "mark_image", "replay", "check"];
const TEN = [...SIX, "set_triage", "issue_markdown", "import_session", "export_repro"];        // v1.4 adds four

/** A scripted stdio client: request(method, params) → the response; notify(); raw(line); close() → { stdoutLines, code }. */
function client(cliLine) {
  const child = spawn(process.execPath, [SERVER, "--cli", cliLine], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", id = 0, stderr = "";
  const lines = [], waiting = new Map(), unsolicited = [];
  child.stderr.on("data", d => { stderr += d; });
  child.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      lines.push(line);
      const msg = JSON.parse(line);                 // throws (fails the test) if anything but JSON reaches stdout
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); } else unsolicited.push(msg);
    }
  });
  const exited = new Promise(r => child.on("close", code => r(code)));
  return {
    request(method, params, rid = ++id) {
      return new Promise(r => { waiting.set(rid, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, ...(params !== undefined ? { params } : {}) }) + "\n"); });
    },
    notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n"); },
    raw(line, rid) { return new Promise(r => { waiting.set(rid, r); child.stdin.write(line + "\n"); }); },
    call(name, args) { return this.request("tools/call", { name, arguments: args }); },
    unsolicited, get stderr() { return stderr; },
    async close() { child.stdin.end(); const code = await exited; return { code, lines }; },
  };
}

let root, dir, c;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "snapper-mcp-"));
  dir = join(root, ".snapper", "sessions", "moonflexforceabilities-v3", "2026-10-18T14-02-11");
  await mkdir(dir, { recursive: true });
  await buildSessionA(dir, { garbage: false });
  c = client(`"${process.execPath}" "${FAKE}"`);
});
after(async () => { await rm(root, { recursive: true, force: true }); });

test("mcp: legacy initialize echoes a known version, answers the latest for an unknown one; initialized is silent", async () => {
  const r = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.equal(r.result.serverInfo.name, "snapper");
  assert.equal(r.result.serverInfo.version, "1.4.0");
  const r2 = await c.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
  assert.equal(r2.result.protocolVersion, "2025-11-25");
  c.notify("notifications/initialized");
  const p = await c.request("ping");
  assert.deepEqual(p.result, {});
  assert.equal(c.unsolicited.length, 0, "a notification got an answer");
});

test("mcp: tools/list is exactly the ten tools (v1.3's six + v1.4's four), each with an object inputSchema", async () => {
  const r = await c.request("tools/list", {});
  assert.deepEqual(r.result.tools.map(t => t.name), TEN);
  for (const t of r.result.tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(t.description.length > 20, t.name);
  }
});

test("mcp: modern era (2026-07-28 _meta): server/discover, resultType, unsupported version error", async () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
  const d = await c.request("server/discover", { _meta: meta });
  assert.equal(d.result.resultType, "complete");
  assert.deepEqual(d.result.supportedVersions, SUPPORTED_VERSIONS);
  assert.ok(d.result.supportedVersions.includes("2026-07-28"));
  assert.deepEqual(d.result.capabilities, { tools: {} });
  assert.equal(d.result._meta["io.modelcontextprotocol/serverInfo"].name, "snapper");
  const l = await c.request("tools/list", { _meta: meta });
  assert.equal(l.result.resultType, "complete");
  assert.deepEqual(l.result.tools.map(t => t.name), TEN);
  const bad = await c.request("tools/list", { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
  assert.equal(bad.error.code, -32022);
  assert.equal(bad.error.data.requested, "1900-01-01");
  assert.deepEqual(bad.error.data.supported, SUPPORTED_VERSIONS);
});

test("mcp: list_sessions and read_session on a fixture game", async () => {
  const r = await c.call("list_sessions", { root });
  assert.equal(r.result.isError, undefined);
  assert.equal(r.result.structuredContent.rows.length, 1);
  assert.equal(r.result.structuredContent.rows[0].marks, 2);
  assert.match(r.result.content[0].text, /2026-10-18T14-02-11/);
  assert.ok(!existsSync(join(dir, "SESSION.md")));
  const s = await c.call("read_session", { session: dir });
  assert.equal(s.result.structuredContent.regenerated, true);
  assert.match(s.result.content[0].text, /^# Snapper session 2026-10-18T14-02-11/);
  assert.match(s.result.content[0].text, /swan clips through the sluice/);
  const s2 = await c.call("read_session", { session: dir });
  assert.equal(s2.result.structuredContent.regenerated, false);
});

test("mcp: read_mark returns note, state, summaries, files, replayable", async () => {
  const r = await c.call("read_mark", { session: dir, mark: "1" });
  const m = r.result.structuredContent;
  assert.equal(m.mark, "0001");
  assert.equal(m.note, "swan clips through the sluice");
  assert.equal(m.state.level, "2-2");
  assert.equal(m.replayable, true);
  assert.match(m.replayCommand, /snapper replay .* 0001$/);
  assert.ok(m.files.includes("shot.png") && m.files.includes("state.json") && m.files.includes("before/sheet.png"));
  assert.ok("inputs" in m && "perf" in m && "logTail" in m);
  assert.deepEqual(JSON.parse(r.result.content[0].text).mark, "0001");
});

test("mcp: mark_image returns a valid PNG as image content with its dimensions", async () => {
  for (const which of ["shot", "frame", "sheet"]) {
    const r = await c.call("mark_image", { session: dir, mark: "0001", which });
    const img = r.result.content.find(x => x.type === "image");
    assert.equal(img.mimeType, "image/png", which);
    const buf = Buffer.from(img.data, "base64");
    assert.ok(isPng(buf), which);
    assert.deepEqual(pngSize(buf), { w: 2, h: 2 });
    assert.equal(r.result.structuredContent.width, 2);
    assert.equal(r.result.structuredContent.height, 2);
  }
  const none = await c.call("mark_image", { session: dir, mark: "0002", which: "frame" });
  assert.equal(none.result.isError, true);
  assert.match(none.result.content[0].text, /no frame\.png/);
  const bad = await c.call("mark_image", { session: dir, mark: "0001", which: "video" });
  assert.equal(bad.result.isError, true);
});

test("mcp: replay and check shell out to the CLI", async () => {
  const r = await c.call("replay", { session: dir, mark: "0001" });
  assert.equal(r.result.isError, undefined, JSON.stringify(r.result));
  assert.equal(r.result.structuredContent.stateMatches, true);
  assert.match(r.result.content[0].text, /# Replay of mark 0001/);
  const refused = await c.call("replay", { session: dir, mark: "0002" });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /exited 2: .*not replayable/);
  const k = await c.call("check", { root, sessions: 2, accept: false });
  assert.equal(k.result.isError, undefined, JSON.stringify(k.result));
  assert.equal(k.result.structuredContent.rows.length, 2);
  assert.equal(k.result.structuredContent.exit, 1);
  assert.match(k.result.content[0].text, /differs \$\.player\.x/);
  assert.match(k.result.content[0].text, /match 1 · differs 1/);
  const badN = await c.call("check", { root, sessions: 0 });
  assert.equal(badN.result.isError, true);
});

test("mcp v1.4: set_triage writes triage.json (and read_mark returns it); import_session and export_repro shell out to the CLI", async () => {
  const t = await c.call("set_triage", { session: dir, mark: "1", status: "fixed", commit: "abc1234", note: "found it" });
  assert.equal(t.result.isError, undefined, JSON.stringify(t.result));
  assert.equal(t.result.structuredContent.triage.status, "fixed");
  assert.equal(t.result.structuredContent.triage.by, "claude");
  assert.match(t.result.content[0].text, /^mark 0001: fixed by claude .* commit abc1234 · "found it"/);
  const doc = JSON.parse(await readFile(join(dir, "marks", "0001", "triage.json"), "utf8"));
  assert.equal(doc.commit, "abc1234");
  assert.match(await readFile(join(dir, "SESSION.md"), "utf8"), /^Triage: fixed by claude/m);
  const rm = await c.call("read_mark", { session: dir, mark: "0001" });
  assert.equal(rm.result.structuredContent.triage.status, "fixed");
  const bad = await c.call("set_triage", { session: dir, mark: "0001", status: "done" });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /must be one of open, fixed/);
  const dup = await c.call("set_triage", { session: dir, mark: "0001", status: "duplicate" });
  assert.equal(dup.result.isError, true);
  assert.match(dup.result.content[0].text, /needs --of/);
  // import_session: the fake CLI "imports" by printing a session folder
  const zip = join(root, "outbox.zip");
  await writeFile(zip, "PK");
  const im = await c.call("import_session", { zip, root });
  assert.equal(im.result.isError, undefined, JSON.stringify(im.result));
  assert.equal(im.result.structuredContent.session, dir);
  assert.match(im.result.content[0].text, /^imported 2026-10-18T14-02-11/);
  const imBad = await c.call("import_session", { zip: join(root, "missing.zip"), root });
  assert.equal(imBad.result.isError, true);
  // export_repro: the fake CLI writes a README and prints the folder last
  const ex = await c.call("export_repro", { session: dir, mark: "0001" });
  assert.equal(ex.result.isError, undefined, JSON.stringify(ex.result));
  assert.match(ex.result.content[0].text, /# No-Snapper repro of mark 0001/);
  assert.match(ex.result.structuredContent.dir.replace(/\\/g, "/"), /marks\/0001\/repro$/);
});

test("mcp: bad paths, bad marks and bad arguments are isError results", async () => {
  const cases = [
    ["list_sessions", { root: join(root, "nope") }, /not found/],
    ["read_session", { session: root }, /no session\.jsonl/],
    ["read_session", {}, /"session" must be a non-empty string/],
    ["read_mark", { session: dir, mark: "0009" }, /does not exist/],
    ["read_mark", { session: dir, mark: "../x" }, /must be a mark id/],
    ["replay", { session: join(root, "missing"), mark: "0001" }, /not found/],
  ];
  for (const [name, args, re] of cases) {
    const r = await c.call(name, args);
    assert.equal(r.result.isError, true, name);
    assert.match(r.result.content[0].text, re, name);
  }
});

test("mcp: protocol errors: unknown tool, unknown method, malformed line, invalid request", async () => {
  const u = await c.call("frobnicate", {});
  assert.equal(u.error.code, -32602);
  assert.match(u.error.message, /Unknown tool: frobnicate/);
  const m = await c.request("resources/list", {});
  assert.equal(m.error.code, -32601);
  const p = await c.raw("{this is not json", null);
  assert.equal(p.error.code, -32700);
  assert.equal(p.id, null);
  const inv = await c.raw(JSON.stringify({ id: 77, method: "ping" }), 77);
  assert.equal(inv.error.code, -32600);
  const still = await c.request("ping");                     // still serving after the bad lines
  assert.deepEqual(still.result, {});
});

test("mcp: stdout carries only JSON-RPC lines; the server exits 0 when stdin closes", async () => {
  const { code, lines } = await c.close();
  assert.equal(code, 0, c.stderr);
  assert.ok(lines.length > 10);
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, "2.0");
  assert.match(c.stderr, /\[snapper-mcp\] ready/);
});

test("mcp: splitCommand, cliSpec, handler without a transport", async () => {
  assert.deepEqual(splitCommand('node "C:/a b/snapper.mjs" --x'), ["node", "C:/a b/snapper.mjs", "--x"]);
  assert.deepEqual(splitCommand("node C:/Coding/Snapper/bin/snapper.mjs"), ["node", "C:/Coding/Snapper/bin/snapper.mjs"]);
  const dev = cliSpec({ execPath: "C:/n/node.exe", electron: undefined, appRoot: "C:/app" });
  assert.equal(dev.cli[0], "C:/n/node.exe");
  assert.match(dev.cli[1].replace(/\\/g, "/"), /C:\/app\/packages\/host\/bin\/snapper\.mjs$/);
  assert.deepEqual(dev.env, {});
  const packaged = cliSpec({ execPath: "C:/S/Snapper.exe", electron: "44.9.0", appRoot: "C:/S/resources/app" });
  assert.deepEqual(packaged.env, { ELECTRON_RUN_AS_NODE: "1" });
  const h = createHandler({ cli: ["x"] });
  assert.equal(await h({ jsonrpc: "2.0", method: "notifications/whatever" }), null);
  assert.equal((await h({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_mark", arguments: [] } })).error.code, -32602);
});

test("mcp: the package has no dependencies and no host imports (D-005)", async () => {
  const pkg = JSON.parse(await readFile(join(REPO, "packages", "mcp", "package.json"), "utf8"));
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.dependencies, undefined);
  for (const f of ["server.mjs", "tools.mjs"]) {
    const src = await readFile(join(REPO, "packages", "mcp", f), "utf8");
    assert.doesNotMatch(src, /from\s+["'][^"']*host\//, f);
    assert.doesNotMatch(src, /["']electron["']/, f);
    assert.doesNotMatch(src, /console\.log\(/, f);
    for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) assert.ok(m[1].startsWith("node:") || m[1].startsWith("./") || m[1].startsWith("../core/"), `${f}: ${m[1]}`);
  }
  assert.ok(existsSync(join(REPO, "packages", "mcp", "LICENSE")));
  void writeFile;
});
