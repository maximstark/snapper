// The shared capture pipeline (packages/host/main/capture.mjs) on a FAKE CDP backend and a fake page channel: proof that it
// talks to the CDP interface only (no webContents), that a mark goes through the hide ask + Page.captureScreenshot, that the
// perf host block carries adapter + hideRoundTripMs, that a --no-reload session's marks say replayable:false, and that a
// dropped connection ends the session cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionWriter, encodePng, parseJsonl, readSession, DEFAULT_CONFIG } from "../../packages/core/index.mjs";
import { fakeBackend } from "../../packages/host/main/cdp.mjs";
import { createCapture } from "../../packages/host/main/capture.mjs";
import { markLineExtrasFor, NO_RELOAD_REASON } from "../../packages/host/main/attach-util.mjs";

const PNG = encodePng(4, 4, Buffer.alloc(4 * 4 * 4, 200)).toString("base64");
const val = v => ({ result: { type: "string", value: v } });

function fakeCdp() {
  return fakeBackend({
    handlers: {
      "Page.captureScreenshot": () => ({ data: PNG }),
      "Runtime.evaluate": ({ expression }) => {
        if (expression.includes("__host.ready()")) return val(JSON.stringify({ sdk: true, state: true, frame: true, stepper: true, commands: [], version: "1.0.0", keymap: ["KeyD"], pauseParam: "paused" }));
        if (expression.includes("o.img=")) return val(JSON.stringify({ sdk: true, frame: 12, state: JSON.stringify({ frame: 12, player: { x: 1 } }), img: null }));
        if (expression.includes("o.state=s.__host.state()")) return val(JSON.stringify({ sdk: true, frame: 12, state: JSON.stringify({ frame: 12 }) }));
        if (expression.includes("snapper.frame()")) return val("12");
        return { result: { type: "number", value: 1 } };
      },
    },
  });
}

async function setup({ markLineExtras = null, bare = false } = {}) {
  const out = await mkdtemp(join(tmpdir(), "snapper-attach-cap-"));
  const writer = await createSessionWriter({ out, slug: "fake" });
  writer.line("session", { v: 1, id: writer.id, game: "fake", url: "http://x/", query: "", snapper: "1.4.0", startedAt: writer.startedAtIso }, 0);
  await writer.writeEnv({ format: 1, game: { slug: "fake", url: "http://x/", query: "" }, host: { adapter: "cdp", bare }, display: { hz: 60 }, window: { w: 10, h: 10 } });
  const cdp = fakeCdp();
  const sent = [];
  let capture;
  const page = {
    send(kind, data) {
      sent.push([kind, data]);
      if (kind === "ask") setTimeout(() => capture.onPage("reply", { id: data.id, out: data.what === "snap" ? { now: 1000, intervals: Array.from({ length: 30 }, () => 16.7), ends: [], pads: [] } : true }), 5);
      return true;
    },
  };
  const results = [];
  const composer = { warm() {}, destroy() {}, compose: async () => ({ frames: [], sheet: null, bad: [] }) };
  capture = createCapture({
    cdp, page, writer, config: { ...DEFAULT_CONFIG, bare }, composer, displayHz: 60, warn: () => {}, res: null, adapter: "cdp",
    baseUrl: "http://x/", query: "", writeResult: r => results.push(r), markLineExtras,
    hooks: { endSession: () => {} },
  });
  return { out, writer, cdp, capture, sent, results, done: () => rm(out, { recursive: true, force: true }) };
}

