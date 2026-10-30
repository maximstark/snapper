// `snapper attach`: option resolution (cli-attach.mjs buildAttachOptions) against a local /json/list server, the pure
// helpers of the attach host (attach-util.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildAttachOptions, slugFromUrl, normalizeEndpoint, userDataDir } from "../../packages/host/main/cli-attach.mjs";
import { chromiumOf, splitPageUrl, markLineExtrasFor, hzFromIntervals, NO_RELOAD_REASON, NO_ROOT_REASON } from "../../packages/host/main/attach-util.mjs";
import { parseArgs } from "../../packages/host/bin/snapper.mjs";

const DEMO = resolve("examples/demo");

function devtools(pages) {
  const http = createServer((req, res) => {
    if (req.url === "/json/list") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(pages.map((p, i) => ({ id: `ID${i}`, type: "page", title: p.title, url: p.url, webSocketDebuggerUrl: `ws://127.0.0.1:${http.address().port}/devtools/page/ID${i}` }))));
    } else { res.statusCode = 404; res.end(); }
  });
  return new Promise(res => http.listen(0, "127.0.0.1", () => res({ endpoint: `http://127.0.0.1:${http.address().port}`, port: http.address().port, close: () => new Promise(r => http.close(() => r())) })));
}
const args = line => parseArgs(line.split(" ").filter(Boolean));

test("buildAttachOptions: one page, --game-root → sessions under <root>/.snapper/sessions, config from the game, reload by default", async () => {
  const srv = await devtools([{ title: "Demo", url: "http://127.0.0.1:5000/index.html?level=2" }]);
  try {
    const a = args(`${srv.endpoint} --game-root ${DEMO}`);
    const o = await buildAttachOptions(a);
    assert.equal(o.wsUrl, `ws://127.0.0.1:${srv.port}/devtools/page/ID0`);
    assert.deepEqual(o.target, { id: "ID0", url: "http://127.0.0.1:5000/index.html?level=2", title: "Demo" });
    assert.equal(o.root, DEMO);
    assert.equal(o.slug, "demo");
    assert.equal(o.out, join(DEMO, ".snapper", "sessions"));
    assert.equal(o.reload, true);
    assert.equal(o.smoke, null);
    assert.equal(o.config.preset, "1080p");
    assert.deepEqual(o.config.hotkeys.mark, "F8");
    assert.equal(o.endpoint, srv.endpoint);
    const p = await buildAttachOptions(args(`${srv.endpoint} --game-root ${DEMO} --no-reload --bare --slug mine --hotkeys mark=F9 --out ${join(tmpdir(), "x")}`));
    assert.equal(p.reload, false);
    assert.equal(p.config.bare, true);
    assert.equal(p.slug, "mine");
    assert.equal(p.config.hotkeys.mark, "F9");
    assert.equal(p.out, join(tmpdir(), "x"));
  } finally { await srv.close(); }
});

test("buildAttachOptions: no --game-root → <userData>/attach-sessions, slug from the page's host and path", async () => {
  const srv = await devtools([{ title: "Game", url: "https://play.example.com/games/moon/index.html" }]);
  const was = process.env.SNAPPER_USER_DATA;
  process.env.SNAPPER_USER_DATA = join(tmpdir(), "snapper-ud-test");
  try {
    const o = await buildAttachOptions(args(srv.endpoint));
    assert.equal(o.root, null);
    assert.equal(o.slug, "play-example-com-games-moon");
    assert.equal(o.out, join(tmpdir(), "snapper-ud-test", "attach-sessions"));
    assert.equal(userDataDir(), resolve(tmpdir(), "snapper-ud-test"));
  } finally {
    if (was === undefined) delete process.env.SNAPPER_USER_DATA; else process.env.SNAPPER_USER_DATA = was;
    await srv.close();
  }
});

