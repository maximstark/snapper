# @snapper/sdk

`window.snapper`: the game-side half of Snapper, playtest capture for web games. One classic script (`snapper.js`), no dependencies, no build step. MIT.

Under the Snapper host it is injected before your game runs and talks to the host over a bridge. Without a host it is a set of cheap no-ops that keep a small in-memory ring; `snapper.export()` returns it. A game must behave identically with and without it, and the SDK never throws into the game.

The full contract is `docs/SDK.md` in the Snapper repo.

## Integration recipe

```js
// at boot, once:
const sn = globalThis.snapper;               // or: import snapper from "@snapper/sdk"
if (sn) {
  sn.registerState(() => ({ scene, frame, player: { x, y }, perf: { fps } }));  // volatile numbers go under `perf`
  sn.registerFrame(() => canvas);            // data URL, or a canvas (toDataURL is called)
  sn.registerStepper({
    pause, resume,                           // stop / start your own loop
    step: (n, codes) => {},                  // advance exactly n fixed steps with `codes` held, render once
    frame: () => frame,                      // same counter you pass to tick
    keymap: ["KeyA", "KeyD", "KeyW", "KeyS", "Space"],   // bit i of the tick mask = keymap[i] held (max 31)
    pauseParam: "paused",                    // ?paused boots your game paused
    seed: () => seed, reset: (s) => {},
  });
  sn.registerCommands({ reset: { label: "Reset", run() {} } });
}
const tick = sn ? sn.tick : () => {};
// in your fixed update, after input is resolved:
tick(frame, mask);                           // two small ints, allocation-free
```

Other calls: `snapper.log(level, msg, data)`, `event(name, data)`, `mark(note, data)`, `assert(cond, msg, data)`, `tickKeys(frame, codes)`, `frame()`, `attached`, `export()`.

`index.mjs` is an ESM wrapper: importing it runs `snapper.js` and re-exports `globalThis.snapper`.
