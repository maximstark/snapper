// v1.4 launcher: Attach settings per root, the attach command line, mark labels with triage status, the Set up for Claude
// dialog model, the differs text. All pure (settings.mjs), so they run in plain Node.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENDPOINT, attachFor, checkEndpoint, commandLine, diffsText, markLabel, mergeSettings, rememberAttach, rememberRoot, sdkSeenLine,
  setupModel, defaultSettings,
} from "../../packages/host/launcher/settings.mjs";

test("checkEndpoint: default, http and ws accepted, junk refused", () => {
  assert.deepEqual(checkEndpoint(""), { endpoint: DEFAULT_ENDPOINT });
  assert.equal(DEFAULT_ENDPOINT, "http://127.0.0.1:9222");
  assert.deepEqual(checkEndpoint(" http://localhost:9333/ "), { endpoint: "http://localhost:9333" });
  assert.deepEqual(checkEndpoint("ws://127.0.0.1:9222/devtools/page/AB"), { endpoint: "ws://127.0.0.1:9222/devtools/page/AB" });
  assert.match(checkEndpoint("9222").error, /not an endpoint/);
  assert.match(checkEndpoint("ftp://x").error, /http/);
  assert.match(checkEndpoint("http://a b").error, /spaces/);
});

test("attach endpoint and target are remembered per root (case-insensitive), survive JSON, ignore garbage", () => {
  let s = defaultSettings();
  assert.deepEqual(attachFor(s, "C:/g/a"), { endpoint: DEFAULT_ENDPOINT, target: "" });
  s = rememberAttach(s, "C:\\g\\A", { endpoint: "http://127.0.0.1:9333", target: "http://localhost:8080/index.html" });
  s = rememberAttach(s, "C:/g/b", { endpoint: "http://127.0.0.1:9444" });
  assert.deepEqual(attachFor(s, "c:/g/a/"), { endpoint: "http://127.0.0.1:9333", target: "http://localhost:8080/index.html" });
  assert.deepEqual(attachFor(s, "C:/g/b"), { endpoint: "http://127.0.0.1:9444", target: "" });
  // a partial update keeps the other field
  s = rememberAttach(s, "C:/G/A", { target: "x" });
  assert.deepEqual(attachFor(s, "C:/g/a"), { endpoint: "http://127.0.0.1:9333", target: "x" });
  assert.equal(Object.keys(s.attach).length, 2);
  assert.deepEqual(mergeSettings(JSON.parse(JSON.stringify(s))), s);
  // remembering a root's play fields leaves the attach map alone
  assert.deepEqual(attachFor(rememberRoot(s, "C:/g/a", { preset: "deck" }), "C:/g/a").endpoint, "http://127.0.0.1:9333");
  // garbage
  const g = mergeSettings({ attach: { "C:/x": { endpoint: "nonsense", target: 5 }, "C:/y": 7, "": { endpoint: "http://h:1" } } });
  assert.deepEqual(g.attach, { "C:/x": { endpoint: DEFAULT_ENDPOINT, target: "" } });
  assert.deepEqual(mergeSettings({ attach: [1] }).attach, {});
  // an old settings.json (no attach key) loads
  assert.deepEqual(mergeSettings({ v: 1, recent: ["C:/a"], lastRoot: "C:/a", perRoot: {}, bounds: null }).attach, {});
});

test("commandLine: attach", () => {
  assert.equal(commandLine("attach", { endpoint: "http://127.0.0.1:9222", root: "C:/g/demo" }), 'snapper attach http://127.0.0.1:9222 --game-root "C:/g/demo"');
  assert.equal(
    commandLine("attach", { endpoint: "http://127.0.0.1:9222", target: "http://localhost:8080/index.html", root: "C:\\g\\my game", flags: { hotkeys: "mark=F4", bare: true }, out: "C:/o/out" }),
    'snapper attach http://127.0.0.1:9222 --target "http://localhost:8080/index.html" --game-root "C:/g/my game" --hotkeys mark=F4 --bare --out "C:/o/out"');
  assert.equal(commandLine("attach", { root: "C:/g" }), 'snapper attach http://127.0.0.1:9222 --game-root "C:/g"');
});

