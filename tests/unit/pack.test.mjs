// v1.4 `snapper pack`: manifest, excludes, .snapperignore globs, config fields, PLAY.cmd both branches, refusals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readZip, readZipEntry, SNAPPER_VERSION } from "../../packages/core/index.mjs";
import { packKit, compileGlob, ignoreMatcher, playCmd, readmeTester } from "../../packages/host/tools/pack.mjs";
import { CLI, REPO } from "../fixtures/team.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "snapper-pack-"));
const put = async (root, rel, data = "x") => { const p = join(root, ...rel.split("/")); await mkdir(join(p, ".."), { recursive: true }); await writeFile(p, data); };
const names = async zip => (await readZip(zip)).map(e => e.name);
const text = async (zip, name) => (await readZipEntry(zip, name)).toString("utf8");

async function gameRoot() {
  const root = await tmp();
  await put(root, "index.html", "<html></html>");
  await put(root, "src/main.js", "export {}");
  await put(root, "art/raw/big.psd");
  await put(root, "art/final/a.png");
  await put(root, "art/final/b.psd");
  await put(root, "notes.tmp");
  await put(root, "deep/er/c.tmp");
  await put(root, "secret.txt");
  await put(root, "docs/secret.txt");
  await put(root, "node_modules/pkg/index.js");
  await put(root, "src/node_modules/inner/i.js");
  await put(root, ".git/HEAD");
  await put(root, ".snapper/sessions/g/s/session.jsonl");
  await put(root, ".claude/skills/x.md");
  await put(root, "dist/bundle.js");
  await put(root, "outbox/old-session.zip");
  await put(root, ".snapperignore", "# comments and blanks are skipped\n\n*.psd\nart/raw/\n**/*.tmp\n/secret.txt\n");
  await put(root, "snapper.config.json", JSON.stringify({ slug: "My Game", hotkeys: { mark: "F4" }, preset: "deck", out: "playtests", discordWebhook: "https://discord.example/api/webhooks/1/SECRETTOKEN" }));
  return root;
}

test("compileGlob / ignoreMatcher: * ** ? trailing slash, anchoring, comments", () => {
  const m = ignoreMatcher("*.psd\nart/raw/\n**/*.tmp\n/secret.txt\nlog?.txt\n# nope.txt\nbuild-*/\n");
  assert.equal(m("a.psd", false), true);
  assert.equal(m("deep/er/b.psd", false), true, "no slash: any depth");
  assert.equal(m("art/raw", true), true);
  assert.equal(m("art/raw", false), false, "trailing slash: folders only");
  assert.equal(m("x/art/raw", true), false, "with a slash: anchored at the root");
  assert.equal(m("a.tmp", false), true, "**/ matches zero folders");
  assert.equal(m("a/b/c.tmp", false), true);
  assert.equal(m("secret.txt", false), true);
  assert.equal(m("docs/secret.txt", false), false, "leading slash anchors");
  assert.equal(m("log1.txt", false), true);
  assert.equal(m("log12.txt", false), false);
  assert.equal(m("nope.txt", false), false);
  assert.equal(m("build-x", true), true);
  assert.equal(compileGlob("   "), null);
  assert.equal(compileGlob("# c"), null);
  assert.equal(m("a+b.psd", false), true);
  assert.equal(ignoreMatcher("a+b.js")("aab.js", false), false, "regex metacharacters are literal");
});

