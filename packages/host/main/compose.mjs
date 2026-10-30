// Hidden compose window: re-encodes ring-buffer frames with the overlay rectangles blacked (D-015)
// and composes the contact sheet, so the game's renderer does no extra work at a mark.
import { BrowserWindow } from "electron";
import { composeSheetSource } from "../../core/index.mjs";

/**
 * tiles: [{ src: jpeg data URL, label, rects: [{x,y,w,h}] (source px) }]
 * Resolves { frames: [base64 jpeg | null] (null = unchanged), sheet: PNG data URL | null }.
 * compose(tiles, timeoutMs, { columns = 6, tileW = 320 }) (v1.2: the replay runner composes 6 or 10 columns here).
 */
const SCRIPT = (tiles, columns = 6, tileW = 320) => `(async () => {
  const tiles = ${JSON.stringify(tiles)};
  const compose = ${composeSheetSource};
  const load = src => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
  const frames = [], sheetTiles = [];
  for (const t of tiles) {
    let src = t.src, changed = null;
    if (t.rects && t.rects.length) {
      const im = await load(src);
      if (im) {
        const cv = document.createElement("canvas");
        cv.width = im.naturalWidth; cv.height = im.naturalHeight;
        const g = cv.getContext("2d");
        g.drawImage(im, 0, 0);
        g.fillStyle = "#000";
        for (const r of t.rects) g.fillRect(r.x, r.y, r.w, r.h);
        src = cv.toDataURL("image/jpeg", 0.85);
        changed = src.slice(src.indexOf(",") + 1);
      }
    }
    frames.push(changed);
    sheetTiles.push({ src, label: t.label });
  }
  // Every tile must decode before composing (a flaky decode would leave a blank tile): retry briefly.
  let bad = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    bad = [];
    for (let i = 0; i < sheetTiles.length; i++) if (!(await load(sheetTiles[i].src))) bad.push(i);
    if (!bad.length) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const sheet = await compose(sheetTiles, { columns: ${Number(columns) || 6}, tileW: ${Number(tileW) || 320} });
  return { frames, sheet, bad };
})()`;

export function createComposer() {
  let win = null;
  const ensure = async () => {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false, width: 800, height: 600, skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    await win.loadURL("about:blank");
    return win;
  };
  return {
    warm: () => ensure().catch(() => {}),
    async compose(tiles, timeoutMs = 20000, { columns = 6, tileW = 320 } = {}) {
      const w = await ensure();
      const run = w.webContents.executeJavaScript(SCRIPT(tiles, columns, tileW), true);
      return await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error("compose timeout")), timeoutMs))]);
    },
    destroy() { try { if (win && !win.isDestroyed()) win.destroy(); } catch {} },
  };
}
