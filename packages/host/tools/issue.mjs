// snapper issue <session-dir> <mark> [--markdown | --github | --discord <webhook-url>] [--title "…"]
//   --markdown (default)  write marks/NNNN/issue.md and print it
//   --github              `gh issue create --title <t> --body-file <issue.md>` in the game root; prints the URL and records it
//                         in triage.json (the API cannot attach images: the body says `shot: <path>`)
//   --discord [<url>]     POST the title, a short body and shot.png as multipart; the URL (or snapper.config.json
//                         `discordWebhook` of the game root) is never written to a session, printed or logged
// Exit codes: 0 ok, 1 gh or Discord failure, 2 usage or refusal.
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { delimiter, extname, join, resolve } from "node:path";
import { buildIssue, writeTriage, readTriage, writeSummary, sessionGameRoot, readSession, readGameConfig } from "../../core/index.mjs";
import { defaultBy } from "./triage.mjs";

const USAGE = 'usage: snapper issue <session-dir> <mark> [--markdown | --github | --discord <webhook-url>] [--title "…"]';
const err = msg => process.stderr.write(`snapper issue: ${msg}\n`);
const fail = (message, exitCode) => Object.assign(new Error(message), { exitCode });

/** Replace every trace of a webhook URL (whole, its path, its token segments) in a message. */
export function redactUrl(text, url) {
  let s = String(text ?? "");
  if (!url) return s;
  const parts = new Set([String(url)]);
  try {
    const u = new URL(String(url));
    parts.add(u.href); parts.add(u.pathname);
    for (const seg of u.pathname.split("/")) if (seg.length >= 8) parts.add(seg);
  } catch {}
  for (const p of [...parts].sort((a, b) => b.length - a.length)) s = s.split(p).join("<webhook>");
  return s;
}

// ---- gh ---------------------------------------------------------------------------------------------------------

/**
 * Find `gh` on PATH honouring PATHEXT (Windows). Returns { file, shell } (shell: true for a .cmd/.bat, which Node cannot
 * spawn directly) or null. `env` is the environment to read PATH/PATHEXT from; `platform` is for tests.
 */
export function resolveGh(env = process.env, platform = process.platform) {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  const win = platform === "win32";
  const exts = win ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const sep = win ? ";" : delimiter;
  for (const dir of pathVar.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      for (const e of win ? [ext.toLowerCase(), ext.toUpperCase()] : [ext]) {
        const file = join(dir.replace(/^"|"$/g, ""), `gh${e}`);
        let ok = false;
        try { ok = statSync(file).isFile(); } catch {}
        if (ok) return { file, shell: win && /^\.(cmd|bat)$/i.test(extname(file)) };
      }
    }
  }
  return null;
}

/**
 * Quote one argument for the cmd.exe path. cmd's `%VAR%` expansion, `!`, `^`, `&`, `|`, `<`, `>` and `"` cannot be quoted
 * reliably inside a /s /c command line, so they are DROPPED from titles (sanitizeForCmd) and REFUSED in paths.
 */
