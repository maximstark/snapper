// core zip.mjs (v1.4): CRC-32, write/read round trips, store + deflate, interop with Windows' tar -xf (bsdtar), refusals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { crc32, writeZip, zipDir, readZip, readZipEntry, extractZip, safeEntryName, listTree } from "../../packages/core/src/zip.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "snapper-zip-"));
// Windows' own bsdtar (System32), never Git's GNU tar that may come first on PATH (it cannot read zip archives).
const TAR = join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe");
const hasTar = existsSync(TAR);

test("crc32 matches the reference values", () => {
  assert.equal(crc32(Buffer.from("")), 0);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.from("456789"), crc32(Buffer.from("123"))), 0xcbf43926);
});

test("safeEntryName refuses absolute, drive, backslash and .. names", () => {
  for (const ok of ["a.txt", "a/b/c.json", "dir/"]) assert.equal(safeEntryName(ok), true, ok);
  for (const bad of ["", "/abs", "C:/x", "a\\b", "../x", "a/../b", "a//b", "./a"]) assert.equal(safeEntryName(bad), false, bad);
});

test("zipDir → readZip / extractZip round trip; deflate when it shrinks, store otherwise; never zips itself", async () => {
  const d = tmp();
  try {
    const src = join(d, "src");
    mkdirSync(join(src, "marks", "0001"), { recursive: true });
    writeFileSync(join(src, "session.jsonl"), '{"kind":"session","v":1}\n'.repeat(200));
    writeFileSync(join(src, "marks", "0001", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    writeFileSync(join(src, "empty.txt"), "");
    writeFileSync(join(src, "ünïcode.txt"), "名前");
    mkdirSync(join(src, "outbox"));
    const out = join(src, "outbox", "self.zip");
    const r = await zipDir(src, out, { prefix: "2026-10-21T10-00-00", exclude: rel => rel === "outbox" });
    assert.equal(r.entries, 4);
    const list = await readZip(out);
    const names = list.map(e => e.name).sort();
    assert.deepEqual(names, ["2026-10-21T10-00-00/empty.txt", "2026-10-21T10-00-00/marks/0001/shot.png", "2026-10-21T10-00-00/session.jsonl", "2026-10-21T10-00-00/ünïcode.txt"]);
    assert.equal(list.find(e => e.name.endsWith("session.jsonl")).method, 8, "text deflated");
    assert.equal(list.find(e => e.name.endsWith("shot.png")).method, 0, "png stored");
    assert.equal((await readZipEntry(out, "2026-10-21T10-00-00/ünïcode.txt")).toString("utf8"), "名前");
    const dest = join(d, "x");
    const written = await extractZip(out, dest, { strip: 1 });
    assert.equal(written.length, 4);
    assert.equal(readFileSync(join(dest, "session.jsonl"), "utf8"), '{"kind":"session","v":1}\n'.repeat(200));
    assert.equal(readFileSync(join(dest, "empty.txt")).length, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("interop: Windows tar -xf extracts what writeZip wrote, byte for byte", { skip: !hasTar && "no System32 tar.exe" }, async () => {
  const d = tmp();
  try {
    const big = Buffer.alloc(300000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 7)) & 0xff;
    const out = join(d, "t.zip");
    await writeZip(out, [
      { name: "game/index.html", data: "<!doctype html><title>x</title>" },
      { name: "game/vendor/lib.js", data: "var x = 1;\n".repeat(5000) },
      { name: "game/blob.bin", data: big },
      { name: "PLAY.cmd", data: "@echo off\r\necho hi\r\n" },
    ]);
    const dest = join(d, "tar");
    mkdirSync(dest);
    execFileSync(TAR, ["-xf", out, "-C", dest], { stdio: "pipe" });
    assert.equal(readFileSync(join(dest, "game", "index.html"), "utf8"), "<!doctype html><title>x</title>");
    assert.equal(readFileSync(join(dest, "game", "vendor", "lib.js"), "utf8"), "var x = 1;\n".repeat(5000));
    assert.ok(readFileSync(join(dest, "game", "blob.bin")).equals(big));
    assert.equal(readFileSync(join(dest, "PLAY.cmd"), "utf8"), "@echo off\r\necho hi\r\n");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("refusals: unsafe and duplicate names; a corrupt entry fails its CRC; unsafe archives extract nothing", async () => {
  const d = tmp();
  try {
    await assert.rejects(writeZip(join(d, "a.zip"), [{ name: "../evil", data: "x" }]), /unsafe entry name/);
    await assert.rejects(writeZip(join(d, "a.zip"), [{ name: "a", data: "x" }, { name: "a", data: "y" }]), /duplicate entry/);
    const ok = join(d, "ok.zip");
    await writeZip(ok, [{ name: "a.txt", data: "hello hello hello hello hello hello hello hello hello hello hello hello" }], { level: 0 });
    const buf = readFileSync(ok);
    const i = buf.indexOf("hello");
    buf[i] = "j".charCodeAt(0);
    writeFileSync(join(d, "bad.zip"), buf);
    await assert.rejects(extractZip(join(d, "bad.zip"), join(d, "out")), /corrupt/);
    await assert.rejects(readZip(join(d, "nothing.zip")), /ENOENT/);
    writeFileSync(join(d, "notzip.zip"), "plain text");
    await assert.rejects(readZip(join(d, "notzip.zip")), /not a zip/);
    assert.equal(existsSync(join(d, "out", "a.txt")), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("listTree honours exclude for whole subtrees", async () => {
  const d = tmp();
  try {
    mkdirSync(join(d, "node_modules", "x"), { recursive: true });
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "node_modules", "x", "i.js"), "");
    writeFileSync(join(d, "src", "a.js"), "");
    writeFileSync(join(d, "index.html"), "");
    assert.deepEqual(await listTree(d, rel => rel === "node_modules"), ["index.html", "src/a.js"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
