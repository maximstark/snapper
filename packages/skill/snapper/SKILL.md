---
name: snapper
description: Triage a Snapper playtest session: read SESSION.md, inspect marks at full resolution, replay deterministic marks, fix with a repro.
---

# Snapper: triage a playtest session

A human played the game under Snapper and marked moments that felt wrong (or the host marked errors by itself). Each mark is a folder of evidence. Your job: understand each mark, reproduce it, fix it, prove the fix. Work from files, not guesses.

## 1. Find the session

- Sessions live in `<game-root>/.snapper/sessions/<slug>/<session-id>/`. The newest folder (ids are timestamps, `2026-10-18T14-02-11`) is the one to triage, unless Maxim gives a path.
- `snapper list <game-root>` lists them newest first (id, marks, errors, duration, `(live)` if still running; `played X of Y` when the window sat idle a minute or more: only X was played, so automatic marks may have fired with nobody watching). Without the CLI on PATH: `node C:/Coding/Snapper/bin/snapper.mjs list <game-root>`.
- Replay and the other commands below use the same `snapper` entry point.
- When Snapper is installed as an application (v1.2), `"<install dir>\snapper.cmd"` is the same CLI as `node C:/Coding/Snapper/bin/snapper.mjs` (e.g. `"%LOCALAPPDATA%\Programs\Snapper\snapper.cmd" list <game-root>`); it needs no Node and no repo.
- Optional (v1.3): an MCP server, `snapper mcp` (`claude mcp add snapper -- "%LOCALAPPDATA%\Programs\Snapper\snapper.cmd" mcp`), offers the same reads as tools (`list_sessions`, `read_session`, `read_mark`, `mark_image`, `replay`, `check`; v1.4: `set_triage`, `issue_markdown`, `import_session`, `export_repro`). It is a convenience: the files in the session folder are the truth, and everything below works without it.

## 2. Read SESSION.md first, and nothing else

`SESSION.md` is the whole session on one screen: header (sha, `*` = dirty tree, window, boot, SDK capabilities, errors, marks), a table of marks, and a block per mark with the note, a state line, the events before it, errors and the files it holds. Read it before opening any other file. If it looks stale, run `snapper summary <session-dir>` to regenerate it.

## 3. Choose the order

Default order: exceptions, then boot failures, then human marks (`hotkey`, `gamepad`), then `assert`, `error`, `fps`. If Maxim names an order or a mark, follow that. Take one mark at a time.

## 4. For each mark, read in this order

All paths are inside `marks/NNNN/`.

1. `note.txt` (only if present): what the human saw, in their words. It outranks your theory.
2. `state.json`: the game's own state at the mark. `{"unavailable": true}` or `{"error": ...}` means no usable provider.
3. `log.json`: the last 200 console and SDK log entries, oldest first. Look for the first error, not the last.
4. `shot.png`: the window exactly as the player saw it. Open it at full resolution with the Read tool.
5. `frame.png` (if present): the game's internal frame (e.g. 320x180). Open it at full resolution too.
6. `before/sheet.png`: the last seconds as a contact sheet, for the lead-up and the motion.
7. `inputs.json` (what was held: wall events plus tape lines) and `perf.json` (frame pacing; `max` and `drops` matter for `fps` marks).

A **bare** session (`SESSION.md` line 2 says `bare`; `env.json` `host.bare: true`) ran without the ring buffer: its marks have no `before/` folder, so there is no sheet; use `shot.png`, `frame.png`, `inputs.json` and the replay instead.

Never judge a visual from `sheet.png` alone. Tiles are small and lossy; a sheet tells you where to look, `shot.png` and `frame.png` tell you what is there. Do not call a visual bug "seen" or "not there" until you opened the full-resolution image.

## 5. Replay when the mark is replayable

`SESSION.md` says `(replayable)` in the header and gives a `Replay:` command per mark. Run:

```
snapper replay "<session-dir>" 0001 --before 30 --after 30
```

