// Renders the Snapper icon: 512x512 RGBA PNG, no dependencies (core's encodePng).
// A dark rounded square, a bright aperture ring (six shutter gaps) and the letter S, 4x4 supersampled.
//   node scripts/make-icon.mjs   → build/icon.png and packages/host/launcher/icon.png
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "../packages/core/index.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const N = 512, SS = 4;
const C = 256;

const BG_TOP = [0x1c, 0x22, 0x33], BG_BOT = [0x0e, 0x11, 0x18];
const RING = [0x4f, 0xd8, 0xff], LETTER = [0xf6, 0xf8, 0xff];

// rounded square: half-size 240 (inset 16), corner radius 104
function inSquare(x, y) {
  const h = 240, r = 104;
  const dx = Math.abs(x - C) - (h - r), dy = Math.abs(y - C) - (h - r);
  if (dx <= 0 || dy <= 0) return Math.abs(x - C) <= h && Math.abs(y - C) <= h;
  return dx * dx + dy * dy <= r * r;
}

// aperture ring with six radial shutter gaps
function inRing(x, y) {
  const dx = x - C, dy = y - C, r = Math.hypot(dx, dy);
  if (r < 150 || r > 190) return false;
  for (let k = 0; k < 6; k++) {
    const a = (15 + 60 * k) * Math.PI / 180;
    const along = dx * Math.cos(a) + dy * Math.sin(a);
    const perp = -dx * Math.sin(a) + dy * Math.cos(a);
    if (along > 0 && Math.abs(perp) < 7) return false;
  }
  return true;
}

// the S: two stroked arcs (y down; angles in degrees, increasing clockwise on screen)
const R = 48, W = 32, UP = [C, 208], LO = [C, 304];
const inArc = (x, y, [cx, cy], a0, a1) => {
  const dx = x - cx, dy = y - cy;
  if (Math.abs(Math.hypot(dx, dy) - R) <= W / 2) {
    let a = Math.atan2(dy, dx) * 180 / Math.PI; if (a < 0) a += 360;
    let t = a - a0; if (t < 0) t += 360;
    if (t <= ((a1 - a0 + 360) % 360)) return true;
  }
  for (const e of [a0, a1]) {                               // round caps
    const ex = cx + R * Math.cos(e * Math.PI / 180), ey = cy + R * Math.sin(e * Math.PI / 180);
    if (Math.hypot(x - ex, y - ey) <= W / 2) return true;
  }
  return false;
};
const inS = (x, y) => inArc(x, y, UP, 90, 330) || inArc(x, y, LO, 270, 150);

const px = new Uint8Array(N * N * 4);
for (let py = 0; py < N; py++) {
  for (let pxx = 0; pxx < N; pxx++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = pxx + (sx + 0.5) / SS, y = py + (sy + 0.5) / SS;
        if (!inSquare(x, y)) continue;
        const t = (y - 16) / 480;
        let col = BG_TOP.map((v, i) => v + (BG_BOT[i] - v) * t);
        if (inRing(x, y)) col = RING;
        if (inS(x, y)) col = LETTER;
        r += col[0]; g += col[1]; b += col[2]; a++;
      }
    }
    const o = (py * N + pxx) * 4;
    if (a) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
    px[o + 3] = Math.round(255 * a / (SS * SS));
  }
}

const png = encodePng(N, N, px);
for (const rel of ["build/icon.png", "packages/host/launcher/icon.png"]) {
  const file = join(REPO, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, png);
  process.stdout.write(`wrote ${rel} (${png.length} bytes)\n`);
}
