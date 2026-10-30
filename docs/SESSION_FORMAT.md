# Snapper session format, v1

A session is a folder. Any adapter (the Electron host today, a Godot addon or a Swift package later) writes this format; the Claude-side skill and the replay runner only read it. The format is MIT and engine-neutral. A reader must ignore unknown keys and unknown `kind`s.

## Folder

```
<out>/<game-slug>/<session-id>/
  session.jsonl        append-only event stream (below)
  env.json             written once at start, patched once at `ready` (gamepads, SDK capabilities)
  tape.jsonl           append-only input tape (below)
  SESSION.md           derived summary, regenerated after every mark and at end
  marks/0001/          one folder per mark, 4-digit zero-padded sequential id
    shot.png           the window as the player saw it, native resolution, no overlay
    frame.png          the game's internal frame, only if the game registered a frame provider
    before/            the ring buffer: NN.jpg oldest-first, index.json [{file, t, frame}], sheet.png contact sheet
    state.json         the game's state provider output at the mark (or {"error": "..."} / {"unavailable": true})
    inputs.json        the last 10 s of input: {"wall": [...wall events], "frames": [...tape lines]}
    log.json           the last 200 console entries + SDK log entries, oldest first
    perf.json          frame pacing around the mark (below)
    note.txt           present only when a note was entered
    replay/            written by `snapper replay`, never by the host (below)
```

- `<session-id>` is the local start time, `YYYY-MM-DDTHH-mm-ss`.
- `<game-slug>` is `--slug`, else `snapper.config.json` `slug`, else the game root folder name, lower-cased, non-alphanumerics to `-`.
- Default `<out>` is `<game-root>/.snapper/sessions` (D-009). `--out` overrides.

## Time and frame

Every event carries `t`: milliseconds since session start, one decimal, stamped by the host on receipt. Events that originate in the SDK also carry `frame`: the game's last ticked fixed-step frame number (`-1` when the game does not tick). `frame` is the precise key when present; `t` is the fallback.

## session.jsonl

One JSON object per line. Common keys: `kind`, `t`. Lines by kind:

