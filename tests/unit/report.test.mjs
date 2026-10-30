// v1.4 SESSION.html (core report.mjs): structure, relative images, escaping, no script, no inline images.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, renderSessionHtml, writeReport, writeSummary, writeTriage, escapeHtml } from "../../packages/core/index.mjs";
import { makeSession } from "../fixtures/team.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "snapper-report-"));
const EVIL = `<script>alert("x")</script> & 'q' </details><img src=x onerror=1>`;

test("escapeHtml escapes & < > \" '", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(escapeHtml(null), "");
});

test("SESSION.html: header, marks table, per-mark images by relative path, replay command, no script, no data: images", async () => {
  const dir = await makeSession(await tmp());
  const html = renderSessionHtml(await readSession(dir));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Snapper session 2026-10-18T14-02-11 — demo-game @ 024e9ae\*/);
  for (const id of ["0001", "0002"]) {
    assert.ok(html.includes(`id="mark-${id}"`), `section ${id}`);
    assert.ok(html.includes(`href="#mark-${id}"`), `table link ${id}`);
  }
  assert.ok(html.includes('src="marks/0001/shot.png"'));
  assert.ok(html.includes('src="marks/0001/before/sheet.png"'));
  assert.ok(html.includes('src="marks/0001/frame.png"'));
  assert.ok(html.includes('src="marks/0002/shot.png"'));
  assert.ok(!html.includes('src="marks/0002/frame.png"'), "no frame.png in mark 0002");
  assert.ok(!/src="(?:[A-Za-z]:|\/|\\)/.test(html), "no absolute image path");
  assert.ok(!html.includes("data:"), "no inline/base64 image");
  assert.ok(!/<script/i.test(html), "no script tag");
  assert.ok(!/<link|@import|url\(|(?:src|href)="https?:/.test(html), "no external asset");
  assert.match(html, /<details><summary>State<\/summary><pre>[\s\S]*&quot;scene&quot;: &quot;stage&quot;/, "state in a details, pretty JSON");
  assert.ok(html.includes(`<code>snapper replay "${dir}" 0001</code>`), "replay command");
  assert.match(html, /Exception: TypeError: cannot read &#39;x&#39; of undefined/);
  assert.match(html, /at smashAhead \(src\/game\/stage\.js:412:18\)/);
  assert.match(html, /Triage: untriaged/);
});

test("SESSION.html: a note, state and triage note full of markup are escaped everywhere", async () => {
  const dir = await makeSession(await tmp());
  await appendFile(join(dir, "session.jsonl"), JSON.stringify({ kind: "note", t: 46000, mark: "0001", text: EVIL }) + "\n");
  await writeFile(join(dir, "marks", "0001", "state.json"), JSON.stringify({ scene: EVIL, deep: { k: EVIL } }));
  await writeTriage(dir, "0001", { status: "open", by: "<b>bob</b>", note: EVIL });
  const html = renderSessionHtml(await readSession(dir));
  assert.ok(!html.includes("<script"), "no raw <script> anywhere");
  assert.ok(!html.includes("<img src=x"), "no raw injected tag");
  assert.ok(!html.includes("<b>bob</b>"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;"), "escaped note text");
  assert.ok(html.includes("&lt;/details&gt;"));
});

test("SESSION.html: triage line and issue link (http only)", async () => {
  const dir = await makeSession(await tmp());
  await writeTriage(dir, "0001", { status: "fixed", by: "maxim", commit: "abc1234", note: "n", issue: "https://github.com/example/demo/issues/42" });
  let html = renderSessionHtml(await readSession(dir));
  assert.match(html, /Triage: fixed by maxim [\d-]+ · commit abc1234/);
  assert.ok(html.includes('<a href="https://github.com/example/demo/issues/42">'));
  assert.match(html, /Triage: 1 fixed · 1 untriaged/, "header counts");
  // a hand-edited non-http issue value is shown as text, never linked
  await writeFile(join(dir, "marks", "0001", "triage.json"), JSON.stringify({ status: "open", by: "x", at: new Date().toISOString(), issue: "javascript:alert(1)" }));
  html = renderSessionHtml(await readSession(dir));
  assert.ok(!html.includes('href="javascript:'));
});

test("SESSION.html: unsafe mark dir in session.jsonl falls back to marks/<id>", async () => {
  const dir = await makeSession(await tmp());
  const p = join(dir, "session.jsonl");
  await writeFile(p, (await readFile(p, "utf8")).replace('"dir":"marks/0001"', '"dir":"../../etc/\\"><x"'));
  const html = renderSessionHtml(await readSession(dir));
  assert.ok(!html.includes("etc/"));
});

test("writeReport / writeSummary write SESSION.html next to SESSION.md; session.jsonl untouched", async () => {
  const dir = await makeSession(await tmp());
  const before = await readFile(join(dir, "session.jsonl"), "utf8");
  const path = await writeReport(dir);
  assert.equal(path, join(dir, "SESSION.html"));
  assert.ok(existsSync(path) && !existsSync(join(dir, "SESSION.md")));
  const md = await writeSummary(dir);
  assert.match(md, /^# Snapper session/);
  assert.ok(existsSync(join(dir, "SESSION.md")) && existsSync(join(dir, "SESSION.html")));
  assert.equal(await readFile(join(dir, "session.jsonl"), "utf8"), before);
});

test("SessionWriter.renderReport writes SESSION.html", async () => {
  const { createSessionWriter } = await import("../../packages/core/index.mjs");
  const out = await tmp();
  const w = await createSessionWriter({ out, slug: "g" });
  w.line("session", { v: 1, id: w.id, game: "g" });
  w.line("end", { marks: 0, errors: 0, durationMs: 1 });
  await w.flush();
  await w.renderReport();
  await w.flush();
  const html = await readFile(join(w.dir, "SESSION.html"), "utf8");
  assert.match(html, /<h1>Snapper session /);
  assert.match(html, /No marks in this session/);
});