test("capture on a fake CDP: ready, a mark through the hide ask + Page.captureScreenshot, perf host block, files", async () => {
  const s = await setup();
  try {
    const { capture, cdp, writer } = s;
    capture.connect();
    capture.setLive(true);
    capture.nav.start("http://x/");
    capture.nav.finish();
    capture.onPage("sdk", { type: "register", payload: {} });
    await new Promise(r => setTimeout(r, 700));
    assert.equal(capture.host.readyLine?.stepper, true, "ready read through Runtime.evaluate");
    assert.ok(writer.lines.some(l => l.kind === "boot" && l.ok), "boot line");
    await capture.host.requestMark("api", { note: "hello" });
    const dir = join(writer.dir, "marks", "0001");
    for (const f of ["shot.png", "state.json", "inputs.json", "log.json", "perf.json", "note.txt"]) assert.ok(existsSync(join(dir, f)), f);
    const perf = JSON.parse(await readFile(join(dir, "perf.json"), "utf8"));
    assert.equal(perf.host.adapter, "cdp");
    assert.equal(typeof perf.host.hideRoundTripMs, "number");
    assert.ok(perf.host.hideRoundTripMs >= 4, "the hide ask round trip was measured around the page reply");
    assert.ok(perf.host.markCaptureMs["0001"] >= perf.host.hideRoundTripMs);
    assert.ok(perf.intervalsMs.length === 30);
    // order at a mark: hide ask -> Page.captureScreenshot -> show ask
    const methods = cdp.sent.map(c => c.method);
    assert.ok(methods.includes("Page.captureScreenshot"));
    const kinds = s.sent.filter(m => m[0] === "ask").map(m => m[1].what);
    assert.deepEqual(kinds.filter(k => k === "hide" || k === "show"), ["hide", "show"]);
    const mark = writer.lines.find(l => l.kind === "mark");
    assert.equal(mark.replayable, undefined, "a normal attach session does not mark lines unreplayable");
    // hotkey message from the page script runs the same action as the Electron hotkey
    capture.onPage("hotkey", { name: "mark" });
    await capture.host.idle();
    assert.equal(writer.lines.filter(l => l.kind === "mark").length, 2);
    const ok = await capture.finalize();
    assert.equal(ok, true);
    assert.equal(cdp.closed, true, "finalize detached the backend");
    assert.equal(writer.lines.at(-1).kind, "end");
    assert.ok(s.results.some(r => r.session === writer.dir && r.marks === 2));
    // everything the pipeline sent was a CDP method the attach design lists
    const allowed = new Set(["Page.captureScreenshot", "Runtime.evaluate", "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck"]);
    for (const m of new Set(methods)) assert.ok(allowed.has(m), `unexpected CDP method ${m}`);
  } finally { await s.done(); }
});

test("capture: --no-reload marks carry replayable:false + the reason; SESSION.md says so", async () => {
  const s = await setup({ markLineExtras: markLineExtrasFor({ reload: false, root: "C:/x", url: "http://x/" }) });
  try {
    const { capture, writer } = s;
    capture.connect();
    capture.setLive(true);
    capture.nav.adoptCurrent();
    await capture.host.requestMark("api", { note: "passive" });
    const mark = writer.lines.find(l => l.kind === "mark");
    assert.equal(mark.replayable, false);
    assert.equal(mark.replayableReason, NO_RELOAD_REASON);
    await capture.finalize();
    const md = await readFile(join(writer.dir, "SESSION.md"), "utf8");
    assert.match(md, /not replayable/);
    assert.match(md, /attached without a reload/);
  } finally { await s.done(); }
});

test("capture: a dropped connection ends the session cleanly (no exit checkpoint, end line, SESSION.md, result)", async () => {
  const s = await setup();
  try {
    const { capture, writer, cdp } = s;
    capture.connect();
    capture.setLive(true);
    capture.nav.start("http://x/");
    capture.nav.finish();
    cdp.close("socket closed (1006)");
    const ok = await capture.finalize();
    assert.equal(ok, true);
    assert.equal(writer.lines.at(-1).kind, "end");
    assert.ok(!writer.lines.some(l => l.kind === "checkpoint" && l.name === "exit"), "no exit state without a connection");
    assert.ok(existsSync(join(writer.dir, "SESSION.md")));
    assert.equal(s.results.at(-1).ok, true);
    const names = (await readdir(writer.dir)).sort();
    assert.ok(names.includes("env.json") && names.includes("session.jsonl") && names.includes("tape.jsonl"));
    const { lines } = parseJsonl(await readFile(join(writer.dir, "session.jsonl"), "utf8"));
    assert.equal(lines[0].kind, "session");
    assert.equal((await readSession(writer.dir)).end?.kind, "end");
  } finally { await s.done(); }
});

test("capture --bare: no before/ folder, no screencast request is the owner's call (startScreencast is never made by the pipeline itself)", async () => {
  const s = await setup({ bare: true });
  try {
    const { capture, writer, cdp } = s;
    capture.connect();
    capture.setLive(true);
    capture.nav.start("http://x/");
    capture.nav.finish();
    await capture.host.requestMark("api", { note: "bare" });
    assert.equal(existsSync(join(writer.dir, "marks", "0001", "before")), false);
    assert.ok(!cdp.sent.some(c => c.method === "Page.startScreencast"));
    const perf = JSON.parse(await readFile(join(writer.dir, "marks", "0001", "perf.json"), "utf8"));
    assert.equal(perf.host.bare, true);
    assert.equal(perf.host.ringFrames, 0);
    await capture.finalize();
    assert.ok(!cdp.sent.some(c => c.method === "Page.stopScreencast"), "bare: no screencast to stop");
  } finally { await s.done(); }
});
