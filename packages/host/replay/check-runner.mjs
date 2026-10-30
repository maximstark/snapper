// Check runner (BRIEF-v1.3 §3): replays MANY marks of one session on one page driver and compares the state at each mark
// with its expectation. Engine-neutral like runner.mjs (no engine import; the driver is supplied by the caller).
//
// Where replayMark boots the game for every mark and dumps a window of frames, this boots the game ONCE per tape
// segment (with that segment's query, D-022), then steps forward from mark to mark (marks sorted by frame) with the
// same core stepTo the replay uses, and reads snapper.__host.state() at each mark frame. No PNGs, no sheet, nothing
// written into the session. It serves the GIVEN game root (the current code), not env.game.root.
import { readFile } from "node:fs/promises";
import { serveStatic, codesOf, stepExpression, stepTo, compareState, compareStateAll, chooseQuery } from "../../core/index.mjs";
import { buildUrl } from "./runner.mjs";
import { fileURLToPath } from "node:url";

const SDK_PATH = fileURLToPath(new URL("../../sdk/snapper.js", import.meta.url));
const READY_TIMEOUT_MS = 60000;
const CHUNK = 2000;

const msg = e => String((e && e.message) || e).split("\n")[0].slice(0, 300);

/**
 * Check the replayable items of one session. `driver` is created and closed by the caller.
 * sessionPlan: { dir, session, tape, items } (planCheck). opts: { root, query, log, onResult }.
 * onResult(item, outcome) is awaited for every item, in replay order; outcome is one of
 *   { result: "match", state } | { result: "differs", firstDiff, diffs (up to three paths, v1.4), state } | { result: "error", message }.
 * `state` is the replayed state at the mark frame (what --accept records).
 */
export async function checkSession(driver, sessionPlan, { root, query, log = () => {}, onResult = async () => {} } = {}) {
  const { session, tape, items } = sessionPlan;
  if (!items.length) return;
  const env = session.env || {};
  const keymap = tape.header?.keymap?.length ? tape.header.keymap : env.sdk?.keymap || [];
  const pauseParam = tape.header?.pauseParam || env.sdk?.pauseParam || "paused";
  const sdkSource = await readFile(SDK_PATH, "utf8");

  const bySeg = new Map();
  for (const it of items) {
    if (!bySeg.has(it.segIndex)) bySeg.set(it.segIndex, []);
    bySeg.get(it.segIndex).push(it);
  }

  let server = null;
  try {
    let serverUrl = null;
    if (String(env.game.url).startsWith("http://127.0.0.1:")) {
      server = await serveStatic(root, { coi: env.config?.crossOriginIsolated === true });   // as recorded (--coi, v1.3)
      serverUrl = server.url;
    }
    await driver.addInitScript(`globalThis.__snapperBridge = { send() {}, sendTape() {} };\n${sdkSource}`);

    for (const [segIndex, segItems] of [...bySeg.entries()].sort((a, b) => a[0] - b[0])) {
      segItems.sort((a, b) => a.frame - b.frame || a.ord - b.ord);
      const first = segItems[0];
      const frames = first.frames;                     // the segment's frame lines (planCheck: every item of a segment shares them)
      const q = chooseQuery({ override: query, lines: tape.lines, index: segIndex, envQuery: env.game?.query });
      const url = buildUrl(env, serverUrl, q.query, pauseParam);
      log(`${sessionPlan.id}: segment ${segIndex} (${segItems.length} marks) at ${url} (query from ${q.source})`);
      let failed = null;
      let last = -1;
      try {
        await driver.goto(url);
        try {
          await driver.waitForStepper(READY_TIMEOUT_MS);
        } catch {
          const pe = driver.pageErrors?.length ? `; page errors: ${driver.pageErrors.join(" | ")}` : "; no SDK, or the game never called registerStepper";
          throw new Error(`the game did not report a stepper within ${READY_TIMEOUT_MS / 1000} s at ${url}${pe}`);
        }
        await driver.evaluate("(()=>{globalThis.snapper.__host.pause();return true})()");
        last = await driver.evaluate("globalThis.snapper.frame()");
      } catch (e) {
        failed = msg(e);
      }
      for (const it of segItems) {
        if (failed) { await onResult(it, { result: "error", message: failed }); continue; }
        try {
          if (last > it.frame) throw new Error(`the game is already at frame ${last}, past the mark frame ${it.frame}`);
          if (last < it.frame) {
            const pos = await stepTo({
              frames, keymap, last, to: it.frame, chunk: CHUNK,
              stepRuns: runs => driver.evaluate(stepExpression(runs)),
            });
            last = pos.last;
            if (last !== it.frame) throw new Error(`the replay reached frame ${last}, not the mark frame ${it.frame}${pos.warnings.length ? ` (${pos.warnings[0]})` : ""}`);
          }
          const stateStr = await driver.evaluate("globalThis.snapper.__host.state()");
          let state;
          try { state = JSON.parse(stateStr); } catch { throw new Error("the state provider returned invalid JSON at the mark frame"); }
          const diff = compareState(it.expectation.state, state);
          await onResult(it, diff ? { result: "differs", firstDiff: diff.path, diffs: compareStateAll(it.expectation.state, state), state } : { result: "match", state });
        } catch (e) {
          // a broken position poisons the rest of the segment: report this mark, then try the next from wherever we are
          const m = msg(e);
          await onResult(it, { result: "error", message: m });
          try { last = await driver.evaluate("globalThis.snapper.frame()"); } catch { failed = m; }
        }
      }
    }
  } finally {
    if (server) await server.close().catch(() => {});
  }
}
