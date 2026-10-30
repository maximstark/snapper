// Minimal dependency-free PNG reading and writing (8-bit, non-interlaced), for verification
// scripts, tests and the replay runner. Not a general decoder.
import { inflateSync, deflateSync, crc32 } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 24 && buf.subarray(0, 8).equals(SIG);
}

/** { w, h } from IHDR, or null. */
export function pngSize(buf) {
  if (!isPng(buf)) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Decode to { w, h, data: Uint8Array RGBA }. Supports colour types 0, 2, 4, 6 at 8 bits, no interlace. */
export function decodePng(buf) {
  if (!isPng(buf)) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; ctype = body[9]; interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(ctype)) {
    throw new Error(`unsupported PNG (depth ${depth}, colour type ${ctype}, interlace ${interlace})`);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = new Uint8Array(stride * h);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += bpp) {
    const o = i * 4;
    if (ctype === 6) { data[o] = px[j]; data[o + 1] = px[j + 1]; data[o + 2] = px[j + 2]; data[o + 3] = px[j + 3]; }
    else if (ctype === 2) { data[o] = px[j]; data[o + 1] = px[j + 1]; data[o + 2] = px[j + 2]; data[o + 3] = 255; }
    else if (ctype === 4) { data[o] = data[o + 1] = data[o + 2] = px[j]; data[o + 3] = px[j + 1]; }
    else { data[o] = data[o + 1] = data[o + 2] = px[j]; data[o + 3] = 255; }
  }
  return { w, h, data };
}

/** Encode RGBA to PNG (filter 0). */
export function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Quick stats: { w, h, meanLuma (0..255), nonBlack (fraction of pixels with luma > 8), distinct (sampled colours, capped) }. */
export function pngStats(buf) {
  const { w, h, data } = decodePng(buf);
  let sum = 0, nonBlack = 0;
  const colours = new Set();
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const l = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    sum += l;
    if (l > 8) nonBlack++;
    if (colours.size < 4096 && (i & 7) === 0) colours.add((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
  }
  return { w, h, meanLuma: n ? sum / n : 0, nonBlack: n ? nonBlack / n : 0, distinct: colours.size };
}

/** Decode a `data:image/png;base64,…` URL to a Buffer (null when it is not one). */
export function dataUrlToBuffer(url) {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.*)$/s.exec(String(url || ""));
  return m ? Buffer.from(m[2], "base64") : null;
}
