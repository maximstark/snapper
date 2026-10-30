// v1.4 `snapper issue`: --markdown, gh resolution (PATHEXT, .cmd through cmd.exe), --github against the stub gh.cmd,
// --discord multipart against a local server (no network), the webhook URL never lands in a session or a message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { readTriage } from "../../packages/core/index.mjs";
import { resolveGh, runGh, sanitizeForCmd, urlFromGhOutput, redactUrl, buildDiscordForm, discordContent, discordPost } from "../../packages/host/tools/issue.mjs";
import { makeSession, snapperAsync, GH_STUB_DIR } from "../fixtures/team.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "snapper-tissue-"));
const win = process.platform === "win32";
const SHOT = join; // (placeholder to keep imports honest)
void SHOT;

/** A game root with a snapper.config.json, and a session whose env.game.root names it. */
async function gameAndSession(config = {}) {
  const base = await tmp();
  const root = join(base, "game");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.html"), "<html></html>");
  await writeFile(join(root, "snapper.config.json"), JSON.stringify(config));
  const dir = await makeSession(join(base, "sessions"), { gameRoot: root });
  return { root, dir, base };
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

test("issue --markdown (default): writes marks/NNNN/issue.md = # title + body, prints it", async () => {
  const { dir } = await gameAndSession();
  const r = await snapperAsync(["issue", dir, "1"]);
  assert.equal(r.status, 0, r.stderr);
  const md = await readFile(join(dir, "marks", "0001", "issue.md"), "utf8");
  assert.equal(r.stdout, md);
  assert.ok(md.startsWith("# pigeon clips through the ledge — demo-game 2026-10-18T14-02-11 mark 0001\n\n## What was seen"));
  const t = await snapperAsync(["issue", dir, "0001", "--markdown", "--title", "My own title"]);
  assert.equal(t.status, 0, t.stderr);
  assert.ok((await readFile(join(dir, "marks", "0001", "issue.md"), "utf8")).startsWith("# My own title\n\n"));
  assert.equal((await snapperAsync(["issue", dir, "7"])).status, 2);
  assert.equal((await snapperAsync(["issue", dir])).status, 2);
  assert.equal((await snapperAsync(["issue", dir, "1", "--github", "--markdown"])).status, 2, "modes are exclusive");
});

test("resolveGh honours PATH order and PATHEXT; .cmd/.bat need a shell, .exe does not", async () => {
  const a = await tmp(), b = await tmp(), empty = await tmp();
  await writeFile(join(a, "gh.cmd"), "@echo a");
  await writeFile(join(b, "gh.exe"), "MZ");
  await writeFile(join(b, "gh.cmd"), "@echo b");
  const env = (...dirs) => ({ PATH: dirs.join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD" });
  assert.deepEqual(resolveGh(env(empty), "win32"), null);
  const first = resolveGh(env(a, b), "win32");
  assert.equal(first.shell, true);
  assert.ok(first.file.toLowerCase().endsWith(join(a, "gh.cmd").toLowerCase()));
  const exe = resolveGh(env(b), "win32");
  assert.equal(exe.shell, false, "PATHEXT order: .EXE before .CMD in the same folder");
  assert.ok(exe.file.toLowerCase().endsWith("gh.exe"));
  assert.equal(resolveGh({ PATH: b, PATHEXT: ".CMD" }, "win32").shell, true);
  assert.equal(resolveGh({ PATH: `"${a}"`, PATHEXT: ".CMD" }, "win32").shell, true, "quoted PATH entries");
  await writeFile(join(empty, "gh.bat"), "@echo c");
  assert.equal(resolveGh({ PATH: empty, PATHEXT: ".EXE;.BAT" }, "win32").shell, true);
  assert.equal(resolveGh({ PATH: empty, PATHEXT: ".EXE" }, "win32"), null, "an extension outside PATHEXT is not found");
});

test("sanitizeForCmd drops the characters cmd.exe cannot quote; urlFromGhOutput takes the last URL", () => {
  assert.equal(sanitizeForCmd('a "b" 100% ^c & d | e < f > g!'), "a b 100 c d e f g");
  assert.equal(urlFromGhOutput("Creating issue in x/y\n\nhttps://github.com/x/y/issues/7\n"), "https://github.com/x/y/issues/7");
  assert.equal(urlFromGhOutput("nothing"), null);
});

test("runGh runs the stub gh.cmd through cmd.exe and records args + body", { skip: !win }, async () => {
  const gh = resolveGh({ PATH: GH_STUB_DIR, PATHEXT: ".EXE;.CMD" });
  assert.equal(gh.shell, true);
  const outFile = join(await tmp(), "rec.json");
  const body = join(await tmp(), "b.md");
  await writeFile(body, "# hello body");
  const r = await runGh(gh, ["issue", "create", "--title", "Some title, with comma", "--body-file", body], { cwd: tmpdir(), env: { ...process.env, SNAPPER_GH_STUB_OUT: outFile } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "https://github.com/example/demo/issues/42");
  const rec = JSON.parse(await readFile(outFile, "utf8"));
  assert.deepEqual(rec.args, ["issue", "create", "--title", "Some title, with comma", "--body-file", body]);
  assert.equal(rec.body, "# hello body");
  await assert.rejects(runGh(gh, ["x", "100%"], {}), /cannot pass/);
});

test("issue --github: stub gh first on PATH, cwd = the game root, URL recorded in triage.json, status kept", { skip: !win }, async () => {
  const { root, dir } = await gameAndSession();
  const rec = join(await tmp(), "rec.json");
  const env = { PATH: `${GH_STUB_DIR}${delimiter}${process.env.PATH}`, SNAPPER_GH_STUB_OUT: rec };
  assert.equal((await snapperAsync(["triage", dir, "1", "open", "--by", "ann"])).status, 0);
  const r = await snapperAsync(["issue", dir, "1", "--github", "--title", 'Bad "title" 100% & more'], { env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "https://github.com/example/demo/issues/42");
  const got = JSON.parse(await readFile(rec, "utf8"));
  assert.deepEqual(got.args.slice(0, 3), ["issue", "create", "--title"]);
  assert.equal(got.args[3], "Bad title 100 more", "title sanitised for the cmd.exe path");
  assert.equal(got.args[4], "--body-file");
  assert.equal(got.args[5], join(dir, "marks", "0001", "issue.md"));
  assert.match(got.body, /^# Bad "title" 100% & more\n\n## What was seen/, "the file keeps the exact title");
  assert.match(got.body, /- shot: .*shot\.png/, "the body says shot: <path>");
  assert.equal(got.cwd.toLowerCase(), root.toLowerCase(), "gh runs in the game root");
  const tri = await readTriage(dir, "0001");
  assert.equal(tri.issue, "https://github.com/example/demo/issues/42");
  assert.equal(tri.status, "open");
  assert.equal(tri.by, "ann", "an existing triage keeps its author");
  assert.match(await readFile(join(dir, "SESSION.md"), "utf8"), /issue https:\/\/github\.com\/example\/demo\/issues\/42/);
  // an untriaged mark becomes "open"
  const r2 = await snapperAsync(["issue", dir, "2", "--github"], { env });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal((await readTriage(dir, "0002")).status, "open");
});

test("issue --github failures: gh missing or failing exit 1; no game root exits 2", { skip: !win }, async () => {
  const { dir } = await gameAndSession();
  // an empty folder, not tmpdir() itself: a stray gh.* there (gh.js with .JS in PATHEXT) resolves as gh
  const noGh = await snapperAsync(["issue", dir, "1", "--github"], { env: { PATH: await tmp() } });
  // (node itself is spawned by absolute path, so an empty PATH is fine)
  assert.equal(noGh.status, 1);
  assert.match(noGh.stderr, /gh \(the GitHub CLI\) is not on PATH/);
  const failing = await snapperAsync(["issue", dir, "1", "--github"], { env: { PATH: `${GH_STUB_DIR}${delimiter}${process.env.PATH}`, SNAPPER_GH_STUB_FAIL: "1" } });
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /gh issue create failed \(exit 1\)/);
  assert.equal(await readTriage(dir, "0001"), null, "a failure records nothing");
  const orphan = await makeSession(await tmp(), { gameRoot: join(tmpdir(), "no-such-game-root-xyz") });
  const r = await snapperAsync(["issue", orphan, "1", "--github"], { env: { PATH: `${GH_STUB_DIR}${delimiter}${process.env.PATH}` } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs the game root/);
});

// ---- Discord ----

function webhookServer() {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const form = await new Response(body, { headers: { "content-type": req.headers["content-type"] } }).formData().catch(() => null);
      calls.push({ method: req.method, url: req.url, form, type: req.headers["content-type"] });
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({
    calls, url: `http://127.0.0.1:${server.address().port}/api/webhooks/123456789/SECRETTOKENabcdef`, close: () => new Promise(r => server.close(r)),
  })));
}

test("discordContent stays under 2000 characters and keeps the title", () => {
  const long = "## What was seen\n\n" + "line\n".repeat(1000);
  const c = discordContent("T".repeat(10), long);
  assert.ok(c.length <= 1900 && c.startsWith("**TTTTTTTTTT**\n**What was seen**"));
  assert.ok(!discordContent("t", "## State\n\nx\n\n## First errors\n\n- e\n").includes("First errors"), "errors section dropped from the short body");
});

test("buildDiscordForm: payload_json + files[0] named shot.png with the exact bytes", async () => {
  const shot = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4, 250, 251]);
  const form = buildDiscordForm({ title: "T", body: "## S\n\nb", shot });
  const payload = JSON.parse(form.get("payload_json"));
  assert.ok(payload.content.includes("**T**"));
  assert.equal(payload.attachments[0].filename, "shot.png");
  const f = form.get("files[0]");
  assert.equal(f.name, "shot.png");
  assert.deepEqual(Buffer.from(await f.arrayBuffer()), shot);
  assert.equal(buildDiscordForm({ title: "T", body: "b", shot: null }).get("files[0]"), null);
});

test("discordPost posts multipart to a local server; failures are redacted", async () => {
  const srv = await webhookServer();
  try {
    const shot = Buffer.from("PNGDATA");
    await discordPost(srv.url, { title: "Title here", body: "## Body\n\ntext", shot });
    assert.equal(srv.calls.length, 1);
    const c = srv.calls[0];
    assert.equal(c.method, "POST");
    assert.match(c.type, /^multipart\/form-data; boundary=/);
    assert.ok(c.form.get("payload_json"));
    assert.equal(c.form.get("files[0]").name, "shot.png");
    assert.equal(Buffer.from(await c.form.get("files[0]").arrayBuffer()).toString(), "PNGDATA");
  } finally { await srv.close(); }
  await assert.rejects(discordPost(srv.url, { title: "t", body: "b", shot: null }), e => e.exitCode === 1 && !e.message.includes("SECRETTOKEN") && !e.message.includes("123456789"));
  await assert.rejects(discordPost("not a url", { title: "t", body: "b" }), e => e.exitCode === 2);
  await assert.rejects(discordPost("ftp://x/y", { title: "t", body: "b" }), e => e.exitCode === 2);
  assert.equal(redactUrl("POST https://d.example/api/webhooks/1234567/TOKENTOKEN failed; /api/webhooks/1234567/TOKENTOKEN", "https://d.example/api/webhooks/1234567/TOKENTOKEN"),
    "POST <webhook> failed; <webhook>");
});

test("issue --discord <url>: posts, prints no URL, and the URL is in no file of the session folder", async () => {
  const { dir } = await gameAndSession();
  const srv = await webhookServer();
  try {
    const r = await snapperAsync(["issue", dir, "1", "--discord", srv.url, "--title", "Discord title"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes("SECRETTOKEN") && !r.stderr.includes("SECRETTOKEN"));
    assert.match(r.stdout, /posted mark 0001 to the Discord webhook with shot\.png/);
    assert.equal(srv.calls.length, 1);
    const shot = await readFile(join(dir, "marks", "0001", "shot.png"));
    assert.deepEqual(Buffer.from(await srv.calls[0].form.get("files[0]").arrayBuffer()), shot);
    assert.match(JSON.parse(srv.calls[0].form.get("payload_json")).content, /^\*\*Discord title\*\*/);
    for (const f of await walk(dir)) {
      assert.ok(!(await readFile(f)).includes("SECRETTOKEN"), `${f} must not contain the webhook`);
      assert.ok(!(await readFile(f)).includes(String(new URL(srv.url).port) + "/api"), f);
    }
  } finally { await srv.close(); }
});

test("issue --discord with no URL reads discordWebhook from the game root's snapper.config.json; failure exits 1 and leaks nothing", async () => {
  const srv = await webhookServer();
  const { dir } = await gameAndSession({ discordWebhook: srv.url });
  try {
    const r = await snapperAsync(["issue", dir, "2", "--discord"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(srv.calls.length, 1);
  } finally { await srv.close(); }
  const dead = await snapperAsync(["issue", dir, "2", "--discord"]);
  assert.equal(dead.status, 1);
  assert.ok(!dead.stderr.includes("SECRETTOKEN") && !dead.stdout.includes("SECRETTOKEN"), dead.stderr);
  assert.match(dead.stderr, /Discord post failed/);
  const none = await gameAndSession({});
  const r3 = await snapperAsync(["issue", none.dir, "1", "--discord"]);
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /needs a webhook URL/);
});

test("list rows carry tester and the text row says `from <name>`", async () => {
  const { listSessions } = await import("../../packages/host/tools/list.mjs");
  const base = await tmp();
  const root = join(base, "g");
  await mkdir(root, { recursive: true });
  await makeSession(join(root, ".snapper", "sessions"), { tester: "Ann" });
  await makeSession(join(root, ".snapper", "sessions"), { id: "2026-10-17T09-00-00" });
  const { rows } = await listSessions(root);
  assert.deepEqual(rows.map(r => r.tester), ["Ann", null]);
  const r = await snapperAsync(["list", root]);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.match(lines[0], / from Ann /);
  assert.ok(!lines[1].includes(" from "));
  assert.equal(JSON.parse((await snapperAsync(["list", root, "--json"])).stdout)[0].tester, "Ann");
});

test("summary prints both paths; doctor <root> adds the integration line", async () => {
  const { dir, root } = await gameAndSession();
  const s = await snapperAsync(["summary", dir]);
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(s.stdout.trim().split(/\r?\n/), [join(dir, "SESSION.md"), join(dir, "SESSION.html")]);
  assert.ok(existsSync(join(dir, "SESSION.html")));
  const d = await snapperAsync(["doctor", root]);
  assert.match(d.stdout, /ok {5} {2}integration: no Snapper calls found in/);
  const plain = await snapperAsync(["doctor"]);
  assert.ok(!plain.stdout.includes("integration:"));
});
