// v1.3 launcher: the recipe text shown by "Set up for Claude" is the SDK.md block, and installSkill touches only .claude/skills/snapper.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill } from "../../packages/host/tools/skill.mjs";

const REPO = new URL("../../", import.meta.url);
const read = p => readFileSync(new URL(p, REPO), "utf8");

test("launcher/recipe.txt equals the Integration recipe code block in docs/SDK.md", () => {
  const sdk = read("docs/SDK.md");
  const at = sdk.indexOf("## Integration recipe");
  assert.ok(at >= 0, "SDK.md has an Integration recipe section");
  const m = /```js\r?\n([\s\S]*?)\r?\n```/.exec(sdk.slice(at));
  assert.ok(m, "the section has a js block");
  const recipe = read("packages/host/launcher/recipe.txt");
  assert.equal(recipe.includes("\r"), false, "recipe.txt is LF");
  assert.equal(recipe, m[1] + "\n");
  assert.ok(m[1].split("\n").length <= 20, "about 15 lines");
});

test("installSkill: writes .claude/skills/snapper and nothing else; returns dest and files", async () => {
  const root = mkdtempSync(join(tmpdir(), "snapper-skill-"));
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  mkdirSync(join(root, "assets"));
  const res = await installSkill(root);
  assert.equal(res.dest, join(root, ".claude", "skills", "snapper"));
  assert.ok(res.files.length >= 1);
  assert.ok(existsSync(join(res.dest, "SKILL.md")));
  for (const f of res.files) assert.ok(existsSync(f), f);
  assert.deepEqual(readdirSync(root).sort(), [".claude", "assets", "index.html"]);
  assert.deepEqual(readdirSync(join(root, ".claude")), ["skills"]);
  assert.deepEqual(readdirSync(join(root, ".claude", "skills")), ["snapper"]);
  await assert.rejects(installSkill(join(root, "missing")), e => e.exitCode === 2 && /not found/.test(e.message));
});
