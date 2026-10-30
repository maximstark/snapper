# Snapper

Playtest capture for web games. Play your HTML/JS game, press **F8** when something looks wrong and type what you saw. Snapper saves the screen, the seconds before it, the game's state, your inputs, the console and the frame pacing into one plain-files report that you, your team or your AI coding agent (Claude Code, Cursor, Windsurf, Codex) can act on. If your game has a fixed-step loop, it replays the session to the exact frame of the mark, so a fix can be proven.

Windows, 64-bit. Free and open source under the [MIT licence](LICENSE). Get the ready-made installer on itch.io (pay what you want), or build it from this repo.

- `docs/SESSION_FORMAT.md` — the engine-neutral session folder
- `docs/SDK.md` — the `window.snapper` contract (about 10 lines in your game for state, about 40 for replay)
- `docs/TRUST.md` — everything Snapper does to a page, and what it costs
- `packages/sdk`, `packages/core`, `packages/host`, `packages/mcp`, `packages/skill` — the SDK, the shared logic, the Electron app, the MCP server, the Claude Code skill

## From source

```
npm install
npx snapper play examples/demo
npx snapper play <your game folder>
npx snapper replay <session-dir> 0001
npm test
```

Mark a moment with F8, or hold Back+Start on the gamepad (standard-mapping buttons 8 and 9, the small Select/View and Start/Menu buttons) for half a second. F9 cycles the overlay.

Save states: F6 saves one, and closing the window (or Ctrl+C) always saves `exit`. `npx snapper play <game> --resume last` replays that run to where you stopped and hands it back; `--at 0002`, `--at mark-0003` or `--at f12345` pick another point. The restore replays the tape on the current code, so it lands exactly only when the code has not changed (the toast says ✓ or DIFFERS).

## Executable (v1.2)

Snapper also builds as a self-contained Windows application: no Node, no repo, no browser download.

```
npm run dist        # dist/Snapper Setup <version>.exe (NSIS installer, per-user) and dist/Snapper-<version>-win.zip
npm run dist:dir    # dist/win-unpacked/ only (fast)
npm run launcher    # the launcher window from the repo (dev)
```

- `Snapper.exe` with no arguments opens the launcher: pick the game folder, preset, fullscreen and query, Play; the game's sessions are listed below with Resume, Replay, Open folder and SESSION.md. Each action shows the equivalent `snapper …` command.
- `snapper.cmd`, next to `Snapper.exe` (install dir, `dist/win-unpacked/`, or the unzipped folder), is the same CLI as `node bin/snapper.mjs`: `snapper.cmd replay "<session-dir>" 0001`, `snapper.cmd list <game-root>`, `snapper.cmd doctor` (`packaged yes`). This is the path for Claude.
- Replay runs on Electron's own Chromium, the same engine as the play window.
- The build is **unsigned** for now, so Windows SmartScreen says "Windows protected your PC" on first run: click **More info**, then **Run anyway**.

## The launcher (v1.3)

- **Demos** + **Try**: play a bundled example (the plain demo, Phaser, PixiJS, Three.js) with no game of your own. Its sessions go to `%APPDATA%\Snapper\demo-sessions\<slug>\`, never into the install folder, and show in the Sessions list.
- **Set up this game for Claude**: installs the snapper skill into `<game>\.claude\skills\snapper\` (nothing else is written into the game) and shows the SDK integration recipe with a Copy button.
- **Copy for Claude** on every session row (and on a replay result, with its mark): puts `Read "<session>\SESSION.md" and triage it with the snapper skill.` on the clipboard. Paste it into Claude Code in the game repo.
- **URL**: for a game served by its own dev server (Vite and friends), type the URL; Play runs `snapper play <url> --game-root <folder>`.
- **Capture settings** per game, passed as flags and never written into the game: mark hotkey (`--hotkeys mark=F4`), pad hold (`--padMarkHoldMs`), ring seconds (`--ringSeconds`), **Bare** (`--bare`). Reset returns to the game's own config.
- **Check**: runs `snapper check <game> --sessions 3` and shows one row per mark; a differing row has Accept (with a confirm line) for when the new behaviour is right.
- Mark pickers show the note: `0003 · 1:02.3 · hotkey · "jumped through the floor"`. Drop a folder on the window to pick it.

v1.4 adds to the launcher:

- **Set up for Claude** now looks at the game first. A game that already calls the SDK gets "This game already talks to Snapper: `src/dev/snapper.js` (registerState, registerFrame, registerStepper, tick). Nothing to paste." plus what its last session saw; any other game gets "Paste this into the file that starts your game loop" with the likely files, labelled as guesses. `snapper doctor <game>` prints the same finding.
- **Attach** row: endpoint (default `http://127.0.0.1:9222`), a page picker when several tabs are open, Attach / Detach (see Attach mode below).
- Drop a tester's **`.zip`** on the window to import it; its row says `from <tester>`.
- **Open report** per session (`SESSION.html`), **Copy issue** and a **status** select on a replay result; pickers show the status: `0003 · fixed · 1:02.3 · hotkey · "note"`.