| kind | keys | when |
|---|---|---|
| `session` | `v:1, id, game, url, query, snapper (version), startedAt (ISO)` | first line |
| `boot` | `ok, ms, error?` | the page finished loading (or failed: `did-fail-load`, or an exception before `ready`) |
| `ready` | `sdk, state, frame, stepper, commands:[ids], sdkVersion?` | the SDK reported what the game registered (all false when no SDK) |
| `reload` | `query?, url?` | the page reloaded or navigated; frame numbers and the tape restart. `query` is the new document's `location.search` (`"?scene=stage&level=2-1"`), `url` its address (D-022) |
| `console` | `level ("error"\|"warn"), text, src?` | console errors and warnings only (all levels go to the mark's `log.json`) |
| `exception` | `text, stack?` | uncaught exception or unhandled rejection |
| `log` | `frame, level ("warn"\|"error"), msg, data?` | `snapper.log` at warn or above (lower levels only in `log.json`) |
| `event` | `frame, name, data?` | `snapper.event` |
| `mark` | `id, frame, trigger, dir, summary, errors, worstMs` | a mark was written (its folder is complete when this line exists) |
| `note` | `mark, text` | a note was entered for a mark |
| `fps` | `frame, worstMs, drops, expectedMs` | a pacing drop detected (also raises a mark with trigger `fps`, subject to cooldown) |
| `end` | `marks, errors, durationMs, activeMs?, idleMs?` | last line, on close (`activeMs`, `idleMs`: v1.4.1, below) |

`trigger` is one of `hotkey`, `gamepad`, `api`, `assert`, `error` (console.error), `exception`, `fps`, `boot`, `smoke`.
`summary` is a one-line human summary: the note if present, else the error text, else the trigger.

## env.json

```json
{
  "format": 1, "snapper": "1.0.0", "startedAt": "2026-10-18T14:02:11-07:00",
  "game": { "slug": "moonflexforceabilities-v3", "root": "C:/Coding/moonflexforceabilities-v3", "url": "http://127.0.0.1:51234/index.html", "query": "?scene=stage&level=2-2",
            "git": { "sha": "024e9ae…", "branch": "main", "dirty": true } },
  "host": { "adapter": "electron", "electron": "44.9.0", "chromium": "…", "node": "…", "platform": "win32", "arch": "x64", "os": "Windows 11 10.0.26300" },
  "display": { "w": 3440, "h": 1440, "dpr": 1, "hz": 180 },
  "window": { "preset": "ultrawide", "w": 3440, "h": 1440, "fullscreen": true },
  "gpu": "NVIDIA GeForce RTX 5070 Ti (ANGLE D3D11)",
  "gamepads": [ { "index": 0, "id": "Xbox Wireless Controller", "mapping": "standard" } ],
  "sdk": { "present": true, "version": "1.0.0", "state": true, "frame": true, "stepper": true, "keymap": ["KeyA","KeyD","KeyW","KeyS","Space","KeyK","KeyL"], "pauseParam": "paused", "commands": ["mute"] },
  "config": { "hotkeys": { "mark": "F8", "overlay": "F9", "pause": "F10", "step": "F7", "fullscreen": "F11" }, "padMark": [8, 9], "ringSeconds": 5, "fpsDropMs": 250, "fpsDropRun": 10 }
}
```

`git.dirty` is true when `git status --porcelain` is non-empty. Without `sha`, a reader must say so: it cannot know which code was played.

## tape.jsonl

First line: `{"kind":"tape","v":1,"keymap":[...codes],"pauseParam":"paused"}` (keymap and pauseParam empty when no stepper).

Then two kinds of line, which may coexist:

- **Frame lines** (from `snapper.tick`, run-length): `{"f":1234,"m":5}` means from frame 1234 the held mask is `m` until the next frame line. Bit `i` of `m` set means `keymap[i]` is held. A game that ticks always writes `{"f":0,"m":0}` first (or at its first tick).
- **Wall lines** (from the host's own key and gamepad recorder, for games without a stepper and for notes): `{"t":512.3,"k":"KeyD","d":1}` key down/up by `code`; `{"t":520.0,"p":0,"b":512,"ax":[0.0,-0.98]}` gamepad `p` buttons bitmask and axes on change.
- **Markers:** `{"f":0,"ev":"reload"}` after a page reload (the tape and frame numbers restart); `{"f":n,"ev":"seed","seed":…}` when the game reports a seed.

Replay uses frame lines from the last `reload` marker (or the start) before the mark's frame. Wall lines are evidence for Claude, not a replay source.

Additive (D-022, format stays 1): host-written `reload` markers (in `tape.jsonl` and in `session.jsonl`) also carry `query` (the new document's `location.search`, without the host's pause param) and `url`, e.g. `{"f":0,"ev":"reload","t":51234.5,"query":"?scene=stage&level=2-1","url":"http://127.0.0.1:5173/index.html?scene=stage&level=2-1"}`. A segment boots with its own `query` (the nearest marker at or before it that has one; a marker without one, as in sessions before 1.1.1 or an SDK reset, inherits the previous segment's), else `env.json` `game.query`; restore and replay use it.

Additive (D-012, format stays 1): host-written `reload` markers also carry `t`, e.g. `{"f":0,"ev":"reload","t":51234.5}`; a reader picks the segment whose marker `t` is the last at or before the mark's `t`, and falls back to the last segment when markers are unstamped.

## perf.json

```json
{ "expectedMs": 16.667, "displayHz": 180, "window": { "seconds": 10, "samples": 1800 },
  "intervalsMs": [16.7, 16.6, …], "p50": 16.7, "p95": 17.1, "max": 251.0,
  "drops": 1, "longTasks": [ { "t": 41200.5, "ms": 248 } ], "gameStats": { … } }
```

`intervalsMs` are consecutive rAF intervals measured in the page (the preload's isolated world, same event loop). `gameStats` is whatever the state provider returned under a `perf` key, if any. `drops` counts intervals above `2 × expectedMs`.

## marks/NNNN/replay/ (written by the runner)

```
replay/
  fNNNNNN.png        one per dumped frame (every --every frames across --before..--after)
  sheet.png          contact sheet of the dumped frames, labelled with frame numbers
  replay.json        { mark, frameAt, before, after, chromium, stateMatches, firstDiff?, frames: [{frame, state}] }
  replay.md          one-screen summary for Claude
```

`stateMatches` compares the state provider's output at the mark frame against the recorded `state.json`; `firstDiff` is the first differing JSON path. A false here means the replay is not trustworthy for that mark; the runner says so loudly.

## SESSION.md

Derived, compact, for Claude's first read. Regenerated by the host after each mark and by `snapper summary`. Template:

```
# Snapper session 2026-10-18T14-02-11 — moonflexforceabilities-v3 @ 024e9ae* — 2026-10-18 14:02
http://127.0.0.1:51234/index.html?scene=stage&level=2-2 · ultrawide 3440×1440 fullscreen · 180 Hz · Chromium 1xx · Xbox Wireless Controller
Boot ok in 812 ms · SDK: state ✓ frame ✓ stepper ✓ (replayable) · 12 m 04 s · errors 2 · marks 5
(* = working tree dirty when played)

| # | t | frame | trigger | summary | errors | worst ms |
|---|---|---|---|---|---|---|
| 0001 | 0:42.3 | 2538 | hotkey | swan clips through the sluice | 0 | 17.2 |
| 0002 | 1:10.0 | 4201 | exception | TypeError: cannot read 'x' of undefined (stage.js:412) | 1 | 16.9 |

## 0001 · 0:42.3 · frame 2538 · hotkey
Note: swan clips through the sluice
State: scene=stage level=2-2 player=(412.5,88.0) vel=(1.6,0) pose=glide hearts=3
Events before: 0:40.1 land · 0:41.0 jump · 0:41.8 glide
Errors: none
Files: shot.png · frame.png · before/sheet.png (48 frames, 4.8 s) · state.json · inputs.json · log.json · perf.json
Replay: snapper replay "<session dir>" 0001

## 0002 · …
Exception: TypeError: cannot read 'x' of undefined
    at smashAhead (src/game/stage.js:412:18)
    at update (src/game/stage.js:201:5)
```

Rules: the state line is the first-level scalars of `state.json`, truncated at 200 characters. At most the last five events before the mark. Stack traces at most three frames. Nothing else. The detail is in the files.

## checkpoints/ and resumed sessions (additive, D-021; format stays 1)

A checkpoint (save state) is a frame number plus the game's state there. Restoring it boots the game paused and replays the session's tape segment to that frame; the saved state is the proof that it landed. Readers that do not know these keys ignore them.

```
<session>/checkpoints/
  0001.json …    manual (host hotkey `save`, default F6; smoke step {"hotkey":"save"})
  mark-0003.json   one per mark: the mark's frame and state.json
  exit.json         written when the window closes, always (paused, mid-note, Ctrl+C in the terminal)
```

```json
{ "v": 1, "name": "0002", "kind": "manual", "trigger": "save", "frame": 12345, "t": 205871.4, "markId": "0003 (mark kind only)",
  "query": "?scene=stage&level=1-1", "segment": { "index": 0, "reloadT": null }, "restorable": true, "reason": "(only when false)",
  "state": { "…": "the state provider output, as state.json" } }
```

- `kind` is `manual` | `mark` | `exit`; `trigger` is `save` | `mark` | `exit`.
- `segment` names the tape segment the frame belongs to: `reloadT` is the `t` of the reload marker that starts it (`null` for the first), per D-012; `index` is its position.
- `restorable` is false when the game registered no stepper, had not ticked, or the tape has no frame lines. The file is still written.
- A reader treats `marks/NNNN/state.json` plus the `mark` line as an implicit `mark-NNNN` checkpoint when the file is absent (sessions recorded before v1.1): `frame` and `t` from the line, `query` from `env.json`, `segment` by the same D-012 rule. It is built in memory and never written to the old session.

New `session.jsonl` lines:

| kind | keys | when |
|---|---|---|
| `checkpoint` | `frame, name, trigger, markId?, restorable` | a checkpoint file was written |
| `resume` | `frame, from ("<session id>/<checkpoint>"), matched (true/false/null), firstDiff?, ms, fps, query, queryOverride?, error?` | a restore finished (or failed) |

A **resumed session** (`snapper play <game> --resume <session>|last [--at …]`) is an ordinary session plus:
- `session` line and `env.json`: `resumedFrom: { session: "<source id>", checkpoint, frame }` (`env.json` adds `dir`).
- `env.json` after the restore: `resumeMatched` (true/false; `null` when no saved state sat on that frame, e.g. `--at f<frame>`), `firstDiff` (path, when false), `restore: { frames, ms, fps, chunks, from, segment, query, querySource }`, `resumeError` on failure. `game.query` is the query the restore booted with (the segment's, D-022); `game.queryOverride: true` when `--query` forced it.
- `tape.jsonl`: the header, then the source segment's lines with `f <= frame` (frame lines, seed and earlier resume markers; wall lines are not copied), then `{"f":12345,"ev":"resume","from":"<source id>/<checkpoint>","t":…}`, then the live lines. The session is self-contained: a mark taken after the resume replays from boot. The `resume` marker is neither a frame line nor a reload, so segment selection and replay ignore it (continuity).
- `SESSION.md`: line 3 gains `states N (exit @ frame F)`; a line `resumed from <source id>/<checkpoint> @ frame N (matched|DIFFERS|not compared)` follows it.

## v1.3 additions: bare sessions, host overhead, accepted expectations (additive, D-027; format stays 1)

- **`env.json` `host.bare`** (`true`|`false`, written by every 1.3 host). `config.bare` and `config.crossOriginIsolated` are in `config` like the other keys. A bare session (`snapper play --bare`, or `snapper.config.json` `"bare": true`) ran without the screencast ring buffer, the overlay chip and the F9 panel: its marks have **no `before/` folder**. Everything else is written as usual. `SESSION.md` line 2 says `bare`.
- **`marks/NNNN/perf.json` `host`**: what the host was doing at that mark.
  ```json
  "host": { "bare": false, "ringFrames": 52, "ringFps": 10.2, "markCaptureMs": { "0001": 61.4, "0002": 58.0 } }
  ```
  `ringFrames` = screencast frames held in the ring at the mark (0 when bare); `ringFps` = captured ring frames per second over the ring window (0 when bare); `markCaptureMs` = for every mark of the session so far, this one included, the wall milliseconds from the trigger to the end of the synchronous capture (tape flush, overlay hidden, screenshot, overlay shown, the one state/frame evaluate). There is no ring capture cost: screencast frames are produced by the compositor and their cost to the page cannot be measured from the host. `SESSION.md` gets one `Host overhead:` line from these.
- **`marks/NNNN/expected.json`**, written only by `snapper check --accept` (never by the host): `{ "state": {…the replayed state…}, "frame": 2538, "acceptedAt": "<ISO>", "git": { "sha", "dirty" } | null, "host": "1.3.0" }`. When present, `snapper check` compares the replayed state with its `state` instead of `state.json` (the D-014 compare, top-level `perf` ignored). It is the only file v1.3 adds inside a mark folder; `session.jsonl` and `tape.jsonl` stay untouched.
- **`<game-root>/.snapper/checks/<timestamp>.json`** (or `<--out>/checks/`): the rows of a `snapper check` run, `{ v: 1, at, host, root, git, request, summary, rows }`. Outside the session folders.

## v1.4 additions: attach mode, playtesters, triage, issues, the repro, the report (additive, D-028; format stays 1)

- **`env.json` `host.adapter`**: `"electron"` (a play session: Snapper's own window) or `"cdp"` (an attach session: a page in the user's own Chromium, reached over a DevTools WebSocket). An attach session adds `host.attach = { endpoint, target: { url, title }, browser, userAgent, reloaded }` (`browser` is the browser's own product string, e.g. `Chrome/141.0.7390.55` or `Edg/155.0.4283.62`; `reloaded` is false with `--no-reload`), `gpu: null` (not readable over the protocol), and `display`/`window` from the page (`screen`, `devicePixelRatio`, `innerWidth`/`innerHeight`). `SESSION.md` line 2 says `attached to <browser>`.
- **`mark` lines** of an attach session started with `--no-reload` carry `replayable: false` and `replayableReason`: the game booted before Snapper was injected, so its tape does not start at its boot. `replay`, `check`, `export-repro` and the MCP refuse such marks; `SESSION.md` says `not replayable: attached without a reload`.
- **`perf.json` `host`** gains `adapter` (as above) and `hideRoundTripMs`: the wall milliseconds of this mark's overlay-hide round trip (play: the preload IPC; attach: the page binding), part of `markCaptureMs`.
- **`env.json` `tester`**: `{ name }` in a tester-mode session (`play --tester`, the playtester kit). `SESSION.md` line 2 says `tester: <name>`. The kit's `snapper.config.json` adds `developer`, `tester: true` and `pack: { sha, dirty, at, host }` (the developer's commit when the kit was packed), so they appear in `env.json` `config`.
- **`<session>/import.json`**, written by `snapper import`: `{ v: 1, importedAt, from: <zip file name>, root: <game root it was imported for> | null, tester: <name> | null }`. A replay serves `env.json` `game.root` when that folder exists, else this `root` (an imported session names the tester's folder).
- **`marks/NNNN/triage.json`**: `{ status: "open" | "fixed" | "wontfix" | "duplicate" | "cannot-reproduce", of?: "NNNN" (duplicate only), by, at (ISO), note?, issue? (an http(s) URL), commit? (a git sha) }`. Written by `snapper triage`, `snapper issue --github` (the `issue` URL), the MCP `set_triage` and the launcher's status select; rewritten whole (atomically) on each change: it is state, not evidence. `issue` carries over a status change; `note`, `commit` and `of` only while the status stays the same. `SESSION.md` gets a `Triage:` header line (counts per status, untriaged marks counted) and a `Triage:` line per triaged mark; the `check` table has a `status` column.
- **`marks/NNNN/issue.md`**, written by `snapper issue` (`--markdown`, the default): `# <title>` then the body (what was seen, the state's keys, the environment, the first errors, the held inputs, the replay and check commands, the file paths). The Discord webhook URL is never written into a session.
- **`marks/NNNN/repro/`**, written by `snapper export-repro`: `snapper-sdk.js` (the SDK as injected), `driver.js` (`packages/sdk/repro-driver.js`, MIT), `tape.json` (`{ v: 1, kind: "snapper-repro-tape", session, mark, markFrame, segment, query, querySource, pauseParam, keymap, seed, page, openQuery, frames: [{ f, m }] }`: the mark's segment up to its frame), `expected.json` (`{ v: 1, source: "expected.json" | "state.json", frame, state }`), `README.md`, and with `--inject` `repro-game/` (a copy of the game root with the SDK and driver tags inserted before the first module script of the session's page, and these files under `repro-game/repro/`).
- **`SESSION.html`**, next to `SESSION.md`, written at session end and by `snapper summary` (and after `triage`, `issue` and `import`): one static page (inline CSS, no script, images by relative path: `marks/NNNN/shot.png`, `before/sheet.png`, `frame.png`), every note and state string escaped. Derived like `SESSION.md`: regenerable at any time, never the source of truth.
- **`replay.json` and `check.json` rows** gain `diffs`: up to three differing JSON paths, depth-first in key order, next to `firstDiff` (which is `diffs[0]`). `replay.md` adds a `Differs at:` line; the check table prints `differs $.a, $.b, $.c`.

## v1.4.1 additions: played time (additive, D-030; format stays 1)

- **`end` line `activeMs` and `idleMs`**: the session's played time and the idle threshold it was measured with (`60000`). The session start counts as activity; so does every recorded key or pad change (the wall lines), every pointer event (`pointerdown`, `pointermove`, `wheel`; observed, never written to the tape) and every submitted note. Each gap between consecutive activities counts up to `idleMs`, and so does the tail from the last activity to the end, so a session left open and untouched counts at most `idleMs` of play. `durationMs` stays the wall time the session was open.
- **`SESSION.md` line 3** says `played <activeMs> of <durationMs>` (e.g. `played 1 m 18 s of 11 h 43 m 36 s`) in place of the duration when the idle time (`durationMs − activeMs`) is `idleMs` or more; otherwise, and for sessions without `activeMs` (before 1.4.1, or still live), the duration as before. `snapper list --json` rows gain `activeMs` (or `null`), and their `duration` text follows the same rule.

## Versioning

`format` bumps on any breaking change to the keys above. Readers accept older formats and say which they read.
