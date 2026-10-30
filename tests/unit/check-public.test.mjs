import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFile, denylist } from "../../scripts/check-public.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const why = (path, text, opts) => checkFile(path, text == null ? null : Buffer.from(text), opts).map(p => p.why);

test("check-public: user-profile and home paths are flagged, placeholders are not", () => {
  // The samples are split ("Us" + "ers") so this file's own text passes the guard.
  assert.deepEqual(why("a.md", "see C:\\Us" + "ers\\Alice\\AppData"), ["a Windows user-profile path"]);
  assert.deepEqual(why("a.md", "see c:/us" + "ers/alice/x"), ["a Windows user-profile path"]);
  assert.deepEqual(why("a.md", "see C:\\Users\\<you>\\AppData and C:/Users/%USERNAME%/x"), []);
  assert.deepEqual(why("a.md", "see %LOCALAPPDATA%\\Programs\\Snapper"), []);
  assert.deepEqual(why("a.md", "path /ho" + "me/alice/x"), ["a home-folder path"]);
  assert.deepEqual(why("a.md", "path /home/<user>/x"), []);
  assert.deepEqual(why("a.md", "wsl sees /mnt/c/Us" + "ers/bob/x"), ["a Windows user-profile path"]);
  assert.deepEqual(why("a.md", "wsl sees /mnt/c/Users/<you>/x"), []);
  assert.deepEqual(why("a.md", "share \\\\wsl.localhost\\Ubuntu\\ho" + "me\\bob\\x"), ["a home-folder path"]);
  assert.deepEqual(why("a.md", "share \\\\wsl$\\Ubuntu\\home\\<user>\\x"), []);
});

test("check-public: email addresses are flagged except the allowed ones", () => {
  assert.deepEqual(why("a.md", "mail bob@" + "gmail.com"), ["an email address"]);
  assert.deepEqual(why("a.md", "maxim@maximstark.art, noreply@anthropic.com, 1+a@users.noreply.github.com, x@example.com"), []);
  assert.deepEqual(why("a.md", 'import { test } from "@playwright/test"'), []);
});

test("check-public: private paths, internal notes and sessions are refused by path", () => {
  assert.equal(why("private/STATUS.md", "x").length, 1);
  assert.equal(why("docs/DECISIONS.md", "x").length, 1);
  assert.equal(why("docs/evidence/v1.4/a.png", null).length, 1);
  assert.equal(why("sessions/g3/a/SESSION.md", "x").length, 1);
  assert.equal(why("games/x/.snapper/sessions/a/tape.jsonl", "x").length, 1);
  assert.deepEqual(why("docs/SDK.md", "ok"), []);
});

test("check-public: secrets, session links and deny-list terms; vendor code is not scanned", () => {
  assert.deepEqual(why("a.js", "const k = 'sk-" + "ant-abcdefghijklmnop'"), ["a secret"]);
  assert.deepEqual(why("a.js", "https://discord.com/api/web" + "hooks/123/abc"), ["a secret"]);
  assert.deepEqual(why("a.js", "https://discord.example/api/webhooks/123/abc"), []);
  assert.deepEqual(why("a.md", "https://claude.ai/code/" + "session_0147abc"), ["a private Claude session link"]);
  assert.deepEqual(why("commit message", "Claude-Session: https://claude.ai/code/" + "session_0147abc", { msg: true }), []);
  assert.deepEqual(why("a.md", "a Secret Word here", { terms: ["secret word"] }), ["a term on the private deny list"]);
  assert.deepEqual(why("examples/x/vendor/lib.js", "bob@" + "gmail.com"), []);
});

test("check-public: every tracked file in this repo passes (with the private deny list when it exists)", () => {
  const terms = denylist();
  const files = execFileSync("git", ["ls-files"], { cwd: REPO }).toString().split("\n").filter(Boolean);
  const hits = files.flatMap(f => { try { return checkFile(f, readFileSync(join(REPO, f)), { terms }); } catch { return checkFile(f, null); } });
  assert.deepEqual(hits, []);
});
