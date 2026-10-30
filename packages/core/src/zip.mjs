// Minimal zip writer and reader (v1.4, D-028; BRIEF-v1.4 §3.1). MIT, pure Node (zlib), no dependency.
// Write: store or deflate per entry (deflate only when it shrinks the data), CRC-32 by table, sizes known before the
// local header is written (no data descriptors), UTF-8 names (flag bit 11). No Zip64: refuses an archive or entry at or
// above 4 GiB and more than 65,535 entries. Read: the central directory, then each local header; CRC-checked on extract.
// Interop is tested against Windows' own `tar -xf` (bsdtar).
import { open, mkdir, readdir, stat, rm } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { deflateRaw as deflateRawCb, inflateRawSync } from "node:zlib";

const deflateRaw = promisify(deflateRawCb);
const LIMIT = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const STORE_EXT = /\.(png|jpe?g|gif|webp|zip|gz|7z|mp3|mp4|ogg|webm|woff2?)$/i;

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE) of a buffer, or continue a running one (`crc` from a previous call). */
export function crc32(buf, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Pure: is `name` a safe relative entry name (forward slashes, no "..", not absolute, no drive)? */
export function safeEntryName(name) {
  const n = String(name ?? "");
  if (!n || n.includes("\0") || n.includes("\\") || n.startsWith("/") || /^[A-Za-z]:/.test(n)) return false;
  return n.split("/").every((p, i, a) => p !== ".." && p !== "." && (p !== "" || i === a.length - 1));
}

/**
 * Write a zip. entries: [{ name: "dir/file.txt", data: Buffer | string } | { name, file: <absolute path> }] (directories
 * are implied by the names). opts: { level (zlib 0-9, default 6; 0 = store everything), mtime (Date for every entry) }.
 * Returns { file, entries, bytes }. Throws Error(message) on an unsafe name, a duplicate, or the 4 GiB / 65,535 limits.
 */
export async function writeZip(outFile, entries, { level = 6, mtime = null } = {}) {
  if (entries.length > MAX_ENTRIES) throw new Error(`zip: ${entries.length} entries; at most ${MAX_ENTRIES} without Zip64`);
  const seen = new Set();
  for (const e of entries) {
    if (!safeEntryName(e.name)) throw new Error(`zip: unsafe entry name ${JSON.stringify(e.name)}`);
    if (seen.has(e.name)) throw new Error(`zip: duplicate entry ${e.name}`);
    seen.add(e.name);
  }
  await mkdir(dirname(resolve(outFile)), { recursive: true });
  const tmp = `${outFile}.${process.pid}.tmp`;
  const fh = await open(tmp, "w");
  const central = [];
  let offset = 0;
  try {
    for (const e of entries) {
      let data, when = mtime;
      if (e.file) {
        const st = await stat(e.file);
        if (st.size >= LIMIT) throw new Error(`zip: ${e.name} is ${st.size} bytes; files of 4 GiB or more need Zip64`);
        const rh = await open(e.file, "r");
        try { data = Buffer.alloc(st.size); if (st.size) await rh.read(data, 0, st.size, 0); } finally { await rh.close(); }
        when ||= st.mtime;
      } else data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ""), "utf8");
      const crc = crc32(data);
      let method = 0, body = data;
      if (level > 0 && data.length > 64 && !STORE_EXT.test(e.name)) {
        const z = await deflateRaw(data, { level });
        if (z.length < data.length) { method = 8; body = z; }
      }
      const name = Buffer.from(e.name, "utf8");
      const { time, date } = dosTime(when || new Date());
      if (offset + 30 + name.length + body.length >= LIMIT) throw new Error("zip: the archive would reach 4 GiB; Zip64 is not supported");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(SIG_LOCAL, 0);
      local.writeUInt16LE(20, 4);                    // version needed
      local.writeUInt16LE(0x0800, 6);                // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      await fh.write(local, 0, 30, offset);
      await fh.write(name, 0, name.length, offset + 30);
      if (body.length) await fh.write(body, 0, body.length, offset + 30 + name.length);
      central.push({ name, method, time, date, crc, csize: body.length, size: data.length, offset });
      offset += 30 + name.length + body.length;
    }
    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(20, 4);                         // version made by (MS-DOS, 2.0)
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.csize, 20);
      h.writeUInt32LE(c.size, 24);
      h.writeUInt16LE(c.name.length, 28);
      h.writeUInt32LE(c.offset, 42);
      await fh.write(h, 0, 46, offset);
      await fh.write(c.name, 0, c.name.length, offset + 46);
      offset += 46 + c.name.length;
    }
    if (offset >= LIMIT) throw new Error("zip: the archive would reach 4 GiB; Zip64 is not supported");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    await fh.write(end, 0, 22, offset);
    offset += 22;
  } catch (e) {
    await fh.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await fh.close();
  await rm(outFile, { force: true }).catch(() => {});
  const { rename } = await import("node:fs/promises");
  await rename(tmp, outFile);
  return { file: resolve(outFile), entries: central.length, bytes: offset };
}

