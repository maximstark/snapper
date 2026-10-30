// snapper export-repro <session-dir> <mark> [--out <dir>] [--inject]   (v1.4, D-028; BRIEF-v1.4 Part 4)
// Writes a folder that replays a mark's tape in a stock browser with NO Snapper present (no host, no preload, no CDP):
//   snapper-sdk.js   the SDK exactly as the host injects it (packages/sdk/snapper.js)
//   driver.js        packages/sdk/repro-driver.js (MIT): feeds the tape through the game's own stepper, compares, prints
//   tape.json        the mark's tape segment up to its frame, the query, the pause param, the keymap, the seed
//   expected.json    the mark's expected.json (snapper check --accept) when present, else its state.json
//   README.md        how to run it, and what "match" and "differs" prove
// --inject also writes repro-game/: a copy of the game root with the two script tags inserted before the first module
// script of the page the session loaded, plus repro/ inside it, ready for `snapper serve repro-game`.
// Plain Node. Exit codes: 0 written (the folder is the last stdout line), 2 refusal, 1 error.
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { segmentForMark, chooseQuery, readJson, sessionGameRoot, SNAPPER_VERSION } from "../../core/index.mjs";
import { prepareReplay } from "../replay/inprocess.mjs";
import { Refusal } from "../replay/runner.mjs";

const SDK = fileURLToPath(new URL("../../sdk/snapper.js", import.meta.url));
const DRIVER = fileURLToPath(new URL("../../sdk/repro-driver.js", import.meta.url));
const COPY_SKIP = new Set([".git", "node_modules", ".snapper", ".claude", "dist"]);
const err = s => process.stderr.write(`snapper export-repro: ${s}\n`);
export const USAGE = "usage: snapper export-repro <session-dir> <mark> [--out <dir>] [--inject]";

