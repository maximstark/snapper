# Snapper — playtest capture for web games

Rules only. **This repo is public** (MIT, `github.com/maximstark/snapper`). Contracts: `docs/SESSION_FORMAT.md`, `docs/SDK.md`; what the host does to a page: `docs/TRUST.md`.

- **Session start:** if `private/CLAUDE.md` exists (the maintainer's machine), read it first and follow it: it holds the read order for the private notes and the maintainer's rules.
- **Nothing private goes in this repo:** not in files, commit messages, branch names, tags or PR text. Private means: anyone's quotes, plans, prices under discussion, money, personal life or other projects; machine details (user-profile paths, host names, account emails, hardware lists); recorded sessions, screenshots and evidence from real playtests; internal process notes (status, decisions, briefs, eval logs, launch and marketing drafts). Those live in `private/`, which is gitignored and is its own private repo. **When unsure, it is private:** put it in `private/` and ask.
- **The guard is not optional.** `node scripts/check-public.mjs` checks tracked paths and text (user-profile paths, emails, session links, secrets, the private deny list in `private/public-denylist.txt`, the commit email); `npm test` runs it, and `.githooks/` runs it on commit, on the commit message and on push (`git config core.hooksPath .githooks`, once per clone). Never bypass it (`--no-verify`, `git add -f` on an ignored path). A false positive is fixed in the pattern, in the same commit, with the reason.
- **Before committing, read the staged diff** (`git diff --cached`) for anything the guard can't know: a quote, a name, a plan, a number that came from a private note. Public docs describe the product, never the process behind it.
- **Contracts are canon:** changing `docs/SESSION_FORMAT.md` or `docs/SDK.md` needs a version bump of the format or the SDK, never a silent edit.
- **Plain ESM JavaScript, Node 20+.** No TypeScript, no bundler. The SDK has no build step and no dependencies. The host depends on Electron only, pinned exact; `packages/mcp` has no dependencies. Keep host-only code out of the SDK, skill and MCP packages: they stay usable on their own.
- **The SDK never hurts the game.** `tick()` is allocation-free at steady state; every SDK call is a no-op that never throws when no host is attached; a game must behave as if Snapper does not exist when it is absent.
- **The overlay never appears in a capture.**
- **`session.jsonl` and `tape.jsonl` are append-only.** Nothing rewrites them; `SESSION.md` is derived and may be regenerated at any time.
- **Nothing is done on "looks fine."** Every claim points at a test, a gate script or a replay output.
- **Sessions never land in the repo:** `sessions/`, every `.snapper/` folder and `private/` are gitignored; gate scripts write evidence to `private/evidence/` (with `EVIDENCE=1`).
- **Licence:** everything here is MIT; third-party code under `examples/*/vendor/` keeps its own.
- **Line endings:** LF.
