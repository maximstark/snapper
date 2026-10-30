# Snapper session 2026-10-18T14-02-11 — skyhop @ 024e9ae* — 2026-10-18 14:02
http://127.0.0.1:51234/index.html?scene=stage&level=2-2 · ultrawide 3440×1440 fullscreen · 180 Hz · Chromium 146 · Generic USB Gamepad (Vendor: 1234 Product: 5678)
Boot ok in 812 ms · SDK: state ✓ frame ✓ stepper ✓ (replayable) · 12 m 04 s · errors 2 · marks 2
(* = working tree dirty when played)

| # | t | frame | trigger | summary | errors | worst ms |
|---|---|---|---|---|---|---|
| 0001 | 0:42.3 | 2538 | hotkey | pigeon clips through the ledge | 0 | 17.2 |
| 0002 | 1:10.0 | 4201 | exception | TypeError: cannot read 'x' of undefined (stage.js:412) | 1 | 16.9 |

## 0001 · 0:42.3 · frame 2538 · hotkey
Note: pigeon clips through the ledge
State: scene=stage level=2-2 player=(412.5,88) vel=(1.6,0) pose=glide hearts=3
Events before: 0:40.1 land · 0:41.0 jump · 0:41.8 glide
Errors: none
Files: shot.png · frame.png · before/sheet.png (48 frames, 4.7 s) · state.json · inputs.json · log.json · perf.json
Replay: snapper replay "<DIR>" 0001

## 0002 · 1:10.0 · frame 4201 · exception
State: error: boom
Events before: 0:40.1 land · 0:41.0 jump · 0:41.8 glide
Exception: TypeError: cannot read 'x' of undefined
    at smashAhead (src/game/stage.js:412:18)
    at update (src/game/stage.js:201:5)
    at step (src/core/loop.js:40:7)
Files: shot.png · state.json · inputs.json · log.json · perf.json
Replay: snapper replay "<DIR>" 0002