/** Pure: insert the SDK and driver tags before the first module script (else the first script, else </body>, else the end). */
export function injectTags(html, base = "repro/") {
  const tags = `<script src="${base}snapper-sdk.js"></script>\n<script type="module" src="${base}driver.js"></script>\n`;
  const s = String(html);
  const at = [/<script\b[^>]*\btype\s*=\s*["']?module["']?[^>]*>/i, /<script\b/i, /<\/body>/i]
    .map(re => s.search(re)).find(i => i >= 0);
  return at === undefined ? s + "\n" + tags : s.slice(0, at) + tags + s.slice(at);
}

/** Pure: tape.json text: the header keys one per line, then one frame line `{"f":…,"m":…}` per line. */
export function tapeJson(doc) {
  const { frames, ...head } = doc;
  const h = JSON.stringify(head, null, 1).replace(/\n}$/, "");
  return `${h},\n "frames": [\n${frames.map(x => "  " + JSON.stringify({ f: x.f, m: x.m })).join(",\n")}\n ]\n}\n`;
}

/** Pure: the query string to open the repro with: the session's query + the pause param + snapper-repro=1. */
export function openQuery(query, pauseParam = "paused") {
  const q = String(query || "").replace(/^[?&]+/, "");
  return "?" + [q, pauseParam, "snapper-repro=1"].filter(Boolean).join("&");
}

/**
 * Build the repro folder. req: { sessionDir, markId, out, inject }. Returns { dir, files, gameDir, page, url }.
 * Throws Refusal for everything the user must fix.
 */
export async function exportRepro({ sessionDir, markId, out = null, inject = false }) {
  const p = await prepareReplay({ sessionDir, markId });          // the replay's own refusals: no stepper, no frame lines, …
  const { session, tape, mark } = p;
  const env = session.env || {};
  const markDir = join(p.sessionDir, ...(mark.dir || `marks/${mark.id}`).split("/"));
  const dir = out ? resolve(String(out)) : join(markDir, "repro");
  const seg = segmentForMark(tape.lines, mark);
  const frames = seg.frames.filter(x => x.f <= mark.frame);
  if (!frames.length) throw new Refusal(`mark ${mark.id}: the tape has no frame lines at or before frame ${mark.frame}`);
  const keymap = tape.header?.keymap?.length ? tape.header.keymap : env.sdk?.keymap || [];
  const pauseParam = tape.header?.pauseParam || env.sdk?.pauseParam || "paused";
  const q = chooseQuery({ lines: tape.lines, index: seg.index, envQuery: env.game?.query });
  // the seed the game reported in this segment (informational; the game seeds itself from its own data)
  let seed = null, segIndex = -1;
  for (const l of tape.lines) {
    if (l.ev === "reload") segIndex++;
    if (l.ev === "seed" && Math.max(0, segIndex) === seg.index && Number.isInteger(l.f) && l.f <= mark.frame) seed = l.seed;
  }
  const expectedDoc = await readJson(join(markDir, "expected.json"));
  const stateDoc = await readJson(join(markDir, "state.json"));
  const expected = expectedDoc && expectedDoc.state !== undefined
    ? { v: 1, source: "expected.json", frame: mark.frame, acceptedAt: expectedDoc.acceptedAt ?? null, state: expectedDoc.state }
    : stateDoc != null ? { v: 1, source: "state.json", frame: mark.frame, state: stateDoc } : null;
  if (!expected) throw new Refusal(`mark ${mark.id} has no state.json: nothing to compare against`);

  let pagePath = "/index.html";
  try { pagePath = new URL(env.game.url).pathname || "/index.html"; } catch {}
  const tapeDoc = {
    v: 1, kind: "snapper-repro-tape", host: SNAPPER_VERSION, session: session.id, mark: mark.id, markFrame: mark.frame,
    segment: seg.index, query: q.query, querySource: q.source, pauseParam, keymap, seed,
    page: pagePath, openQuery: openQuery(q.query, pauseParam), frames,
  };

  await mkdir(dir, { recursive: true });
  const files = [];
  const put = async (name, data) => { await writeFile(join(dir, name), data); files.push(name); };
  await copyFile(SDK, join(dir, "snapper-sdk.js")); files.push("snapper-sdk.js");
  await copyFile(DRIVER, join(dir, "driver.js")); files.push("driver.js");
  await put("tape.json", tapeJson(tapeDoc));
  await put("expected.json", JSON.stringify(expected, null, 2) + "\n");

  let gameDir = null;
  const coi = env.config?.crossOriginIsolated === true;
  if (inject) {
    if (!String(env.game?.url || "").startsWith("http://127.0.0.1:")) {
      throw new Refusal(`--inject needs a session played from a game folder; this one loaded ${env.game?.url} (use the console method in ${join(dir, "README.md")})`);
    }
    const root = await sessionGameRoot(p.sessionDir, env);
    if (!root) throw new Refusal(`--inject: the game root ${env.game?.root} does not exist on this machine`);
    const page = join(root, ...pagePath.split("/").filter(Boolean));
    if (!existsSync(page) || !statSync(page).isFile()) throw new Refusal(`--inject: ${page} not found (the game has no ${pagePath}); use the console method in ${join(dir, "README.md")}`);
    gameDir = join(dir, "repro-game");
    const outAbs = resolve(dir);
    await cp(root, gameDir, {
      recursive: true, force: true,
      filter: src => {
        const rel = relative(root, src);
        if (!rel) return true;
        if (rel.split(sep).some(part => COPY_SKIP.has(part))) return false;
        const abs = resolve(src);
        return abs !== outAbs && !abs.startsWith(outAbs + sep);              // never copy the repro folder into itself
      },
    });
    const reproIn = join(gameDir, "repro");
    await mkdir(reproIn, { recursive: true });
    for (const f of ["snapper-sdk.js", "driver.js", "tape.json", "expected.json"]) await copyFile(join(dir, f), join(reproIn, f));
    const gamePage = join(gameDir, ...pagePath.split("/").filter(Boolean));
    const depth = pagePath.split("/").filter(Boolean).length - 1;
    await writeFile(gamePage, injectTags(await readFile(gamePage, "utf8"), "../".repeat(depth) + "repro/"));
    files.push("repro-game/");
  }
  await put("README.md", readme({ dir, mark, session, tapeDoc, expected, gameDir, pagePath, coi }));
  return { dir, files, gameDir, page: pagePath, url: `http://127.0.0.1:<port>${pagePath}${tapeDoc.openQuery}` };
}

function readme({ dir, mark, session, tapeDoc, expected, gameDir, pagePath, coi }) {
  const L = [];
  const open = `${pagePath}${tapeDoc.openQuery}`;
  L.push(`# No-Snapper repro of mark ${mark.id}`, "");
  L.push(`Session ${session.id}, mark ${mark.id} (${mark.trigger}${mark.note ? `: "${String(mark.note).replace(/\s+/g, " ").slice(0, 120)}"` : ""}), frame ${mark.frame}.`);
  L.push(`This folder replays the mark's recorded inputs in a stock browser with no Snapper present: no Snapper host, no preload,`
    + ` no DevTools protocol. The only Snapper code in the page is the SDK (\`snapper-sdk.js\`, the same file the host injects;`
    + ` it is what lets the game register its stepper) and \`driver.js\`, which feeds \`tape.json\` (${tapeDoc.frames.length} input changes,`
    + ` frames 0 to ${tapeDoc.markFrame}) through the game's own \`step()\` and compares the state at frame ${tapeDoc.markFrame} with`
    + ` \`expected.json\` (from the mark's ${expected.source}; the top-level \`perf\` key is ignored, as in \`snapper replay\`).`, "");
  L.push("It prints `REPRO: match at frame N` or `REPRO: differs $.path (…)` in the browser console and in a box at the bottom left of the page.", "");
  L.push("## 1. The ready-made copy (`repro-game/`)", "");
  if (gameDir) {
    L.push("`repro-game/` is a copy of the game with two script tags added to its page (the SDK, then the driver, before the game's first module script) and this folder as `repro-game/repro/`.", "");
    L.push("```", `snapper serve "${gameDir}"${coi ? " --coi" : ""}`, "```", "");
    L.push(`Then open \`http://127.0.0.1:<port>${open}\` in Chrome, Edge or Firefox (the port is printed by \`snapper serve\`; any static server works).`, "");
  } else {
    L.push("Not written: run `snapper export-repro` again with `--inject` to get a patched copy of the game here.", "");
  }
  L.push("## 2. Any served copy of the game (the console method)", "");
  L.push("1. Put this folder under the game's root as `repro/`.");
  L.push("2. Load the SDK before the game: add `<script src=\"/repro/snapper-sdk.js\"></script>` before the game's first script in its page (a game registers its stepper only when `window.snapper` exists at boot; a game that imports the SDK itself needs nothing).");
  L.push(`3. Open the game paused: \`${pagePath}?${[String(tapeDoc.query || "").replace(/^[?&]+/, ""), tapeDoc.pauseParam].filter(Boolean).join("&")}\`.`);
  L.push("4. In the browser's DevTools console: `import(\"/repro/driver.js\").then(m => m.run())` (or add `&snapper-repro=1` to the URL and it runs by itself).", "");
  L.push("## What the result means", "");
  L.push(`- **match**: the game's own code, given the same inputs from the same boot (${tapeDoc.query ? `query \`${tapeDoc.query}\`, ` : ""}paused, frame 0), reached the same state at frame ${tapeDoc.markFrame} with no Snapper host present. Whatever is in that state was not put there by Snapper's capture.`);
  L.push("- **differs**: the state is not the same. That does not prove Snapper caused the bug: the game may read wall-clock time or an unseeded random number in its simulation, load a level by fetch timing, depend on the window size, or the code may have changed since the session (compare the git sha in the session's env.json). `snapper replay` and `snapper check` on the same code tell you whether Snapper's own replay agrees.");
  L.push(`- A game that does not honour \`?${tapeDoc.pauseParam}\` (boot paused) cannot be driven.`, "");
  L.push("## Files", "");
  L.push("- `tape.json`: `frames` = run-length input lines `{ f, m }` (bit i of `m` = `keymap[i]` held from frame f), `query`, `pauseParam`, `keymap`, `seed` (as the game reported it), `markFrame`.");
  L.push("- `expected.json`: `{ source, frame, state }`.");
  L.push("- `snapper-sdk.js`, `driver.js`: MIT.", "");
  return L.join("\n");
}

export async function run({ positional = [], flags = {} }) {
  const [sessionArg, markArg] = positional;
  if (!sessionArg || markArg === undefined) { err(USAGE); return 2; }
  if (flags.out === true) { err("--out needs a folder"); return 2; }
  try {
    const r = await exportRepro({ sessionDir: sessionArg, markId: String(markArg), out: flags.out || null, inject: flags.inject === true || flags.inject === "true" });
    for (const f of r.files) process.stdout.write(`wrote ${join(r.dir, f)}\n`);
    if (r.gameDir) process.stdout.write(`serve it: snapper serve "${r.gameDir}"  then open ${r.url}\n`);
    process.stdout.write(`${r.dir}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) { err(e.message); return 2; }
    err(e && e.stack || String(e));
    return 1;
  }
}