## Regression check: `snapper check`

```
snapper check <game-root> [--sessions N | --session <dir>] [--marks 0001,0003] [--accept] [--query "?…"] [--out <dir>] [--json]
```

Replays every replayable mark of past sessions on the current code and compares the state at the mark with its expectation (`marks/NNNN/expected.json` once accepted, else the recorded `state.json`; top-level `perf` ignored). Rows are `match`, `differs $.path`, `skipped (reason)` or `error (message)`; `<game-root>\.snapper\checks\<timestamp>.json` keeps them. Exit 0 all match, 1 something differs or errored, 2 usage or refusal. `--accept` records the replayed states as the new expectations: only for marks whose new behaviour you confirmed. Every bug you ever marked becomes a regression test.

## Trust: `--bare` and `docs/TRUST.md`

`docs/TRUST.md` lists everything Snapper does to a page in each mode (what is injected, what is observed, the Chromium switches, the throwaway profile) and the measured overhead. `snapper play --bare` turns off everything continuous on the host side (the screencast ring buffer, the overlay chip, the F9 panel); the mark key, the note box, state, shots, the tape and replay keep working, and marks have no `before/` sheet. Every mark's `perf.json` has a `host` block and `SESSION.md` a `Host overhead:` line.

## Engines

Any HTML/JS game runs under Snapper with no changes (shots, the lead-up sheet, inputs, console, errors, frame pacing, notes, auto-marks); the SDK adds state and the game's own frame, and a fixed-step stepper adds replay, resume and `check` (`docs/SDK.md`). Tested demos, each played, marked and replayed by `scripts/verify-engines.mjs`: plain canvas (`examples/demo`), Phaser 4.2.1 (`examples/phaser`), PixiJS 8.22.0 (`examples/pixi`), Three.js 0.186.1 (`examples/three`); versions and sizes in `examples/VENDOR.md`.

- **Godot 4 web exports** need `SharedArrayBuffer`, so play them with `--coi` (or `"crossOriginIsolated": true` in `snapper.config.json`): the static server then sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. It is off by default because `require-corp` blocks cross-origin assets that lack CORP headers. Not yet tested with a real Godot export.
- **Unity WebGL**: expected to work, untested.

## MCP server

`snapper mcp` serves the sessions as MCP tools over stdio (`list_sessions`, `read_session`, `read_mark`, `mark_image`, `replay`, `check`; v1.4: `set_triage`, `issue_markdown`, `import_session`, `export_repro`) for Claude Code, Cursor, Windsurf or Codex. It is optional: the session files are the truth.

```
claude mcp add snapper -- "%LOCALAPPDATA%\Programs\Snapper\snapper.cmd" mcp
claude mcp add snapper -- node <repo>/packages/mcp/server.mjs --cli "node <repo>/bin/snapper.mjs"
```

`packages/mcp` is MIT with no dependencies; it speaks MCP 2026-07-28 (per-request metadata, `server/discover`) and the `initialize` handshake of 2025-11-25 and earlier.

## Attach mode (v1.4)

