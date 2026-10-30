// Electron main script (tests and gates only): open a file:// (or any) page in a plain, VISIBLE window with the network
// blocked, wait for its images, capture it with webContents.capturePage() at full resolution, write the PNG and a JSON
// report. Env: SNAPPER_SHOT_URL, SNAPPER_SHOT_OUT (png), SNAPPER_SHOT_INFO (json), SNAPPER_SHOT_WIDTH (default 1400).
import { app, BrowserWindow, session } from "electron";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.env.SNAPPER_SHOT_URL, OUT = process.env.SNAPPER_SHOT_OUT, INFO = process.env.SNAPPER_SHOT_INFO;
const WIDTH = Number(process.env.SNAPPER_SHOT_WIDTH) || 1400;
const userData = join(tmpdir(), "snapper-shot-" + process.pid);
try { mkdirSync(userData, { recursive: true }); app.setPath("userData", userData); } catch {}
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const blocked = [];
  const info = { url: URL_, ok: false };
  try {
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      if (/^(https?|wss?|ftp):/i.test(d.url)) { blocked.push(d.url); cb({ cancel: true }); } else cb({});
    });
    const win = new BrowserWindow({ width: WIDTH, height: 900, show: true, backgroundColor: "#ffffff", webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadURL(URL_);
    const js = code => win.webContents.executeJavaScript(code);
    // Images are loading="lazy": grow the window to the whole page so every one is in range, then wait (bounded) for them.
    for (let i = 0; i < 3; i++) {
      const height = await js("document.documentElement.scrollHeight");
      win.setContentSize(WIDTH, Math.max(300, Math.min(height, 6000)));
      await js(`Promise.race([new Promise(r => setTimeout(r, 8000)), Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })))])`);
    }
    await new Promise(r => setTimeout(r, 500));
    info.page = await js(`({
      title: document.title,
      scripts: document.scripts.length,
      images: [...document.images].map(i => ({ src: i.getAttribute("src"), complete: i.complete, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight })),
      scrollHeight: document.documentElement.scrollHeight,
      details: document.querySelectorAll("details").length,
    })`);
    const img = await win.webContents.capturePage();
    writeFileSync(OUT, img.toPNG());
    info.size = img.getSize();
    info.ok = true;
  } catch (e) {
    info.error = String(e && e.stack || e);
  }
  info.blocked = blocked;
  writeFileSync(INFO, JSON.stringify(info, null, 2));
  app.exit(info.ok ? 0 : 1);
});
