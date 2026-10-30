// Z4 — the playtester kit (BRIEF-v1.4 §3.5): pack the demo (and, when dist/win-unpacked exists, with --bundle), unzip with
// Windows' tar.exe, assert the layout; play the kit in tester mode (PENDING until tester mode lands: wave 2); then the
// tester-independent half: a synthetic outbox zip (a normal demo session whose COPY has tester { name }) is imported into a
// fresh demo root, listed `from <name>`, replayed (stateMatches true, via import.json root) and read over MCP.
//   node scripts/verify-kit.mjs        EVIDENCE=1 writes private/evidence/v1.4/z4/
import { join } from "node:path";
import { readFile, writeFile, mkdir, rm, cp, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { REPO, CLI, snapper, checklist, exists, EVIDENCE_ON } from "./lib.mjs";
import { zipDir, readZipEntry, readZip } from "../packages/core/index.mjs";

const W2 = join(REPO, "sessions", "w2");
const KIT = join(W2, "kit");
const DEMO = join(REPO, "examples", "demo");
const TAR = join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe");
const c = checklist("Z4 playtester kit");
const pendingNames = new Set();
/** A check that may fail only because tester mode (wave 2) is not built yet: printed PEND, not counted as a failure. */
function pending(name, ok, detail = "") {
  if (ok) return c.check(name, true, detail);
  pendingNames.add(name);
  c.items.push({ name, ok: false, pending: true, detail });
  process.stdout.write(`PEND  ${name}  — ${detail} (pending tester mode)\n`);
  return false;
}
const mb = n => (n < 1048576 ? `${Math.round(n / 1024)} KB` : `${Math.round(n / 1048576 * 10) / 10} MB`);

await rm(KIT, { recursive: true, force: true });
await mkdir(KIT, { recursive: true });
const tmp = join(tmpdir(), `snapper-kit-${process.pid}`);
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
const sizes = {};

async function untar(zip, dest) {
  await mkdir(dest, { recursive: true });
  execFileSync(TAR, ["-xf", zip, "-C", dest], { stdio: "pipe" });
}

// ---- 1. pack, plain
const plainZip = join(KIT, "demo-kit.zip");
const p1 = await snapper(["pack", DEMO, "--out", plainZip, "--developer", "Ada"], { echo: false });
c.check("pack examples/demo (no bundle)", p1.code === 0 && await exists(plainZip), p1.stderr.trim());
sizes.plain = (await stat(plainZip)).size;
const U1 = join(tmp, "plain");
await untar(plainZip, U1);
c.check("tar.exe unzips it: game/index.html, game/game.js, PLAY.cmd, README-TESTER.txt, snapper.config.json",
  ["game/index.html", "game/game.js", "PLAY.cmd", "README-TESTER.txt", "snapper.config.json"].every(f => existsSync(join(U1, ...f.split("/")))));
const cfg = JSON.parse(await readFile(join(U1, "snapper.config.json"), "utf8"));
c.check("snapper.config.json: developer, tester true, pack.sha, slug", cfg.developer === "Ada" && cfg.tester === true && /^[0-9a-f]{40}$/.test(cfg.pack?.sha) && cfg.slug === "demo", JSON.stringify(cfg.pack));
const play = await readFile(join(U1, "PLAY.cmd"), "utf8");
c.check("PLAY.cmd runs the installed snapper.cmd with --tester and the kit config, else opens the README",
  play.includes("%LOCALAPPDATA%\\Programs\\Snapper\\snapper.cmd") && play.includes('play "%~dp0game" --tester --config "%~dp0snapper.config.json"') && play.includes('notepad "%~dp0README-TESTER.txt"') && play.includes("\r\n"));
const readme = await readFile(join(U1, "README-TESTER.txt"), "utf8");
c.check("README-TESTER.txt names the developer, F8, PLAY.cmd, outbox, and the download line", /Ada/.test(readme) && /F8/.test(readme) && /PLAY\.cmd/.test(readme) && /outbox/.test(readme) && /Download Snapper:/.test(readme));
c.check("no .git / node_modules / .snapper / outbox inside game/", !(await readdir(join(U1, "game"))).some(n => [".git", "node_modules", ".snapper", "outbox", ".claude", "dist"].includes(n)));

// ---- 1b. pack, bundled
const winUnpacked = join(REPO, "dist", "win-unpacked");
const bundleZip = join(KIT, "demo-kit-bundle.zip");
if (existsSync(join(winUnpacked, "snapper.cmd"))) {
  const t0 = Date.now();
  const p2 = await snapper(["pack", DEMO, "--out", bundleZip, "--bundle", "--developer", "Ada"], { echo: false, timeoutMs: 900000 });
  c.check("pack --bundle", p2.code === 0 && await exists(bundleZip), `${p2.stderr.trim()} (${Math.round((Date.now() - t0) / 1000)} s)`);
  sizes.bundle = (await stat(bundleZip)).size;
  const U2 = join(tmp, "bundle");
  await untar(bundleZip, U2);
  const play2 = await readFile(join(U2, "PLAY.cmd"), "utf8");
  c.check("bundle: snapper/Snapper.exe and snapper/snapper.cmd present; game/index.html; PLAY.cmd runs the bundled snapper.cmd",
    existsSync(join(U2, "snapper", "Snapper.exe")) && existsSync(join(U2, "snapper", "snapper.cmd")) && existsSync(join(U2, "game", "index.html"))
    && play2.includes('%~dp0snapper\\snapper.cmd') && !play2.includes("LOCALAPPDATA"));
  await rm(U2, { recursive: true, force: true });
} else process.stdout.write("note: dist/win-unpacked missing, bundle kit skipped\n");
process.stdout.write(`kit sizes: plain ${mb(sizes.plain)}${sizes.bundle ? `, bundle ${mb(sizes.bundle)}` : ""}\n`);

// ---- 2. play the kit in tester mode (pending until wave 2)
const PLAYKIT = join(KIT, "play-kit");
await untar(plainZip, PLAYKIT);
const smokeFile = join(KIT, "tester-smoke.json");
await writeFile(smokeFile, JSON.stringify([
  { wait: 1500 }, { type: "Ann" }, { key: "Enter" }, { wait: 1200 },
  { keys: ["KeyD", "Space"], hold: 600 }, { mark: "tester note: the jump feels floaty" }, { wait: 500 }, { end: true },
], null, 2));
const ud = join(KIT, "userdata");
const pr2 = await new Promise(resolve => {
  const child = spawn(process.execPath, [CLI, "play", join(PLAYKIT, "game"), "--tester", "--config", join(PLAYKIT, "snapper.config.json"), "--smoke", smokeFile],
    { cwd: REPO, env: { ...process.env, SNAPPER_NO_SHELL: "1", SNAPPER_USER_DATA: ud }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { err += d; });
  const t = setTimeout(() => child.kill(), 180000);
  child.on("close", code => { clearTimeout(t); resolve({ code, out, err }); });
});
let last = null;
try { last = JSON.parse(pr2.out.trim().split(/\r?\n/).pop()); } catch {}
pending("tester play: the smoke ran (exit 0, ok)", pr2.code === 0 && last?.ok === true, `${pr2.code} ${pr2.err.trim().split("\n").slice(-2).join(" | ")}`);
const testerJson = await readFile(join(PLAYKIT, "tester.json"), "utf8").then(JSON.parse, () => null);
pending("tester play: <kit>/tester.json = { name: Ann, at }", testerJson?.name === "Ann" && !!testerJson?.at, JSON.stringify(testerJson));
const outboxDir = join(PLAYKIT, "outbox");
const outboxZips = existsSync(outboxDir) ? (await readdir(outboxDir)).filter(n => n.endsWith(".zip")) : [];
pending("tester play: <kit>/outbox/<slug>-<session id>.zip exists", outboxZips.length === 1 && /^demo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}.*\.zip$/.test(outboxZips[0]), outboxZips.join(", "));
let envInZip = null;
if (outboxZips[0]) {
  const entries = await readZip(join(outboxDir, outboxZips[0]));
  const envEntry = entries.find(e => /^[^/]+\/env\.json$/.test(e.name));
  if (envEntry) envInZip = JSON.parse((await readZipEntry(join(outboxDir, outboxZips[0]), envEntry.name)).toString("utf8"));
}
pending("tester play: the outbox zip's env.json has tester.name Ann", envInZip?.tester?.name === "Ann", JSON.stringify(envInZip?.tester));

// ---- 3. tester-independent: synthetic outbox zip -> import -> list -> replay -> MCP
const REC = join(W2, "rec");
await rm(REC, { recursive: true, force: true });
const rec = await snapper(["play", DEMO, "--smoke", join(DEMO, "smoke.json"), "--out", REC], { timeoutMs: 240000, echo: false });
const S = rec.last?.session;
c.check("recorded a normal demo session for the synthetic outbox", rec.code === 0 && !!S, rec.lastLine);
if (!S) { c.report(); process.exit(1); }
const id = S.split(/[\\/]/).pop();
const COPY = join(KIT, "synthetic", id);
await cp(S, COPY, { recursive: true });
const envPath = join(COPY, "env.json");
const env = JSON.parse(await readFile(envPath, "utf8"));
env.tester = { name: "Ann" };
await writeFile(envPath, JSON.stringify(env, null, 2) + "\n");
c.check("the original session's env.json is untouched (no tester)", !JSON.parse(await readFile(join(S, "env.json"), "utf8")).tester);
const outbox = join(KIT, "synthetic", `demo-${id}.zip`);
await zipDir(COPY, outbox, { prefix: `${id}/` });
const ROOT = join(KIT, "root");
await cp(DEMO, ROOT, { recursive: true });
const imp = await snapper(["import", outbox, "--root", ROOT], { echo: false });
const impDir = imp.stdout.trim().split(/\r?\n/)[0];
c.check("import into a fresh demo copy prints the folder and the Copy-for-Claude line", imp.code === 0 && impDir === join(ROOT, ".snapper", "sessions", "demo", id) && /^Read ".*SESSION\.md" and triage it with the snapper skill\.$/m.test(imp.stdout), imp.stdout.trim() + imp.stderr.trim());
c.check("import.json: root, tester, from", await readFile(join(impDir, "import.json"), "utf8").then(t => { const j = JSON.parse(t); return j.root === ROOT && j.tester === "Ann" && j.from === `demo-${id}.zip`; }, () => false));
c.check("SESSION.md says tester: Ann; SESSION.html exists", /tester: Ann/.test(await readFile(join(impDir, "SESSION.md"), "utf8").catch(() => "")) && existsSync(join(impDir, "SESSION.html")));
const again = await snapper(["import", outbox, "--root", ROOT], { echo: false });
c.check("a second import of the same id is refused (exit 2)", again.code === 2);
const lst = await snapper(["list", ROOT], { echo: false });
c.check("snapper list shows the session `from Ann`", lst.code === 0 && lst.stdout.includes(id) && lst.stdout.includes("from Ann"), lst.stdout.trim());
const rp = await snapper(["replay", impDir, "0001"], { timeoutMs: 240000, echo: false });
const rj = await readFile(join(impDir, "marks", "0001", "replay", "replay.json"), "utf8").then(JSON.parse, () => null);
c.check("replay of the imported session 0001: stateMatches true (import.json root served the game)", rp.code === 0 && rj?.stateMatches === true, rp.stderr.trim().split("\n").slice(-2).join(" | "));

// MCP read_session over stdio
const mcpResult = await new Promise(resolve => {
  const child = spawn(process.execPath, [join(REPO, "packages", "mcp", "server.mjs"), "--cli", `node ${CLI.replace(/\\/g, "/")}`], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const replies = new Map();
  child.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); replies.set(m.id, m); } catch {} }
  });
  const send = m => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "verify-kit", version: "1" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/call", params: { name: "read_session", arguments: { session: impDir } } });
  const t0 = Date.now();
  const poll = setInterval(() => {
    if (replies.has(2) || Date.now() - t0 > 30000) { clearInterval(poll); child.stdin.end(); child.kill(); resolve(replies.get(2) || null); }
  }, 100);
});
const mcpText = mcpResult?.result?.content?.map(x => x.text).join("\n") || "";
c.check("MCP read_session on the imported session returns its SESSION.md (tester shown)", !!mcpResult && !mcpResult.result?.isError && /# Snapper session/.test(mcpText) && /tester: Ann/.test(mcpText), mcpText.slice(0, 80) || JSON.stringify(mcpResult)?.slice(0, 200));

await rm(tmp, { recursive: true, force: true }).catch(() => {});
const hard = c.items.filter(i => !i.ok && !i.pending).length;
const pend = c.items.filter(i => i.pending).length;
const okAll = hard === 0;
process.stdout.write(`\nZ4 playtester kit: ${okAll ? "PASS" : "FAIL"} (${c.items.length - pend} checks counted, ${hard} failed; ${pend} pending tester mode)\n`);
if (EVIDENCE_ON) {
  const dir = join(REPO, "private", "evidence", "v1.4", "z4");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "checks.json"), JSON.stringify({ gate: "Z4", date: new Date().toISOString(), ok: okAll, kitSizesBytes: sizes, pendingTesterMode: [...pendingNames], checks: c.items }, null, 2) + "\n");
  await writeFile(join(dir, "kit-layout.txt"), (await readZip(plainZip)).map(e => `${e.size}\t${e.name}`).join("\n") + "\n");
  process.stdout.write(`evidence: 2 files in ${dir}\n`);
}
process.exit(okAll ? 0 : 1);