test("markLabel with a triage status", () => {
  assert.equal(markLabel({ id: "0003", t: 62300, trigger: "hotkey", note: "jumped through the floor" }), '0003 · 1:02.3 · hotkey · "jumped through the floor"');
  assert.equal(markLabel({ id: "0003", status: "fixed", t: 62300, trigger: "hotkey", note: "jumped through the floor" }), '0003 · fixed · 1:02.3 · hotkey · "jumped through the floor"');
  assert.equal(markLabel({ id: "0004", status: "cannot-reproduce", t: 5000, trigger: "pad", summary: "pad hold" }), "0004 · cannot-reproduce · 0:05.0 · pad · pad hold");
  assert.equal(markLabel({ id: "0005", status: "", t: 1000, trigger: "" }), "0005 · 0:01.0");
});

test("setupModel: an integrated game says nothing to paste", () => {
  const m = setupModel({ found: [{ file: "src/dev/snapper.js", calls: ["registerState", "registerFrame", "registerStepper", "tick"] }], candidates: ["js/boot.js"] },
    { id: "2026-10-19T15-48-55", sdk: { present: true, state: true, frame: true, stepper: true } });
  assert.equal(m.integrated, true);
  assert.equal(m.headline, "This game already talks to Snapper: `src/dev/snapper.js` (registerState, registerFrame, registerStepper, tick). Nothing to paste.");
  assert.equal(m.seen, "Last session 2026-10-19T15-48-55: state ✓ frame ✓ stepper ✓ (replayable)");
  assert.deepEqual(m.candidates, []);
  // several files
  const two = setupModel({ found: [{ file: "a.js", calls: ["tick"] }, { file: "b/c.js", calls: ["registerState"] }], candidates: [] });
  assert.equal(two.headline, "This game already talks to Snapper: `a.js` (tick); `b/c.js` (registerState). Nothing to paste.");
  assert.equal(two.seen, "No session yet");
});

test("setupModel: a game that does not talk to Snapper gets the paste line and labelled guesses", () => {
  const m = setupModel({ found: [], candidates: ["js/boot.js", "js/loop.js"] }, null);
  assert.equal(m.integrated, false);
  assert.equal(m.headline, "Paste this into the file that starts your game loop");
  assert.equal(m.candidatesLine, "Likely files (guesses): js/boot.js, js/loop.js");
  assert.deepEqual(m.candidates, ["js/boot.js", "js/loop.js"]);
  assert.equal(m.seen, "No session yet");
  const none = setupModel({ found: [], candidates: [] });
  assert.equal(none.candidatesLine, "No guess: no requestAnimationFrame and no module script in index.html");
  // at most five guesses
  assert.equal(setupModel({ found: [], candidates: ["a", "b", "c", "d", "e", "f", "g"] }).candidates.length, 5);
  assert.deepEqual(setupModel(null).found, []);
});

test("sdkSeenLine", () => {
  assert.equal(sdkSeenLine(null), "No session yet");
  assert.equal(sdkSeenLine({ id: "S", sdk: { present: true, state: true, frame: false, stepper: false } }), "Last session S: state ✓ frame ✗ stepper ✗ (not replayable: no stepper)");
  assert.equal(sdkSeenLine({ id: "S", sdk: { present: false } }), "Last session S: the SDK was not seen");
});

test("diffsText: up to three paths, else firstDiff, else empty", () => {
  assert.equal(diffsText({ diffs: ["$.rng", "$.player.y", "$.score", "$.extra"], firstDiff: "$.rng" }), "$.rng, $.player.y, $.score");
  assert.equal(diffsText({ diffs: ["$.a"], firstDiff: "$.a" }), "$.a");
  assert.equal(diffsText({ diffs: [], firstDiff: "$.z" }), "$.z");
  assert.equal(diffsText({ firstDiff: "$.z" }), "$.z");
  assert.equal(diffsText({}), "");
});