test("packKit: layout, excludes, .snapperignore, config fields, CRLF text files", async () => {
  const root = await gameRoot();
  const out = join(await tmp(), "kit.zip");
  const r = await packKit(root, { out, developer: "Maxim" });
  assert.equal(r.file, out);
  assert.equal(r.bundled, false);
  assert.equal(r.slug, "my-game");
  assert.ok(r.bytes > 0 && existsSync(out));
  assert.equal(r.entries, (await readZip(out)).length);
  const n = await names(out);
  assert.deepEqual([...n].sort(), [
    "PLAY.cmd", "README-TESTER.txt", "game/.snapperignore", "game/art/final/a.png", "game/docs/secret.txt", "game/index.html", "game/src/main.js", "snapper.config.json",
  ]);
  const cfg = JSON.parse(await text(out, "snapper.config.json"));
  assert.equal(cfg.slug, "my-game");
  assert.equal(cfg.preset, "deck");
  assert.equal(cfg.hotkeys.mark, "F4");
  assert.equal(cfg.hotkeys.overlay, "F9", "effective config: defaults merged");
  assert.equal(cfg.developer, "Maxim");
  assert.equal(cfg.tester, true);
  assert.equal(cfg.out, undefined, "the developer's out folder does not ship");
  assert.equal(cfg.discordWebhook, undefined, "a webhook never ships");
  assert.ok(!(await text(out, "snapper.config.json")).includes("SECRETTOKEN"));
  assert.equal(cfg.pack.host, SNAPPER_VERSION);
  assert.ok(!Number.isNaN(Date.parse(cfg.pack.at)));
  assert.ok("sha" in cfg.pack && "dirty" in cfg.pack);
  for (const f of ["PLAY.cmd", "README-TESTER.txt"]) {
    const t = await text(out, f);
    assert.ok(t.includes("\r\n") && !/[^\r]\n/.test(t), `${f} is CRLF`);
  }
});

test("packKit: pack.sha comes from the game's git (a repo subfolder here), null without git", async () => {
  const out = join(await tmp(), "demo.zip");
  await packKit(join(REPO, "examples", "demo"), { out, developer: "m" });
  const cfg = JSON.parse(await text(out, "snapper.config.json"));
  assert.match(cfg.pack.sha, /^[0-9a-f]{40}$/);
  assert.equal(typeof cfg.pack.dirty, "boolean");
  assert.equal(cfg.slug, "demo");
  const root = await tmp();
  await put(root, "index.html");
  const out2 = join(await tmp(), "x.zip");
  await packKit(root, { out: out2 });
  const cfg2 = JSON.parse(await text(out2, "snapper.config.json"));
  // (a temp folder is not in a git work tree)
  assert.equal(cfg2.pack.sha, null);
  assert.equal(cfg2.developer, userInfo().username, "developer defaults to the OS user");
});

test("packKit: default name <slug>-playtest-<yyyymmdd>.zip in the cwd; never zips the output into itself", async () => {
  const root = await tmp();
  await put(root, "index.html");
  const prev = process.cwd();
  process.chdir(root);                                       // the zip lands INSIDE the game root
  try {
    const r = await packKit(root, { developer: "d" });
    assert.match(r.file.split(/[\\/]/).pop(), /^[a-z0-9-]+-playtest-\d{8}\.zip$/);
    assert.ok(existsSync(r.file));
    assert.ok(!(await names(r.file)).some(x => x.includes("playtest")), "not inside itself");
    const again = await packKit(root, { developer: "d" });  // a second run, the first zip is in the root
    assert.ok(!(await names(again.file)).some(x => x.endsWith(".zip")), "an existing kit zip is not repacked... as the output");
  } finally { process.chdir(prev); }
});

test("PLAY.cmd: installed Snapper, or README; --url form; --bundle form", () => {
  const plain = playCmd();
  assert.ok(plain.includes(`set "SNAPPER=%LOCALAPPDATA%\\Programs\\Snapper\\snapper.cmd"`));
  assert.ok(plain.includes(`call "%SNAPPER%" play "%~dp0game" --tester --config "%~dp0snapper.config.json"`));
  assert.ok(plain.includes(`start "" notepad "%~dp0README-TESTER.txt"`), "not installed: opens the README");
  assert.ok(plain.indexOf("if not exist") < plain.indexOf("call "));
  const url = playCmd({ url: "http://localhost:5173/?level=2" });
  assert.ok(url.includes(`play http://localhost:5173/?level=2 --game-root "%~dp0game" --tester --config "%~dp0snapper.config.json"`));
  assert.ok(playCmd({ url: "http://h/a&b" }).includes(`play "http://h/a&b" --game-root`), "specials are quoted");
  assert.ok(playCmd({ url: "http://h/a%20b" }).includes("a%%20b"), "% doubled for cmd");
  const bundled = playCmd({ bundled: true });
  assert.ok(bundled.includes(`set "SNAPPER=%~dp0snapper\\snapper.cmd"`));
  assert.ok(bundled.includes(`play "%~dp0game" --tester`));
  assert.ok(!bundled.includes("LOCALAPPDATA") && !bundled.includes("notepad"));
});

