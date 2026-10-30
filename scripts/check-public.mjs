// The public-repo guard: this repo is public, so nothing private lands in it. Checks paths and text, prints each hit.
//   node scripts/check-public.mjs            every tracked file as it is on disk (npm test and the pre-push hook)
//   node scripts/check-public.mjs --staged   the staged version of each added or changed file (the pre-commit hook)
//   node scripts/check-public.mjs --msg <f>  a commit message file (the commit-msg hook)
// More private terms, one per line (# comments), go in private/public-denylist.txt on the maintainer's machine; this file
// is public, so it never names them. When private/ exists the commit email must be a GitHub noreply address.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 5 * 1024 * 1024;

/** Paths that never belong here, with the reason printed. */
export const PRIVATE_PATHS = [
  [/^private\//, "private/ holds the maintainer's notes (its own private repo)"],
  [/(^|\/)sessions\//, "recorded sessions never land in the repo"],
  [/(^|\/)\.snapper\//, "recorded sessions never land in the repo"],
  [/(^|\/)(session|tape)\.jsonl$/, "recorded sessions never land in the repo"],
  [/^(dist|node_modules)\//, "build output"],
  [/^docs\/(BRIEF[^/]*|STATUS|DECISIONS|EVAL_LOG|LANDSCAPE|MARKETING)\.md$/i, "internal notes belong in private/"],
  [/^docs\/(evidence|launch)\//, "internal notes belong in private/"],
];

const PLACEHOLDER = String.raw`(?:<[^>]*>|%[^%]*%|\$\{?\w+\}?|you|me|user|username|name|runner|public|default)`;

/** Text that never belongs here. `msg: false` rules are skipped for commit messages. */
export const PRIVATE_TEXT = [
  { re: new RegExp(String.raw`\b[A-Za-z]:[\\/]+Users[\\/]+(?!${PLACEHOLDER}(?:[\\/"'\x60\s]|$))[^\\/\s"'\x60<>]+`, "i"), why: "a Windows user-profile path" },
  { re: new RegExp(String.raw`/mnt/[a-z]/Users/(?!${PLACEHOLDER}(?:[/"'\x60\s]|$))[^/\s"'\x60<>]+`, "i"), why: "a Windows user-profile path" },
  { re: new RegExp(String.raw`(?:^|[\s"'\x60(=])/(?:home|Users)/(?!${PLACEHOLDER}(?:[/"'\x60\s]|$))[A-Za-z0-9_.-]+`), why: "a home-folder path" },
  { re: new RegExp(String.raw`\\\\wsl(?:\.localhost|\$)[\\/]+[^\\/\s]+[\\/]+home[\\/]+(?!${PLACEHOLDER}(?:[\\/"'\x60\s]|$))[^\\/\s"'\x60<>]+`, "i"), why: "a home-folder path" },
  { re: /[A-Za-z0-9._%+-]+@(?!(?:maximstark\.art|anthropic\.com|users\.noreply\.github\.com|example\.(?:com|org|net))\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/, why: "an email address" },
  { re: /claude\.ai\/(?:code\/)?session_[A-Za-z0-9]+/i, why: "a private Claude session link", msg: false },
  { re: /sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|discord(?:app)?\.com\/api\/webhooks\/\d+\//, why: "a secret" },
];

/** Files whose text is not scanned: third-party code and the lockfile. */
const SKIP_TEXT = [/(^|\/)vendor\//, /^package-lock\.json$/];

export function denylist(file = join(REPO, "private", "public-denylist.txt")) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(l => l.toLowerCase());
}

/** Pure: the problems in one file, as { path, line?, why }. `buf` is its content (a Buffer) or null when only the path is known. */
export function checkFile(path, buf, { terms = [], msg = false } = {}) {
  const out = [];
  if (!msg) for (const [re, why] of PRIVATE_PATHS) if (re.test(path)) { out.push({ path, why }); return out; }
  if (!buf) return out;
  if (buf.length > MAX_BYTES) out.push({ path, why: `larger than ${MAX_BYTES >> 20} MB` });
  if (!msg && SKIP_TEXT.some(re => re.test(path))) return out;
  if (buf.subarray(0, 8000).includes(0)) return out;
  const lines = buf.toString("utf8").split(/\r?\n/);
  lines.forEach((text, i) => {
    for (const r of PRIVATE_TEXT) if (!(msg && r.msg === false) && r.re.test(text)) out.push({ path, line: i + 1, why: r.why });
    const low = text.toLowerCase();
    for (const t of terms) if (low.includes(t)) out.push({ path, line: i + 1, why: "a term on the private deny list" });
  });
  return out;
}

const git = (...args) => execFileSync("git", args, { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });

function authorEmail() {
  const ident = git("var", "GIT_AUTHOR_IDENT").toString();
  return (ident.match(/<([^>]*)>/) || [])[1] || "";
}

function main(argv) {
  const terms = denylist();
  const problems = [];
  let count = 0;
  const msgAt = argv.indexOf("--msg");
  if (argv.includes("--push")) {
    // pre-push stdin: "<local ref> <local sha> <remote ref> <remote sha>" per ref; branch and tag names are public too
    let input = "";
    try { input = readFileSync(0, "utf8"); } catch { input = ""; }
    for (const ref of input.split(/\r?\n/).flatMap(l => l.trim().split(/\s+/).filter((_, i) => i === 0 || i === 2)).filter(Boolean)) {
      problems.push(...checkFile(`ref ${ref}`, Buffer.from(ref), { terms, msg: true }));
    }
  }
  if (msgAt >= 0) {
    const file = argv[msgAt + 1];
    problems.push(...checkFile("commit message", readFileSync(file), { terms, msg: true }));
    count = 1;
  } else {
    const staged = argv.includes("--staged");
    const paths = staged
      ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").toString().split("\0").filter(Boolean)
      : git("ls-files", "-z").toString().split("\0").filter(Boolean);
    for (const p of paths) {
      let buf = null;
      try { buf = staged ? git("show", `:${p}`) : readFileSync(join(REPO, p)); } catch { buf = null; }
      problems.push(...checkFile(p, buf, { terms }));
    }
    count = paths.length;
    if (existsSync(join(REPO, "private"))) {
      const email = authorEmail();
      if (!email.endsWith("@users.noreply.github.com")) problems.push({ path: "git config user.email", why: "the commit email must be the GitHub noreply address" });
    }
  }
  for (const p of problems) process.stderr.write(`check-public: ${p.path}${p.line ? `:${p.line}` : ""}  ${p.why}\n`);
  if (problems.length) {
    process.stderr.write("check-public: blocked. Move it to private/ or reword it; never bypass with --no-verify.\n");
    return 1;
  }
  process.stdout.write(`check-public: ${count} ${count === 1 ? "item" : "files"} clean\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
