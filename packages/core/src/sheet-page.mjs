// Contact-sheet composition that runs INSIDE a browser page (a hidden Electron window, the
// compose window). It is self-contained so it can be serialised: pass
// `composeSheetSource` to page.evaluate / executeJavaScript and call it with (tiles, opts).
//
// tiles: [{ src: dataURL, label: string, mask?: [{x,y,w,h}] }]   mask rects are in source pixels
//        and are filled black (used to blank the overlay out of ring-buffer frames).
// opts:  { columns = 6, tileW = 320, background = "#111", labelH = 16 }
// returns: PNG data URL (or null when there are no tiles).

export async function composeSheet(tiles, opts = {}) {
  const columns = opts.columns || 6;
  const tileW = opts.tileW || 320;
  const labelH = opts.labelH ?? 16;
  const load = src => new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
  const imgs = await Promise.all((tiles || []).map(t => load(t.src)));
  if (!imgs.length) return null;
  const first = imgs.find(Boolean);
  const sw = first ? first.naturalWidth : 16, sh = first ? first.naturalHeight : 9;
  const scale = tileW / sw;
  const tileH = Math.max(1, Math.round(sh * scale));
  const rows = Math.ceil(imgs.length / columns);
  const cv = document.createElement("canvas");
  cv.width = columns * tileW;
  cv.height = rows * (tileH + labelH);
  const g = cv.getContext("2d");
  g.fillStyle = opts.background || "#111";
  g.fillRect(0, 0, cv.width, cv.height);
  g.imageSmoothingEnabled = scale < 1;
  g.font = "12px ui-monospace, Consolas, monospace";
  g.textBaseline = "middle";
  imgs.forEach((im, i) => {
    const x = (i % columns) * tileW, y = Math.floor(i / columns) * (tileH + labelH);
    if (im) g.drawImage(im, x, y, tileW, tileH);
    for (const r of tiles[i].mask || []) {
      g.fillStyle = "#000";
      g.fillRect(x + r.x * scale, y + r.y * scale, r.w * scale, r.h * scale);
    }
    g.fillStyle = "#ddd";
    g.fillText(String(tiles[i].label ?? i), x + 4, y + tileH + labelH / 2);
  });
  return cv.toDataURL("image/png");
}

/** Source text of composeSheet as an expression, for evaluate(). */
export const composeSheetSource = `(${composeSheet.toString()})`;
