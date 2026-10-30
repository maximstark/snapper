// Y6 (e2e): the MCP server driving the REAL Snapper CLI on a real demo session: list, read, image, replay, check.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isPng, pngSize, readJson } from "../../packages/core/index.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO, "bin", "snapper.mjs");
const DEMO = join(REPO, "examples", "demo");

function mcp() {
  const child = spawn(process.execPath, [CLI, "mcp"], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", id = 0, stderr = "";
  const waiting = new Map(), lines = [];
  child.stderr.on("data", d => { stderr += d; });
  child.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      lines.push(line);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
    }
  });
  const exited = new Promise(r => child.on("close", r));
  return {
    request(method, params) { const rid = ++id; return new Promise(r => { waiting.set(rid, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n"); }); },
    call(name, args) { return this.request("tools/call", { name, arguments: args }); },
    get stderr() { return stderr; },
    async close() { child.stdin.end(); return { code: await exited, lines }; },
  };
}

let tmp, session, c;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "snapper-mcp-e2e-"));
  const r = spawnSync(process.execPath, [CLI, "play", DEMO, "--smoke", join(DEMO, "smoke.json"), "--out", tmp], { cwd: REPO, encoding: "utf8", timeout: 180000 });
  const last = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.equal(last.ok, true, r.stderr);
  session = last.session;
  c = mcp();
  const init = await c.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-11-25");
});
after(async () => { await c?.close(); await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

test("mcp e2e: list_sessions, read_session, read_mark, mark_image on a real demo session", async () => {
  const l = await c.call("list_sessions", { root: DEMO, out: tmp });
  assert.equal(l.result.structuredContent.rows.length, 1, JSON.stringify(l.result));
  assert.equal(l.result.structuredContent.rows[0].marks, 5);
  const s = await c.call("read_session", { session });
  assert.match(s.result.content[0].text, /^# Snapper session /);
  const m = await c.call("read_mark", { session, mark: "0001" });
  assert.equal(m.result.structuredContent.replayable, true);
  assert.equal(m.result.structuredContent.note, "smoke mark");
  const env = await readJson(join(session, "env.json"));
  const shot = await c.call("mark_image", { session, mark: "0001", which: "shot" });
  const buf = Buffer.from(shot.result.content[0].data, "base64");
  assert.ok(isPng(buf));
  assert.deepEqual(pngSize(buf), { w: env.window.w * env.display.dpr, h: env.window.h * env.display.dpr });
  const frame = await c.call("mark_image", { session, mark: "0001", which: "frame" });
  assert.deepEqual([frame.result.structuredContent.width, frame.result.structuredContent.height], [320, 180]);
});

test("mcp e2e: replay through the CLI gives stateMatches true", async () => {
  const r = await c.call("replay", { session, mark: "0001" });
  assert.equal(r.result.isError, undefined, JSON.stringify(r.result).slice(0, 500));
  assert.equal(r.result.structuredContent.stateMatches, true);
  assert.match(r.result.content[0].text, /stateMatches: true/);
});

test("mcp e2e: check through the CLI matches every replayable mark", async () => {
  const r = await c.call("check", { root: DEMO, out: tmp });
  assert.equal(r.result.isError, undefined, JSON.stringify(r.result).slice(0, 800));
  const { summary, rows } = r.result.structuredContent;
  assert.ok(rows.length >= 5, JSON.stringify(rows));
  assert.equal(summary.differs, 0, JSON.stringify(rows));
  assert.equal(summary.error, 0, JSON.stringify(rows));
  assert.ok(summary.match >= 1);
  assert.equal(r.result.structuredContent.exit, 0);
});
