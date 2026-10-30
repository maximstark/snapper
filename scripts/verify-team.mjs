// Z5 — team features (BRIEF-v1.4 §4.6): SESSION.html offline in a plain Electron window, triage, check status, issue
// (markdown, --github against the stub gh.cmd, --discord against a local server).
//   node scripts/verify-team.mjs        EVIDENCE=1 writes private/evidence/v1.4/z5/
import { join, delimiter } from "node:path";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { REPO, snapper, checklist, exists, evidence, EVIDENCE_ON } from "./lib.mjs";
import { shotPage } from "../tests/fixtures/shot-page.mjs";

const Z5 = join(REPO, "sessions", "w2", "z5");
const c = checklist("Z5 team features");
const GH_STUB = join(REPO, "tests", "fixtures", "gh-stub");
await rm(Z5, { recursive: true, force: true });
await mkdir(Z5, { recursive: true });

const run = (args, env = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [join(REPO, "bin", "snapper.mjs"), ...args], { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  child.on("close", code => resolve({ code, stdout, stderr }));
});
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

// ---- a demo session
const rec = await snapper(["play", join(REPO, "examples", "demo"), "--smoke", join(REPO, "examples", "demo", "smoke.json"), "--out", join(Z5, "rec")], { timeoutMs: 240000, echo: false });
const S = rec.last?.session;
c.check("demo session recorded with marks", rec.code === 0 && !!S && rec.last.marks >= 1, rec.lastLine);
if (!S) { c.report(); process.exit(1); }
const M1 = join(S, "marks", "0001");

