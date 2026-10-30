# Vendored engine builds

The engine demos (`examples/phaser`, `examples/pixi`, `examples/three`) load their engine from a copy of its
published browser build in `examples/<engine>/vendor/`, so there is no build step, no bundler and no network at run
time. Each copy sits next to the package's own LICENSE file. Only the files listed here are copied; nothing is
modified. Versions are pinned exact. Each file is under 2 MB.

| Engine | Version | Package | Loaded as | Licence |
|---|---|---|---|---|
| Phaser | 4.2.1 | `phaser` | classic script, global `Phaser` | MIT (Richard Davey, Phaser Studio Inc.) |
| PixiJS | 8.22.0 | `pixi.js` | classic script, global `PIXI` | MIT (Mathew Groves, Chad Engler) |
| Three.js | 0.186.1 (revision r186) | `three` | ES module, `import * as THREE from "./vendor/three.module.js"` | MIT (three.js authors) |

## Files

| Path | Bytes | Copied from the package |
|---|---|---|
| `examples/phaser/vendor/phaser.min.js` | 1,375,976 | `dist/phaser.min.js` (the UMD minified build) |
| `examples/phaser/vendor/LICENSE.md` | 1,120 | `LICENSE.md` |
| `examples/pixi/vendor/pixi.min.js` | 840,663 | `dist/pixi.min.js` (the IIFE minified build, global `PIXI`) |
| `examples/pixi/vendor/LICENSE` | 1,092 | `LICENSE` |
| `examples/three/vendor/three.module.js` | 662,772 | `build/three.module.js` |
| `examples/three/vendor/three.core.js` | 1,458,113 | `build/three.core.js` (imported by `three.module.js` as `./three.core.js`; both files are needed) |
| `examples/three/vendor/LICENSE` | 1,081 | `LICENSE` |

Three.js 0.186.1 ships no minified build: `three.module.js` + `three.core.js` are its own unminified ESM
files (about 2.1 MB together, each under 2 MB). `pixi.min.js` ends with a `sourceMappingURL` comment; the map is not
vendored, which only matters when DevTools is open.

## Fetch and update

Run in a scratch folder under `%TEMP%`, never inside the repo:

```
npm pack phaser@4.2.1
npm pack pixi.js@8.22.0
npm pack three@0.186.1
```

Extract each `.tgz` (`tar -xzf <file>`; the content is under `package/`), copy only the files in the table above
(replacing the old ones), then update this file (version, command, byte sizes) and run `node scripts/verify-engines.mjs`
(gate Y3: every demo plays, marks and replays with `stateMatches: true`; it also records the sizes). To move to a new
version, change the exact version in the `npm pack` command, check that the build is still a plain script or ESM
(no bundler), and re-run the gate. The demos' own code (`core.js`, `game.js`, `index.html`, `smoke.json`) is MIT under
each demo folder's `LICENSE`; `core.js` is identical in the three folders.
