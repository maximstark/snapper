# Contributing

Thanks for looking. Snapper is maintained by one person, so issues and pull requests are welcome, with no promised response time.

- **Bugs:** the most useful report is a Snapper session. Zip the session folder (it holds `SESSION.md`, the shots and the state) or paste `SESSION.md` and the mark's `state.json`. Say which game engine and Windows version.
- **Code:** plain ESM JavaScript, Node 20+, no TypeScript, no bundler. The SDK (`packages/sdk`) has no dependencies and no build step, and must never hurt a game: every call is a no-op that never throws when no host is attached, and `tick()` does not allocate at steady state. `npm test` must pass.
- **Contracts:** `docs/SESSION_FORMAT.md` and `docs/SDK.md` are the contracts. A change to either needs a version bump of the format or the SDK, not a silent edit.
- **Nothing private:** never commit recorded sessions, screenshots of other people's games, paths with your user name, email addresses or keys. `node scripts/check-public.mjs` checks for them; `git config core.hooksPath .githooks` runs it on every commit.
- **Licence:** contributions are under the MIT licence, like the rest of the repo.