A mark taken after a level transition (a navigation such as Moonflex's `location.search = "?scene=stage&level=2-1"`) replays with that segment's query automatically (the `reload` marker carries it; `replay.md` has a `Query:` line). For sessions recorded before v1.1.1 the markers carry no query and the replay boots with the session's first one, so the state differs at `$.level` or `$.scene`: that `firstDiff` is the signature of a wrong query. Pass `--query "?scene=stage&level=<level the segment started with>"` (Moonflex: the level of the first mark after the preceding reload; a level reached in-page through the tally's "next" does not navigate and is not the segment's start).

It steps the game headlessly (Electron's Chromium, the same engine as the play window, with the same tape and window size) to the mark and dumps frames and state into `marks/0001/replay/`. The last stdout line is the output folder. Then:

1. Read `replay/replay.md` first. Look at `stateMatches`.
2. `stateMatches: true`: the replay reproduced the state the player had. Open `f<mark frame>.png` and compare it with `frame.png`, then walk back through the earlier `fNNNNNN.png` files and `replay.json` (state per frame) to find the first frame where the wrong value appears.
3. `stateMatches: false`: do NOT trust the replay. It diverged (nondeterminism, code changed since the session, incomplete keymap). Read the `firstDiff` path and both values in `replay.md` (`diffs` / `Differs at:` lists up to three differing paths: `$.rng` alone says little, `$.rng, $.player.y, $.score` says more), check `git.dirty` / the sha in `SESSION.md`, and fall back to the evidence files. Fixing a bug you only saw in an untrusted replay is guessing.
4. Use `--every 2` or more for long windows; `--before`/`--after` widen or narrow it. A mark with `Replay: not replayable` has no stepper or no frame: use the evidence files only, and say so.

## 6. Reproduce before fixing

Write a repro you own (a test, a script that sets up the state and steps the game, or the replay command itself) that fails for the reason in the mark. No repro, no fix: say what is missing instead. Then fix the root cause, not the symptom.

## 7. Prove the fix

Run the repro again (green), the game's own tests, then re-run the same replay command and compare `replay.md` and the frames with the first run. The replay runs the current code on the old inputs: the corrected behaviour must show in the frames. If the fix legitimately changes the state at the mark, `stateMatches` will turn false; that is expected, so state it and compare the frames instead.

## 8. Report per mark

```
Mark 0001 (hotkey, frame 2538): <what was seen: note + what shot.png/frame.png show>
Root cause: <file:line and why>
Fix: <what changed>
Evidence: <session path>/marks/0001/..., replay before/after, test name
```

Include marks you could not resolve, with what is missing.

## 9. During a live session

`session.jsonl` is append-only and written while Maxim plays. Tail it (`tail -f`, or re-read it) and start on the first mark while he is on the fifth. A `mark` line appears only after its folder is complete, so a mark line means it is safe to open. `end` is the last line; until then `SESSION.md` may be behind (`snapper summary` regenerates it). Never write into a session folder yourself except through `snapper replay`/`summary`.

## 10. Trust and provenance

`env.json` -> `game.git`: `sha` is the code that was played; `dirty: true` (the `*` in the SESSION.md header) means uncommitted changes were running, so `git checkout <sha>` alone will not reproduce it: check `git diff` and the working tree. No `sha` at all means the code is unknown: say so and do not assume HEAD.

"Was it Snapper?" `C:\Coding\Snapper\docs\TRUST.md` lists everything the host does to a page in each mode and the measured overhead. Each mark's `perf.json` `host` says what the host was doing at that mark (`ringFps`, `ringFrames`, `markCaptureMs`), and `SESSION.md` has a `Host overhead:` line. If a bug might be the observer (a timing or frame-pacing issue), ask Maxim to play the same spot with `--bare` (no ring buffer, no overlay chip, no F9 panel; the mark key and note box still work) and compare.

## 11. Game not instrumented yet?

The basics (console, exceptions, shots, perf, inputs) need no changes: the host injects the SDK. For state, the game's own frame and replay, the game registers providers on `window.snapper`. Follow the "Integration recipe" in `C:\Coding\Snapper\docs\SDK.md`: `registerState`, `registerFrame`, `registerStepper` (with a `keymap` and `?paused` support), and one `tick(frame, mask)` per fixed step after input is resolved. Guard every call (`window.snapper?.…`) so the game behaves identically without Snapper; keep `tick` allocation-free. The session layout is in `C:\Coding\Snapper\docs\SESSION_FORMAT.md`. Put volatile numbers (fps, timings) under a top-level `perf` key in the state: the replay comparison ignores it.

## 12. Save states and resume

A session can be continued: `--resume` boots the game paused and replays the session's tape from boot to a saved frame, so Maxim lands where he was. States are `checkpoints/*.json` in the session: `0001`... (F6 while playing), `mark-0003` (one per mark), `exit` (written whenever the window closes). `snapper list` shows `states N (exit fNNN)`.

After a fix, tell Maxim (from the Snapper repo) one of:

- `npm run moonflex -- --resume <session-dir> --at mark-0003` lands at the mark. `--at f<frame>` lands earlier: 300 frames before the mark frame is 5 s of lead-up, e.g. `--at f2238` for a mark at frame 2538.
- `npm run moonflex -- --resume last` continues where he stopped (`--at exit` is the default). `last` is the newest session that has states.
- `--at mark-NNNN` also works on sessions recorded before v1.1 (no `checkpoints/` folder): the mark's frame and `state.json` serve as the state, so `resumeMatched` still tells you whether it landed.
- `--at` forms: `exit`, a name (`0002`), a mark (`mark-0003` or `m3`; a bare `3` means state `0003` when it exists, else mark 0003), or `f<frame>`. The restore boots with the query of the segment the state is in, so a mark after a level transition lands in the right level (v1.1.1); a different game is refused. For sessions recorded before v1.1.1 a mark in a later segment needs `--query "?scene=stage&level=<level the segment started with>"` (accepted with `--resume` as an explicit override, recorded as `queryOverride: true`; for Moonflex the mark's own `state.level` is right only when it is the segment's first level). `resumeMatched: false` with `firstDiff` `$.level` or `$.scene` is the signature of a wrong query. A mark after an in-page level change restores only when the game's level swap is synchronous (Moonflex: since its D-065 prefetch of 2026-10-19; a mark recorded across such a change before that, as in the 2026-10-19T15-48-55 session, still differs at `$.level`); say so rather than trusting the landing spot.

Read the result before trusting it: the restore replays old inputs on the current code. If the game code changed since that session (`env.json` `game.git` sha or dirty) or `resumeMatched` is false (SESSION.md says `DIFFERS`, with the first differing path), the game is NOT in the saved state, and marks taken after the resume may not replay. After a fix that changes what happens before that frame, `DIFFERS` is expected (the fix changed the run); use the landing spot to check the fix, not as proof of the old state. `not compared` means no saved state sat on that frame. Marks taken after a resume still replay from boot: `snapper replay <new-session> <mark>` works on the new session, whose tape carries the source's inputs up to the resume frame.

## 13. Regression check

`snapper check <game-root> --sessions 3` replays every replayable mark of the newest three sessions on the current code and compares each with its expectation (`marks/NNNN/expected.json` when one was accepted, else the mark's `state.json`; top-level `perf` ignored). It prints one row per mark (`match`, `differs $.path`, `skipped (reason)`, `error (message)`) and writes `<game-root>/.snapper/checks/<timestamp>.json`. Exit 0 = all match, 1 = something differs or errored.

- Run it after every fix, before you report the fix as done.
- A `differs` on a mark you did not touch is a regression: your change altered a run it should not have. Investigate it (replay that mark with `snapper replay` and read its `replay.md`) before anything else.
- A `differs` on the mark you fixed is expected when the fix changes the state at that frame. Show Maxim what changed (the replay frames). Only when he confirms the new behaviour is right, record it: `snapper check <game-root> --accept --session <session-dir> --marks 0003`. That writes `marks/0003/expected.json`; later checks compare against it.
- Never `--accept` to make a check pass, and never accept marks you have not looked at.
- `skipped` marks are not failures (no stepper, no frame lines, no state); say how many were skipped.

## 14. Sessions from playtesters

A session can come from someone else's machine: a tester played the kit (`snapper pack`) and sent back `outbox/<slug>-<id>.zip`; `snapper import <zip> --root <game-root>` (or the launcher's drop) put it under `.snapper/sessions/`. `SESSION.md` line 2 then says `tester: <name>` and the folder has `import.json`.

- The note is the tester's words, not a developer's: read it as a symptom ("it got stuck"), not a diagnosis.
- The environment is theirs: compare `env.json` `gpu`, `display` (size, dpr, hz), `os` and `host` with yours before blaming the code. A tester's `perf.json` is their frame pacing on their hardware, not yours; an `fps` mark there says little about your machine.
- The code they played is the one packed: `env.json` `config.pack.sha` (and `dirty`) is the developer's commit at `snapper pack` time; the copy itself has no git. Replay and `check` serve your game root (the one given to `import`), so a replay on newer code may differ by design.

## 15. Triage state and issues

Every mark can carry a status in `marks/NNNN/triage.json`: `open`, `fixed`, `wontfix`, `duplicate` (of another mark), `cannot-reproduce`. `SESSION.md` shows the counts in the header and a `Triage:` line per mark; `snapper check` has a status column.

- After a fix: `snapper triage "<session-dir>" 0003 fixed --commit <sha> --note "<one line: the cause>"` (`--by` defaults to the user name; MCP: `set_triage`).
- A mark you could not reproduce: `cannot-reproduce` with what you tried in `--note`. A mark that is the same bug as another: `duplicate --of 0002`.
- `--accept` in `snapper check` on a `fixed` mark is the normal path once Maxim confirmed the new behaviour (section 13).
- `snapper issue "<session-dir>" 0003` writes `marks/0003/issue.md` (title, what was seen, state keys, environment, first errors, held inputs, the replay and check commands, file paths) for pasting into any tracker. `--github` files it with `gh issue create` in the game repo and records the URL in `triage.json`; `--discord <webhook>` posts it with `shot.png`. Only when Maxim asks: both leave the machine.

## 16. "Was it Snapper?": the no-Snapper repro

When Maxim (or anyone) asks whether Snapper caused a bug, answer with a repro that runs without it:

```
snapper export-repro "<session-dir>" 0003 --inject
snapper serve "<session-dir>/marks/0003/repro/repro-game"
```

Open the printed URL plus `/index.html?paused&snapper-repro=1` (the README in `marks/0003/repro/` has the exact URL, with the session's query) in Chrome, Edge or Firefox. The page has no Snapper host, no preload and no DevTools connection; only the SDK (which lets the game register its stepper) and `driver.js`, which feeds the recorded inputs through the game's own `step()` and prints `REPRO: match at frame N` or `REPRO: differs $.path (…)` in the console and at the bottom left of the page.

- `match`: the game's own code produced the same state from the same inputs with no Snapper present. The bug is in the game.
- `differs` does not prove Snapper caused it: wall-clock reads, unseeded randomness, fetch timing or changed code also make a run differ. Check `snapper replay` on the same code first; if that matches and the repro differs, report both results.
- A game that does not honour `?paused` cannot be driven; a game without `index.html` needs the console method in the README.