// ---- SESSION.html
const sum = await run(["summary", S]);
const htmlPath = join(S, "SESSION.html");
c.check("snapper summary writes SESSION.md and SESSION.html", sum.code === 0 && await exists(htmlPath) && await exists(join(S, "SESSION.md")), sum.stdout.trim().replace(/\r?\n/g, " | "));
const html = await readFile(htmlPath, "utf8");
c.check("SESSION.html: no script tag, no data: image, no external reference", !/<script/i.test(html) && !html.includes("data:") && !/(?:src|href)="https?:/.test(html));
const png = join(Z5, "SESSION-html.png");
const shot = await shotPage(htmlPath, png);
const shotImg = shot.page?.images?.find(i => i.src === "marks/0001/shot.png");
c.check("SESSION.html opens from file:// in a plain visible Electron window, offline", shot.ok && shot.blocked.length === 0, `blocked requests: ${JSON.stringify(shot.blocked)} ${shot.error || ""}`);
c.check("the shot image loaded (complete, naturalWidth > 0)", !!shotImg && shotImg.complete && shotImg.naturalWidth > 0, JSON.stringify(shotImg));
c.check("every image on the page loaded", !!shot.page && shot.page.images.length > 0 && shot.page.images.every(i => i.complete && i.naturalWidth > 0), `${shot.page?.images?.length} images`);
c.check("page has no script elements; screenshot is full page size", shot.page?.scripts === 0 && shot.size?.width === 1400, JSON.stringify(shot.size));

// ---- triage + check status
const sha = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const tri = await run(["triage", S, "0001", "fixed", "--commit", sha, "--note", "z5"]);
c.check("triage fixed --commit <sha> --note z5", tri.code === 0 && /fixed by .* commit /.test(tri.stdout), tri.stdout.trim());
const md = await readFile(join(S, "SESSION.md"), "utf8");
c.check("SESSION.md shows the Triage lines", /^Triage: 1 fixed · \d+ untriaged$/m.test(md) && /^Triage: fixed by .*"z5"$/m.test(md));
c.check("SESSION.html regenerated with the triage line", (await readFile(htmlPath, "utf8")).includes("Triage: fixed by"));
const chk = await snapper(["check", join(REPO, "examples", "demo"), "--session", S, "--out", join(Z5, "check"), "--json"], { timeoutMs: 300000, echo: false });
const row = chk.last?.rows?.find(r => String(r.mark) === "0001" || String(r.id) === "0001");
c.check("check --json: row 0001 carries status fixed", chk.code === 0 && row?.status === "fixed", JSON.stringify(row));

// ---- issue --markdown
const iss = await run(["issue", S, "0001"]);
const issueMd = await readFile(join(M1, "issue.md"), "utf8").catch(() => "");
c.check("issue writes marks/0001/issue.md and prints it", iss.code === 0 && iss.stdout === issueMd && issueMd.length > 0);
c.check("issue.md: title, env line, replay command", /^# smoke mark — demo \S+ mark 0001\n/.test(issueMd) && /Snapper 1\.\d\.\d · .* · GPU .* · display \d+×\d+/.test(issueMd) && issueMd.includes(`snapper replay "${S}" 0001`), issueMd.split("\n")[0]);

// ---- issue --github with the stub gh.cmd (first on PATH for the child only)
const rec2 = join(Z5, "gh-record.json");
const gh = await run(["issue", S, "0001", "--github"], { PATH: `${GH_STUB}${delimiter}${process.env.PATH}`, SNAPPER_GH_STUB_OUT: rec2 });
const ghRec = JSON.parse(await readFile(rec2, "utf8").catch(() => "null") || "null");
const tj = JSON.parse(await readFile(join(M1, "triage.json"), "utf8"));
c.check("issue --github (stub gh): prints the URL", gh.code === 0 && gh.stdout.trim() === "https://github.com/example/demo/issues/42", gh.stderr.trim() || gh.stdout.trim());
c.check("the URL is recorded in triage.json, status kept", tj.issue === "https://github.com/example/demo/issues/42" && tj.status === "fixed");
c.check("the stub saw `issue create --title` and `--body-file`", !!ghRec && ghRec.args.slice(0, 3).join(" ") === "issue create --title" && ghRec.args.includes("--body-file") && /shot: /.test(ghRec.body || ""), JSON.stringify(ghRec?.args));

// ---- issue --discord against a local server
const calls = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", d => chunks.push(d));
  req.on("end", async () => {
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": req.headers["content-type"] } }).formData().catch(() => null);
    calls.push({ url: req.url, form });
    res.writeHead(204); res.end();
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const hook = `http://127.0.0.1:${server.address().port}/hook/z5secrettoken`;
const dc = await run(["issue", S, "0001", "--discord", hook]);
server.close();
const part = calls[0]?.form?.get("files[0]");
const shotBytes = await readFile(join(M1, "shot.png"));
c.check("issue --discord: one POST with a payload_json part and a shot.png file part", dc.code === 0 && calls.length === 1 && !!calls[0].form.get("payload_json") && part?.name === "shot.png", dc.stderr.trim());
c.check("the shot.png bytes equal the mark's shot.png", !!part && Buffer.compare(Buffer.from(await part.arrayBuffer()), shotBytes) === 0);
c.check("payload content is under Discord's 2000-character limit", JSON.parse(calls[0]?.form?.get("payload_json") || "{}").content?.length < 2000);
let leaked = [];
for (const f of await walk(S)) if ((await readFile(f)).includes("z5secrettoken")) leaked.push(f);
c.check("the webhook URL appears in no file of the session folder, nor on stdout/stderr", leaked.length === 0 && !dc.stdout.includes("z5secrettoken") && !dc.stderr.includes("z5secrettoken"), leaked.join(", "));

const ok = c.report();
if (EVIDENCE_ON) {
  const files = await evidence("z5", [[png, "SESSION-html.png"], [join(M1, "issue.md"), "issue.md"], [rec2, "gh-record.json"]], "v1.4");
  const dir = join(REPO, "private", "evidence", "v1.4", "z5");
  await writeFile(join(dir, "checks.json"), JSON.stringify({ gate: "Z5", date: new Date().toISOString(), ok, session: S, checks: c.items }, null, 2) + "\n");
  process.stdout.write(`evidence: ${files.length + 1} files in ${dir}\n`);
}
process.exit(ok ? 0 : 1);