/** Every file under `dir` as [relative path with forward slashes], sorted; `exclude(rel, isDir)` → true skips it (and a directory's subtree). */
export async function listTree(dir, exclude = () => false, base = "") {
  const out = [];
  let ents;
  try { ents = await readdir(join(dir, ...base.split("/").filter(Boolean)), { withFileTypes: true }); } catch { return out; }
  ents.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of ents) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (exclude(rel, e.isDirectory())) continue;
    if (e.isDirectory()) out.push(...await listTree(dir, exclude, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Zip a folder: every file under `dir` as `<prefix><relative path>`. opts: { prefix ("" or "name/"), exclude(rel, isDir),
 * level }. Returns { file, entries, bytes }. An output file inside `dir` is excluded automatically (never zips itself).
 */
export async function zipDir(dir, outFile, { prefix = "", exclude = () => false, level = 6 } = {}) {
  const root = resolve(dir), out = resolve(outFile);
  const selfRel = out.startsWith(root + sep) ? out.slice(root.length + 1).split(sep).join("/") : null;
  const files = await listTree(root, (rel, isDir) => exclude(rel, isDir) || rel === selfRel || (selfRel && rel === selfRel + `.${process.pid}.tmp`));
  const p = prefix && !prefix.endsWith("/") ? prefix + "/" : prefix;
  return writeZip(out, files.map(rel => ({ name: p + rel, file: join(root, ...rel.split("/")) })), { level });
}

/** The central directory of a zip: [{ name, method, crc, size, compressedSize, offset }]. Throws Error on a bad archive. */
export async function readZip(file) {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let at = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_END) { at = i; break; }
    if (at < 0) throw new Error(`not a zip file (no end of central directory): ${file}`);
    const count = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOff = tail.readUInt32LE(at + 16);
    if (cdOff === LIMIT || count === MAX_ENTRIES && cdSize === LIMIT) throw new Error("zip: Zip64 archives are not supported");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    const out = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("zip: corrupt central directory");
      const method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20), sz = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nl);
      out.push({ name, method, crc, size: sz, compressedSize, offset });
      p += 46 + nl + xl + cl;
    }
    return out;
  } finally { await fh.close(); }
}

async function entryData(fh, e) {
  const lh = Buffer.alloc(30);
  await fh.read(lh, 0, 30, e.offset);
  if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`zip: bad local header for ${e.name}`);
  const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const raw = Buffer.alloc(e.compressedSize);
  if (e.compressedSize) await fh.read(raw, 0, e.compressedSize, start);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = inflateRawSync(raw);
  else throw new Error(`zip: ${e.name} uses compression method ${e.method} (only store and deflate are supported)`);
  if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`zip: ${e.name} is corrupt (size or CRC mismatch)`);
  return data;
}

/** One entry's bytes (or null when the archive has no such entry). */
export async function readZipEntry(file, name) {
  const e = (await readZip(file)).find(x => x.name === name);
  if (!e) return null;
  const fh = await open(file, "r");
  try { return await entryData(fh, e); } finally { await fh.close(); }
}

/**
 * Extract a zip under `destDir`. opts: { filter(name) → bool, strip (leading path components to drop, default 0) }.
 * Refuses unsafe names (absolute, "..", backslashes) before writing anything. Returns [absolute paths written].
 */
export async function extractZip(file, destDir, { filter = () => true, strip = 0 } = {}) {
  const entries = (await readZip(file)).filter(e => filter(e.name));
  for (const e of entries) if (!safeEntryName(e.name)) throw new Error(`zip: unsafe entry name ${JSON.stringify(e.name)}; nothing extracted`);
  const dest = resolve(destDir);
  const written = [];
  const fh = await open(file, "r");
  try {
    for (const e of entries) {
      const parts = e.name.split("/").slice(strip);
      if (!parts.length || e.name.endsWith("/")) continue;
      const target = join(dest, ...parts);
      if (!target.startsWith(dest + sep)) throw new Error(`zip: ${e.name} escapes the destination`);
      const data = await entryData(fh, e);
      await mkdir(dirname(target), { recursive: true });
      const out = await open(target, "w");
      try { if (data.length) await out.write(data, 0, data.length, 0); } finally { await out.close(); }
      written.push(target);
    }
  } finally { await fh.close(); }
  return written;
}