test("buildAttachOptions: several pages need --target; ambiguity carries the list and exit code 2", async () => {
  const srv = await devtools([{ title: "Game", url: "http://localhost:5173/" }, { title: "Docs", url: "http://localhost:3000/docs" }]);
  try {
    await assert.rejects(buildAttachOptions(args(srv.endpoint)), e => {
      assert.match(e.message, /2 pages are open/);
      assert.equal(e.exitCode, 2);
      assert.deepEqual(e.targets.map(t => t.id), ["ID0", "ID1"]);
      assert.deepEqual(Object.keys(e.targets[0]).sort(), ["id", "title", "url"]);
      return true;
    });
    const o = await buildAttachOptions(args(`${srv.endpoint} --target docs`));
    assert.equal(o.target.id, "ID1");
    await assert.rejects(buildAttachOptions(args(`${srv.endpoint} --target nothing`)), e => e.exitCode === 2 && /matches no page/.test(e.message));
    // a ws:// URL is used as is (the page's url and title are looked up best-effort for the slug)
    const ws = `ws://127.0.0.1:${srv.port}/devtools/page/ID0`;
    const w = await buildAttachOptions({ positional: [ws], flags: {} });
    assert.equal(w.wsUrl, ws);
    assert.equal(w.target.url, "http://localhost:5173/");
    assert.equal(w.slug, "localhost");
  } finally { await srv.close(); }
});

test("buildAttachOptions: refusals are user-facing errors", async () => {
  await assert.rejects(buildAttachOptions({ positional: [], flags: {} }), /missing the debugging endpoint/);
  await assert.rejects(buildAttachOptions(args("http://127.0.0.1:1")), /cannot reach .*remote-debugging-port/);
  const srv = await devtools([{ title: "G", url: "http://localhost/" }]);
  try {
    await assert.rejects(buildAttachOptions(args(`${srv.endpoint} --game-root C:/definitely/not/here`)), /not a directory/);
    await assert.rejects(buildAttachOptions(args(`${srv.endpoint} --hotkeys mark`)), /--hotkeys/);
    await assert.rejects(buildAttachOptions(args(`${srv.endpoint} --smoke C:/nope/smoke.json`)), /smoke script not found/);
  } finally { await srv.close(); }
});

test("endpoint and slug spellings", () => {
  assert.equal(normalizeEndpoint("127.0.0.1:9222"), "http://127.0.0.1:9222");
  assert.equal(normalizeEndpoint("localhost:9222"), "http://localhost:9222");
  assert.equal(normalizeEndpoint("http://h:1"), "http://h:1");
  assert.equal(normalizeEndpoint("ws://h:1/devtools/page/x"), "ws://h:1/devtools/page/x");
  assert.equal(slugFromUrl("http://localhost:5173/"), "localhost");
  assert.equal(slugFromUrl("http://localhost:5173/play/index.html"), "localhost-play");
  assert.equal(slugFromUrl("file:///C:/games/moon/index.html"), "games-moon");
  assert.equal(slugFromUrl("nonsense"), "page");
});

test("attach-util: chromium version, page url split, replayability, refresh rate", () => {
  assert.equal(chromiumOf("Chrome/141.0.7390.55"), "141.0.7390.55");
  assert.equal(chromiumOf("HeadlessChrome/152.0.1.2"), "152.0.1.2");
  assert.equal(chromiumOf(null), null);
  assert.deepEqual(splitPageUrl("http://localhost:5173/play/index.html?level=2&paused#top"), { url: "http://localhost:5173/play/index.html", query: "?level=2" });
  assert.deepEqual(splitPageUrl("http://h/?paused"), { url: "http://h/", query: "" });
  assert.deepEqual(splitPageUrl("file:///C:/g/index.html?x=1"), { url: "file:///C:/g/index.html", query: "?x=1" });
  assert.deepEqual(splitPageUrl("not a url"), { url: "not a url", query: "" });
  assert.equal(markLineExtrasFor({ reload: true, root: "C:/g", url: "http://h/" }), null);
  assert.equal(markLineExtrasFor({ reload: true, root: null, url: "https://h/" }), null);
  assert.deepEqual(markLineExtrasFor({ reload: false, root: "C:/g", url: "http://h/" }), { replayable: false, replayableReason: NO_RELOAD_REASON });
  assert.deepEqual(markLineExtrasFor({ reload: true, root: null, url: "file:///C:/g/index.html" }), { replayable: false, replayableReason: NO_ROOT_REASON });
  assert.match(NO_RELOAD_REASON, /^attached without a reload: the game booted before Snapper was injected$/);
  assert.equal(hzFromIntervals(Array.from({ length: 40 }, (_, i) => (i % 5 ? 16.7 : 33.4))), 60);
  assert.equal(hzFromIntervals(Array.from({ length: 40 }, () => 5.5)), 182);
  assert.equal(hzFromIntervals([16, 16]), null);
});
