# Snapper SDK, v1 — the `window.snapper` contract

One file, `packages/sdk/snapper.js`, no dependencies, no build step, no `export` statements (it must load as a classic injected script). It assigns `globalThis.snapper`. ESM consumers import `packages/sdk/index.mjs`, which loads it and re-exports the object. MIT.

Two ways it reaches a game:

1. **Injected by the host** (zero game changes). The host registers it with CDP `Page.addScriptToEvaluateOnNewDocument` so `window.snapper` exists before the game's first module runs, with `snapper.attached === true` and a bridge to the host.
2. **Imported by the game** for standalone use. `snapper.attached === false`; every call is a cheap no-op that keeps a small in-memory ring; `snapper.export()` returns it.

A game guards every call with optional chaining (`window.snapper?.tick(...)`) or binds once at boot to a no-op fallback. A game must behave identically with and without Snapper present.

## Invariants

- **Never throws into the game.** Every public method wraps its body; provider callbacks are called inside try/catch; a failing provider yields `{"error": "..."}`.
- **`tick(frame, mask)` allocates nothing at steady state.** Both arguments are small integers. The SDK stores the last mask in a plain number and appends to preallocated `Int32Array` rings only on change. Flushes to the host happen on a 250 ms timer, never inside `tick`.
- **State and frame providers are only called at marks, on explicit overlay refresh (≤ 2/s while the panel is open), and by the replay runner.** They are never called per frame.
- **No DOM, no timers, no listeners when `attached === false`** beyond the in-memory ring. Nothing to leak.
- **Size caps:** state output is serialised with a 256 KB cap; arrays longer than 1000 entries are truncated with `"_truncated": n`. Frame data URLs are passed through untouched.

## API

```js
snapper.version            // "1.0.0"
snapper.attached           // true under the host (or the replay runner)
snapper.frame()            // last ticked frame, or -1

snapper.registerState(fn)  // fn() → JSON-serialisable object. Cheap. Called at marks. Top-level scalars
                           // appear on SESSION.md's state line; a `perf` key is copied into perf.json gameStats.

snapper.registerFrame(fn)  // fn() → PNG data URL, or an HTMLCanvasElement (the SDK calls toDataURL on it).
                           // The game's internal frame (e.g. a 320×180 buffer), as opposed to the window shot.

snapper.registerStepper({  // declares deterministic stepping; makes marks replayable
  pause(), resume(),       // stop / start the game's own loop
  step(n, codes),          // advance exactly n fixed steps with `codes` (array of KeyboardEvent.code) held, then render once
  frame(),                 // current fixed-step frame number (same counter passed to tick)
  keymap,                  // string[]: bit i of a tick mask ⇔ keymap[i] held. ≤ 31 entries. Codes the stepper understands.
  pauseParam = "paused",   // URL query param the game honours by booting paused (required for replay)
  seed(), reset(seed)      // optional: report / re-seed the game's RNG
})

snapper.registerCommands({ // debug commands the overlay renders as buttons; invoked by id
  mute:   { label: "Mute",        run() {} },
  level:  { label: "Load level",  run(arg) {}, arg: "text" }   // optional one text argument
})

snapper.tick(frame, mask)      // once per fixed step, after input is resolved. Allocation-free.
snapper.tickKeys(frame, codes) // convenience for games without a mask; allocates on change only.

snapper.log(level, msg, data)  // level: "debug" | "info" | "warn" | "error". warn/error reach session.jsonl.
snapper.event(name, data)      // gameplay timeline: "level-start", "death", "checkpoint" …
snapper.mark(note, data)       // programmatic mark, trigger "api"; the note box does not open
snapper.assert(cond, msg, data)// returns cond; false → mark with trigger "assert" (cooldown 2 s per msg)
snapper.export()               // standalone mode: { logs, events, marks, tape } from the in-memory ring
```

`data` arguments must be JSON-serialisable; they are serialised at call time with the same caps. Keep them small; they are for Claude, not for telemetry.

## What the host calls (private surface, `snapper.__host`)

The host and the replay runner drive the SDK through CDP `Runtime.evaluate`; this surface is not for games.

```js
snapper.__host.ready()            // → { state, frame, stepper, commands: [ids], keymap, pauseParam, version }
snapper.__host.state()            // → JSON string (capped) or {"unavailable": true}
snapper.__host.frame()            // → data URL or null
snapper.__host.pause() / resume() / step(n, codes)
snapper.__host.command(id, arg)   // → return value, JSON-serialised
snapper.__host.flush()            // force a tape flush (used before a mark and by the runner)
```

## The bridge (host → SDK transport)

When injected, the preload exposes `window.__snapperBridge` (via `contextBridge`): `send(type, payload)` and `sendTape(frames, masks, count)`. The SDK uses them for `log`, `event`, `mark`, `assert`, `ready`, and the 250 ms tape flush. When the bridge is missing the SDK behaves as standalone. The replay runner provides a bridge that records nothing.

## Tape semantics

- `tick(frame, mask)`: if `mask !== lastMask` (or it is the first tick, or `frame < lastFrame`, which means a reset), append `(frame, mask)` to the rings. A reset also appends a `reload`-style marker so the runner knows frame numbers restarted.
- Frame numbers must be the game's fixed-step counter, not rAF frames, so a replay that calls `step` lands on the same numbers.
- The mask covers the keys the stepper's `step()` can set. A game with gamepad input maps each action to one representative key code in `keymap` so a live gamepad session replays through the keyboard path. Player 2 is out of scope for v1.

## Replayability rules (what a stepper-capable game must guarantee)

A mark is replayable only if the game is a pure function of (boot URL, fixed-step inputs). Concretely:

- **No wall-clock in the simulation.** RNG seeded from data, never from `Date.now()`; nothing in `update` reads `performance.now()`.
- **Level transitions do not depend on fetch timing.** A transition that skips updates while a file loads consumes a wall-clock-dependent number of frames live, and a headless `step(n)` batch never lets the fetch resolve at all. Prefetch the next level (or the whole world) when a stage starts, so the swap is synchronous, or navigate the page (Snapper records the new query per segment).
- **Page navigations are fine.** Each one starts a new tape segment with its own query; frame numbers restart.
- **`step(n, codes)` is synchronous** and renders once at the end. If a game cannot avoid asynchronous work mid-step, `step` may return a Promise; the host and runner await it, but the first two rules still apply.

## Integration recipe (what a game adds)

```js
// at boot, once:
const sn = globalThis.snapper;
if (sn) {
  sn.registerState(() => ({ scene: sceneName, level: level.id, frame: loop.frame, player: { x, y, vx, vy, pose }, perf: loop.stats }));
  sn.registerFrame(() => display.finalDataURL());
  sn.registerStepper({ pause: loop.stop, resume: loop.start, step: debug.step, frame: () => loop.frame, keymap: KEYMAP, pauseParam: "paused" });
}
const tick = sn ? sn.tick : () => {};
// in the fixed update, after input.update():
tick(loop.frame, maskOf(input));   // maskOf loops a fixed action list into an int; no allocation
```

Roughly 40 lines for a game that already has a debug stepper. The injected path needs none of the import plumbing.

## Versioning

`snapper.version` is semver. Adding methods is a minor bump. Changing `tick`, `registerStepper` or the tape semantics is a major bump, recorded in the release notes.
