// No-cache static file server on 127.0.0.1 at a random free port (BRIEF §4.1, §4.4).
import { createServer } from "node:http";
import { stat, readFile } from "node:fs/promises";
import { join, normalize, resolve, sep, extname } from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};

/**
 * Serve `root`. Resolves to { url (origin, no trailing slash), port, close() }.
 * Paths outside root are 404; directories serve index.html.
 * coi: true adds cross-origin isolation headers to every response (200 and 404 alike), for pages that need
 * SharedArrayBuffer (Godot 4 web exports). Off by default: require-corp blocks cross-origin assets without CORP headers.
 */
export const COI_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export function serveStatic(root, { host = "127.0.0.1", port = 0, coi = false } = {}) {
  const base = resolve(root);
  const extra = coi ? COI_HEADERS : {};
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      let rel = decodeURIComponent(u.pathname);
      const p = normalize(join(base, rel));
      if (p !== base && !p.startsWith(base + sep)) { res.writeHead(404, { ...extra }).end(); return; }
      let file = p;
      let st = await stat(file).catch(() => null);
      if (st && st.isDirectory()) { file = join(file, "index.html"); st = await stat(file).catch(() => null); }
      if (!st || !st.isFile()) { res.writeHead(404, { "Cache-Control": "no-store", ...extra }).end("not found"); return; }
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        ...extra,
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (err) {
      res.writeHead(500, { ...extra }).end(String(err && err.message || err));
    }
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      const { port: p } = server.address();
      ok({ url: `http://${host}:${p}`, port: p, server, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}