`snapper attach` captures a game running in a browser you started yourself (Chrome, Edge, or the game's own Electron or NW.js shell) instead of in Snapper's window. Same session folder, same skill.

1. Start the browser with remote debugging and a throwaway profile (Chrome 136+ and current Edge refuse remote debugging on your normal profile):
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\snapper-chrome
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\snapper-edge
   ```
   An Electron shell: `app.commandLine.appendSwitch("remote-debugging-port", "9222")` in its main process (or pass `--remote-debugging-port=9222` if the shell forwards it). NW.js: `--remote-debugging-port=9222`.
2. Open the game in a tab, then:
   ```
   snapper attach http://127.0.0.1:9222 --game-root <game folder>          # one tab open
   snapper attach http://127.0.0.1:9222 --target "my-game" --game-root …   # several tabs: a URL or title substring
   ```
   With several pages and no unique `--target`, it prints the list and exits 2. The launcher's **Attach** row does the same for the current game folder.
3. Play. F8 marks (the page must have focus: hotkeys are the page's own key events), F9 cycles the overlay. Closing the tab, Ctrl+C in the terminal, or the browser closing ends the session cleanly.

What it captures: the shot (`Page.captureScreenshot`, the page at its own size), the lead-up sheet, console and exceptions, frame pacing, keys and gamepads, notes; with the SDK registered also state, the game's frame and replay. By default Snapper **reloads the page once** after injecting, so the game boots with the SDK present and registers its state and stepper; the tape starts at that boot and marks are replayable when `--game-root` (or an http(s) URL `replay` can revisit) is known. `--no-reload` leaves the page as it is: passive capture only, no mark is replayable, and `SESSION.md` says so. Without `--game-root` sessions go to `%APPDATA%\Snapper\attach-sessions\<slug>\`. Snapper changes no flags in your browser; `docs/TRUST.md` ("Attach mode") lists what it injects. Firefox and Safari are not supported (no Chrome DevTools Protocol).

## Playtesters (v1.4)

Send a friend the game with a mark key, get a session back:

```
snapper pack <game folder> [--developer "Your Name"] [--bundle] [--url <u>] [--out <zip>]
```

writes `<slug>-playtest-<yyyymmdd>.zip`: `game/` (your folder minus `.git`, `node_modules`, `.snapper`, `.claude`, `dist` and any globs in a `.snapperignore`), `snapper.config.json` (your effective config, your name, the commit it was packed from), `PLAY.cmd` and `README-TESTER.txt`. `PLAY.cmd` runs an installed Snapper in **tester mode**; with `--bundle` the zip also carries Snapper itself (`dist/win-unpacked`, built with `npm run dist:dir`) so the tester installs nothing.

Tester mode (`snapper play --tester`): the first run asks the tester's name once; the chip says "F8 marks a moment"; the note box asks "What happened?"; on exit the session is zipped to `outbox/<slug>-<session id>.zip` next to `game/` and the folder opens with "Send this file to <you>". Nothing is uploaded: the tester sends the zip however they like.

```
snapper import <zip> --root <game folder>      # or drop the zip on the launcher
```

validates the zip, unpacks it into `<game>\.snapper\sessions\<slug>\<id>` (never over an existing id) and prints the Copy-for-Claude line. The session shows `from <tester>`; its replay serves your game folder.

## Reports, triage and issues (v1.4)

- **`SESSION.html`** next to `SESSION.md`: a static page (no script, images by relative path) with every mark's note, shot, lead-up sheet, frame, state, errors, replay command and status. Written at session end and by `snapper summary`; the launcher's **Open report** opens it. Zip the session folder and the page travels with it.
- **Triage**: `snapper triage <session> <mark> open|fixed|wontfix|duplicate|cannot-reproduce [--note "…"] [--by <name>] [--of <mark>] [--commit <sha>]` writes `marks/NNNN/triage.json`; `SESSION.md`, `SESSION.html`, `snapper check` and the launcher's pickers show it. The launcher's replay result has a status select.
- **Issues**: `snapper issue <session> <mark>` writes `marks/NNNN/issue.md` (title, what was seen, state, environment, errors, inputs, the replay and check commands, file paths) for pasting into any tracker; the launcher's **Copy issue** copies it. `--github` files it with `gh issue create` in the game repo (needs `gh` and a remote; GitHub's API cannot attach images, so the body names `shot.png`) and records the URL in `triage.json`. `--discord <webhook-url>` (or `discordWebhook` in `snapper.config.json`) posts the title, a summary and `shot.png`; the URL is never written into the session.

## No-Snapper repro (v1.4)

The strongest answer to "was it Snapper?":

```
snapper export-repro <session> <mark> --inject
snapper serve <session>\marks\<mark>\repro\repro-game
```

then open `http://127.0.0.1:<port>/index.html?paused&snapper-repro=1` (the folder's `README.md` has the exact URL) in Chrome, Edge or Firefox. The page holds the game, the SDK (so the game can register its stepper) and `driver.js` (MIT, `packages/sdk/repro-driver.js`), and no Snapper host: the driver feeds the recorded inputs through the game's own `step()` and prints `REPRO: match at frame N` or `REPRO: differs $.path (…)`. **match** means the game's own code produced the same state from the same inputs with nothing of Snapper watching; **differs** does not prove Snapper caused anything (an unseeded RNG or a wall-clock read also differs). Without `--inject`, `marks/NNNN/repro/` holds the files and the README's console method for any served copy of the game.

## Contributing

Issues and pull requests are welcome; see `CONTRIBUTING.md`. Snapper is maintained by one person, so there is no promised response time.

## Licence

MIT, everything in this repo. Third-party code keeps its own licence (`examples/*/vendor/`, listed in `examples/VENDOR.md`).
