// serveStatic: no-cache static serving, 404 outside the root, index.html for directories, and the coi option (v1.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic } from "../../packages/core/index.mjs";

const COI = ["cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy"];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "snapper-serve-"));
  const root = join(dir, "root");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "index.html"), "<h1>home</h1>");
  await writeFile(join(root, "sub", "index.html"), "<h1>sub</h1>");
  await writeFile(join(root, "a.js"), "export {}");
  await writeFile(join(dir, "secret.txt"), "outside");
  return { dir, root };
}

test("serveStatic without coi: content, no-cache headers, directory index, 404s, no isolation headers", async t => {
  const { dir, root } = await fixture();
  const srv = await serveStatic(root);
  t.after(async () => { await srv.close(); await rm(dir, { recursive: true, force: true }); });

  const home = await fetch(srv.url + "/");
  assert.equal(home.status, 200);
  assert.equal(await home.text(), "<h1>home</h1>");
  assert.match(home.headers.get("content-type"), /^text\/html/);
  assert.match(home.headers.get("cache-control"), /no-store/);
  assert.equal(home.headers.get("pragma"), "no-cache");
  assert.equal(home.headers.get("expires"), "0");

  assert.equal(await (await fetch(srv.url + "/sub/")).text(), "<h1>sub</h1>");
  assert.equal((await fetch(srv.url + "/a.js")).headers.get("content-type"), "text/javascript; charset=utf-8");

  const missing = await fetch(srv.url + "/nope.js");
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("cache-control"), /no-store/);
  assert.equal((await fetch(srv.url + "/..%2fsecret.txt")).status, 404, "a path outside the root is 404");

  for (const r of [home, missing]) for (const h of COI) assert.equal(r.headers.get(h), null, `${h} absent by default`);
});

test("serveStatic with coi: COOP/COEP/CORP on 200 and on both kinds of 404", async t => {
  const { dir, root } = await fixture();
  const srv = await serveStatic(root, { coi: true });
  t.after(async () => { await srv.close(); await rm(dir, { recursive: true, force: true }); });

  const ok = await fetch(srv.url + "/index.html");
  const missing = await fetch(srv.url + "/nope.js");
  const outside = await fetch(srv.url + "/..%2fsecret.txt");
  assert.equal(ok.status, 200);
  assert.equal(missing.status, 404);
  assert.equal(outside.status, 404);
  for (const r of [ok, missing, outside]) {
    assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(r.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
  }
  assert.match(ok.headers.get("cache-control"), /no-store/, "no-cache headers are unchanged under coi");
  assert.equal(await ok.text(), "<h1>home</h1>");

  const head = await fetch(srv.url + "/index.html", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cross-origin-embedder-policy"), "require-corp");
});

test("serveStatic: coi: false behaves as the default", async t => {
  const { dir, root } = await fixture();
  const srv = await serveStatic(root, { coi: false });
  t.after(async () => { await srv.close(); await rm(dir, { recursive: true, force: true }); });
  const r = await fetch(srv.url + "/");
  for (const h of COI) assert.equal(r.headers.get(h), null);
});
