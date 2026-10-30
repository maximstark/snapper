// Regenerates packages/host/preload/preload.cjs: the Electron transport head + page.js embedded verbatim between the
// `// <page.js>` and `// </page.js>` marker lines + the one call. A sandboxed preload cannot require a local file, so the
// copy is generated and checked in (like packages/host/launcher/recipe.txt).
//   node scripts/make-preload.mjs           rewrite preload.cjs
//   node scripts/make-preload.mjs --check   exit 1 when preload.cjs differs from what would be written
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = fileURLToPath(new URL("../packages/host/preload/", import.meta.url));
export const OPEN = "// <page.js>";
export const CLOSE = "// </page.js>";

/** Pure: preload source with `page` embedded between the markers. */
export function embedPage(preload, page) {
  const a = preload.indexOf(OPEN + "\n"), b = preload.indexOf(CLOSE);
  if (a < 0 || b < 0 || b < a) throw new Error(`preload.cjs has no ${OPEN} / ${CLOSE} marker lines`);
  return preload.slice(0, a + OPEN.length + 1) + page.replace(/\n*$/, "\n") + preload.slice(b);
}

/** Pure: the text between the markers. */
export function embeddedPage(preload) {
  const a = preload.indexOf(OPEN + "\n"), b = preload.indexOf(CLOSE);
  if (a < 0 || b < 0 || b < a) return null;
  return preload.slice(a + OPEN.length + 1, b);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preloadFile = dir + "preload.cjs";
  const cur = readFileSync(preloadFile, "utf8");
  const next = embedPage(cur, readFileSync(dir + "page.js", "utf8"));
  if (process.argv.includes("--check")) {
    if (next !== cur) { process.stderr.write("preload.cjs differs from page.js: run node scripts/make-preload.mjs\n"); process.exit(1); }
    process.stdout.write("preload.cjs is in sync with page.js\n");
  } else {
    writeFileSync(preloadFile, next);
    process.stdout.write(`${preloadFile}: ${next === cur ? "already in sync" : "rewritten"}\n`);
  }
}