export function sanitizeForCmd(s) {
  return String(s ?? "").replace(/["%!^&|<>\r\n]/g, "").replace(/\s+/g, " ").trim();
}
const CMD_BAD_PATH = /["%!^&|<>]/;

/**
 * Run gh (or a gh.cmd stub) with an args array. A real gh.exe is spawned directly (no shell, no quoting). A .cmd/.bat goes
 * through cmd.exe deliberately: Node refuses to spawn them directly (EINVAL). Resolves { code, stdout, stderr }.
 */
export function runGh(gh, args, { cwd, env = process.env } = {}) {
  return new Promise((resolveP, reject) => {
    let child;
    try {
      if (gh.shell) {
        for (const a of args) if (CMD_BAD_PATH.test(a)) throw fail(`cannot pass ${JSON.stringify(a)} through cmd.exe (it contains one of " % ! ^ & | < >)`, 1);
        const cmdline = `"${gh.file}" ${args.map(a => `"${a}"`).join(" ")}`;
        child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cmdline}"`], { cwd, env, windowsVerbatimArguments: true, windowsHide: true });
      } else child = spawn(gh.file, args, { cwd, env, windowsHide: true });
    } catch (e) { reject(e); return; }
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", reject);
    child.on("close", code => resolveP({ code, stdout, stderr }));
  });
}

/** The issue URL: the last https URL on gh's stdout. */
export function urlFromGhOutput(stdout) {
  const m = String(stdout ?? "").match(/https?:\/\/\S+/g);
  return m ? m[m.length - 1].replace(/[.,;)]+$/, "") : null;
}

/** `snapper issue --github`: returns { url, issueFile }. Throws Error with .exitCode (1 gh failed, 2 refusal). */
export async function githubIssue(sessionDir, markId, { title, by, env = process.env } = {}) {
  const issue = await createIssueFile(sessionDir, markId, { title });
  const session = await readSession(sessionDir, { marks: false });
  const root = await sessionGameRoot(sessionDir, session.env);
  if (!root) throw fail("--github needs the game root (env.json game.root does not exist on this machine and import.json names none); import with --root", 2);
  const gh = resolveGh(env);
  if (!gh) throw fail("gh (the GitHub CLI) is not on PATH; install it from https://cli.github.com and run `gh auth login`, or use --markdown and paste the file", 1);
  const t = gh.shell ? sanitizeForCmd(issue.title) : issue.title.replace(/[\r\n]+/g, " ");
  let res;
  try { res = await runGh(gh, ["issue", "create", "--title", t, "--body-file", issue.file], { cwd: root, env }); }
  catch (e) { throw fail(`could not run gh: ${e.message}`, 1); }
  if (res.code !== 0) throw fail(`gh issue create failed (exit ${res.code}) in ${root}: ${(res.stderr || res.stdout).trim().split("\n").slice(-3).join(" | ")}`, 1);
  const url = urlFromGhOutput(res.stdout);
  if (!url) throw fail(`gh printed no issue URL: ${res.stdout.trim().slice(0, 200)}`, 1);
  const prev = await readTriage(sessionDir, String(markId).padStart(4, "0"));
  await writeTriage(sessionDir, markId, { issue: url, by: by || prev?.by || defaultBy() });
  await writeSummary(sessionDir);
  return { url, issueFile: issue.file };
}

// ---- Discord ----------------------------------------------------------------------------------------------------

const DISCORD_MAX = 2000;

/** The Discord message text: the title, then the head of the body, at most 1900 characters (limit 2000). */
export function discordContent(title, body) {
  const head = String(body).split("\n## First errors")[0].replace(/^## (.*)$/gm, "**$1**");
  const text = `**${title}**\n${head}`.replace(/\n{3,}/g, "\n\n").trim();
  return text.length > 1900 ? text.slice(0, 1899) + "…" : text;
}

/** The multipart form Discord's webhook takes: `payload_json` (content) and `files[0]` (shot.png). */
export function buildDiscordForm({ title, body, shot }) {
  const form = new FormData();
  const content = discordContent(title, body);
  if (content.length > DISCORD_MAX) throw new Error("discord content over 2000 characters");
  const payload = { content, attachments: shot ? [{ id: 0, filename: "shot.png" }] : [] };
  form.append("payload_json", JSON.stringify(payload));
  if (shot) form.append("files[0]", new Blob([shot], { type: "image/png" }), "shot.png");
  return form;
}

/** POST the mark to a webhook. Throws Error(message with the URL redacted) and .exitCode 1 on failure. */
export async function discordPost(webhookUrl, { title, body, shot }) {
  let u;
  try { u = new URL(String(webhookUrl)); } catch { throw fail("the Discord webhook is not a URL", 2); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw fail("the Discord webhook must be an http(s) URL", 2);
  try {
    const res = await fetch(u, { method: "POST", body: buildDiscordForm({ title, body, shot }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    throw fail(`Discord post failed: ${redactUrl(e.cause?.message ? `${e.message} (${e.cause.message})` : e.message, webhookUrl)}`, 1);
  }
}

// ---- shared + run -----------------------------------------------------------------------------------------------

/** Build the issue and write marks/NNNN/issue.md. Returns { title, body, markdown, markDir, file }. */
async function createIssueFile(sessionDir, markId, { title }) {
  const issue = await buildIssue(sessionDir, markId, { title });
  const file = join(issue.markDir, "issue.md");
  await writeFile(file, issue.markdown);
  return { ...issue, file };
}

export async function run({ positional, flags }) {
  const [sessionArg, mark] = positional;
  if (!sessionArg || !mark) { err(USAGE); return 2; }
  if (flags.title === true) { err("--title needs a value"); return 2; }
  const modes = [flags.markdown && "markdown", flags.github && "github", flags.discord && "discord"].filter(Boolean);
  if (modes.length > 1) { err(`choose one of --markdown, --github, --discord (got ${modes.join(", ")})`); return 2; }
  const dir = resolve(sessionArg);
  const title = typeof flags.title === "string" ? flags.title : undefined;
  try {
    if (flags.github) {
      const { url } = await githubIssue(dir, mark, { title, by: typeof flags.by === "string" ? flags.by : undefined });
      process.stdout.write(`${url}\n`);
      return 0;
    }
    if (flags.discord) {
      const issue = await createIssueFile(dir, mark, { title });
      let url = typeof flags.discord === "string" ? flags.discord : null;
      if (!url) {
        const session = await readSession(dir, { marks: false });
        const root = await sessionGameRoot(dir, session.env);
        try { url = root ? readGameConfig(root).discordWebhook : null; } catch {}
        if (!url) throw fail("--discord needs a webhook URL (or `discordWebhook` in the game's snapper.config.json)", 2);
      }
      const shotPath = join(issue.markDir, "shot.png");
      const shot = existsSync(shotPath) ? readFileSync(shotPath) : null;
      await discordPost(url, { title: issue.title, body: issue.body, shot });
      process.stdout.write(`posted mark ${String(mark).padStart(4, "0")} to the Discord webhook${shot ? " with shot.png" : ""}\n`);
      return 0;
    }
    const issue = await createIssueFile(dir, mark, { title });
    process.stdout.write(issue.markdown);
    process.stderr.write(`snapper issue: wrote ${issue.file}\n`);
    return 0;
  } catch (e) {
    err(e.message);
    return e.exitCode ?? 2;
  }
}
