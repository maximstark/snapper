// Builds the fixture session "session-a" into a folder. Mirrors the SESSION_FORMAT.md example.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePng } from "../../packages/core/index.mjs";

export const SESSION_A_LINES = [
  { kind: "session", t: 0, v: 1, id: "2026-10-18T14-02-11", game: "skyhop", url: "http://127.0.0.1:51234/index.html", query: "?scene=stage&level=2-2", snapper: "1.0.0", startedAt: "2026-10-18T14:02:11-07:00" },
  { kind: "boot", t: 812.4, ok: true, ms: 812 },
  { kind: "ready", t: 900, sdk: true, state: true, frame: true, stepper: true, commands: ["mute"] },
  { kind: "event", t: 40100, frame: 2400, name: "land" },
  { kind: "event", t: 41000, frame: 2454, name: "jump" },
  { kind: "event", t: 41800, frame: 2502, name: "glide" },
  { kind: "mystery-kind-from-the-future", t: 42000, foo: 1 },
  { kind: "mark", t: 42300, id: "0001", frame: 2538, trigger: "hotkey", dir: "marks/0001", summary: "hotkey", errors: 0, worstMs: 17.2 },
  { kind: "note", t: 45000, mark: "0001", text: "pigeon clips through the ledge" },
  { kind: "console", t: 60000, level: "error", text: "audio: decode failed" },
  { kind: "exception", t: 70000, text: "TypeError: cannot read 'x' of undefined",
    stack: "TypeError: cannot read 'x' of undefined\n    at smashAhead (src/game/stage.js:412:18)\n    at update (src/game/stage.js:201:5)\n    at step (src/core/loop.js:40:7)\n    at frame (src/core/loop.js:50:7)" },
  { kind: "mark", t: 70000, id: "0002", frame: 4201, trigger: "exception", dir: "marks/0002", summary: "TypeError: cannot read 'x' of undefined (stage.js:412)", errors: 1, worstMs: 16.9 },
  { kind: "end", t: 724000, marks: 2, errors: 2, durationMs: 724000 },
];

export const SESSION_A_ENV = {
  format: 1, snapper: "1.0.0", startedAt: "2026-10-18T14:02:11-07:00",
  game: { slug: "skyhop", root: "C:/games/skyhop", url: "http://127.0.0.1:51234/index.html", query: "?scene=stage&level=2-2",
    git: { sha: "024e9ae0123456789", branch: "main", dirty: true } },
  host: { adapter: "electron", electron: "44.9.0", chromium: "146.0.7600.10", node: "24.0.0", platform: "win32", arch: "x64", os: "Windows 11 10.0.26100" },
  display: { w: 3440, h: 1440, dpr: 1, hz: 180 },
  window: { preset: "ultrawide", w: 3440, h: 1440, fullscreen: true },
  gpu: "NVIDIA GeForce RTX 4060 (ANGLE D3D11)",
  gamepads: [{ index: 0, id: "Generic USB Gamepad (Vendor: 1234 Product: 5678)", mapping: "standard" }],
  sdk: { present: true, version: "1.0.0", state: true, frame: true, stepper: true, keymap: ["KeyA", "KeyD", "Space"], pauseParam: "paused", commands: ["mute"] },
  config: {},
};

const png = () => encodePng(2, 2, new Uint8Array(16).fill(200));

/** Write session-a into `dir`. `garbage` adds an unparsable line and a half-written last line. */
export async function buildSessionA(dir, { garbage = true } = {}) {
  await mkdir(join(dir, "marks", "0001", "before"), { recursive: true });
  await mkdir(join(dir, "marks", "0002"), { recursive: true });
  let jsonl = SESSION_A_LINES.map(l => JSON.stringify(l)).join("\n") + "\n";
  if (garbage) jsonl = jsonl.replace("\n", "\nthis is not json\n") + '{"kind":"mark","t":7';
  await writeFile(join(dir, "session.jsonl"), jsonl);
  await writeFile(join(dir, "env.json"), JSON.stringify(SESSION_A_ENV, null, 2));
  await writeFile(join(dir, "tape.jsonl"), [
    { kind: "tape", v: 1, keymap: ["KeyA", "KeyD", "Space"], pauseParam: "paused" },
    { f: 0, m: 0 }, { f: 100, m: 2 }, { f: 2500, m: 6 }, { f: 2540, m: 2 },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const m1 = join(dir, "marks", "0001");
  for (const f of ["shot.png", "frame.png"]) await writeFile(join(m1, f), png());
  await writeFile(join(m1, "before", "sheet.png"), png());
  await writeFile(join(m1, "before", "index.json"), JSON.stringify(
    Array.from({ length: 48 }, (_, i) => ({ file: `${String(i).padStart(2, "0")}.jpg`, t: 37600 + i * 100, frame: 2250 + i * 6 }))));
  await writeFile(join(m1, "state.json"), JSON.stringify({ scene: "stage", level: "2-2", player: { x: 412.5, y: 88 }, vel: [1.6, 0], pose: "glide", hearts: 3,
    perf: { fps: 180 }, entities: { a: 1, b: "x" } }));
  for (const f of ["inputs.json", "log.json", "perf.json"]) await writeFile(join(m1, f), "{}");
  await writeFile(join(m1, "note.txt"), "pigeon clips through the ledge\n");
  const m2 = join(dir, "marks", "0002");
  await writeFile(join(m2, "shot.png"), png());
  await writeFile(join(m2, "state.json"), JSON.stringify({ error: "boom" }));
  for (const f of ["inputs.json", "log.json", "perf.json"]) await writeFile(join(m2, f), "{}");
  return dir;
}