test("README-TESTER.txt: what it is, install line (homepage or placeholder), PLAY.cmd, the mark key, outbox, nothing uploaded", () => {
  const t = readmeTester({ developer: "Maxim", slug: "my-game", markKey: "F4" });
  assert.match(t, /Download Snapper: \(link to come — ask Maxim\)/);
  assert.match(t, /PLAY\.cmd/);
  assert.match(t, /type your name once/i);
  assert.match(t, /press F4/);
  assert.match(t, /outbox/);
  assert.match(t, /send the \.zip file inside to Maxim/);
  assert.match(t, /Nothing is uploaded/);
  assert.match(readmeTester({ developer: "M", slug: "g", homepage: "https://snapper.example" }), /Download Snapper: https:\/\/snapper\.example/);
  const b = readmeTester({ developer: "M", slug: "g", bundled: true });
  assert.match(b, /Nothing to install/);
  assert.ok(!b.includes("Download Snapper"));
});

test("packKit refusals: no index.html needs --url; --bundle needs the player folder; bad root; bad url", async () => {
  const root = await tmp();
  await put(root, "game.js");
  const out = join(await tmp(), "k.zip");
  await assert.rejects(packKit(root, { out }), e => e.exitCode === 2 && /--url/.test(e.message));
  const ok = await packKit(root, { out, url: "http://localhost:5173/", developer: "d" });
  assert.ok(ok.entries >= 4);
  assert.ok((await text(out, "PLAY.cmd")).includes("play http://localhost:5173/ --game-root"));
  await put(root, "index.html");
  await assert.rejects(packKit(root, { out, bundle: true, bundleDir: join(root, "no-such-dist") }), e => e.exitCode === 2 && /--bundle needs/.test(e.message));
  await assert.rejects(packKit(join(root, "missing"), { out }), e => e.exitCode === 2 && /game root not found/.test(e.message));
  await assert.rejects(packKit(root, { out, url: 'http://x/"y' }), e => e.exitCode === 2);
});

test("packKit --bundle copies the player folder into snapper/ and PLAY.cmd runs it", async () => {
  const root = await tmp();
  await put(root, "index.html");
  const bundle = await tmp();
  await put(bundle, "Snapper.exe", "MZ");
  await put(bundle, "snapper.cmd", "@echo off\r\n");
  await put(bundle, "resources/app/x.js", "x");
  const out = join(await tmp(), "b.zip");
  const r = await packKit(root, { out, bundle: true, bundleDir: bundle, developer: "d" });
  assert.equal(r.bundled, true);
  const n = await names(out);
  for (const f of ["snapper/Snapper.exe", "snapper/snapper.cmd", "snapper/resources/app/x.js", "game/index.html"]) assert.ok(n.includes(f), f);
  assert.ok((await text(out, "PLAY.cmd")).includes(`"%SNAPPER%" play "%~dp0game"`));
  assert.ok((await text(out, "PLAY.cmd")).includes(`%~dp0snapper\\snapper.cmd`));
  assert.match(await text(out, "README-TESTER.txt"), /Nothing to install/);
});

test("CLI pack: prints the zip path; exit 2 on usage and refusals", async () => {
  const root = await tmp();
  await put(root, "index.html");
  const out = join(await tmp(), "cli.zip");
  const r = spawnSync(process.execPath, [CLI, "pack", root, "--out", out, "--developer", "Max"], { encoding: "utf8", cwd: REPO });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), out);
  assert.equal(JSON.parse(await text(out, "snapper.config.json")).developer, "Max");
  assert.equal(spawnSync(process.execPath, [CLI, "pack"], { encoding: "utf8", cwd: REPO }).status, 2);
  const bare = await tmp();
  const r2 = spawnSync(process.execPath, [CLI, "pack", bare, "--out", join(bare, "x.zip")], { encoding: "utf8", cwd: REPO });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /needs --url/);
});
