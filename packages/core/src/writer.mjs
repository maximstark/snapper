// Session writer. session.jsonl and tape.jsonl are append-only: this module has no API that
// rewrites them. env.json and SESSION.md are written atomically (temp file + rename).
import { mkdir, appendFile, writeFile, rename, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { sessionIdFor, isoLocal, markId, round1 } from "./time.mjs";
import { toJsonl } from "./jsonl.mjs";
import { readSession } from "./reader.mjs";
import { renderSessionMd } from "./render.mjs";
import { renderSessionHtml } from "./report.mjs";      // (report → writer → report: a cycle used only at call time)

const exists = p => access(p).then(() => true, () => false);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Write `data` to `path` through a temp file and a rename (retried: Windows readers can hold the file). */
export async function atomicWrite(path, data) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, data);
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await sleep(25 + i * 10);
    }
  }
}

const isPlainObject = v => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);

export function deepMerge(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function serialise(data) {
  if (typeof data === "string" || data instanceof Uint8Array) return data;
  return JSON.stringify(data, null, 2) + "\n";
}

/**
 * Create `<out>/<slug>/<session-id>/` and return a writer.
 * `now` is the clock for `t` (ms, monotonic); the session starts at the clock's value at creation.
 */
export async function createSessionWriter({ out, slug, startedAt = new Date(), now = () => performance.now() }) {
  if (!out || !slug) throw new Error("createSessionWriter: out and slug are required");
  const base = join(out, slug);
  let id = sessionIdFor(startedAt);
  let dir = join(base, id);
  for (let n = 2; await exists(dir); n++) {         // two sessions in the same second: suffix, never overwrite
    id = `${sessionIdFor(startedAt)}-${n}`;
    dir = join(base, id);
  }
  await mkdir(join(dir, "marks"), { recursive: true });
  return new SessionWriter({ dir, id, slug, startedAt, now });
}

export class SessionWriter {
  constructor({ dir, id, slug, startedAt, now }) {
    this.dir = dir;
    this.id = id;
    this.slug = slug;
    this.startedAt = startedAt;
    this.startedAtIso = isoLocal(startedAt);
    this.now = now;
    this.t0 = now();
    this.sessionPath = join(dir, "session.jsonl");
    this.tapePath = join(dir, "tape.jsonl");
    this.envPath = join(dir, "env.json");
    this.summaryPath = join(dir, "SESSION.md");
    this.env = null;
    this.lines = [];                                 // in-memory copy of session.jsonl, in order
    this.markCount = 0;
    this.errors = [];
    this._queue = Promise.resolve();                 // serialises every file operation, in call order
    this._failures = [];
  }

  /** ms since session start, one decimal. */
  t() {
    return round1(this.now() - this.t0);
  }

  _enqueue(fn) {
    const p = this._queue.then(fn);
    this._queue = p.catch(err => { this._failures.push(err); });
    return p;
  }

  /** Append one session.jsonl line `{kind, t, ...fields}` and return it. `t` defaults to now. */
  line(kind, fields = {}, t) {
    const obj = { kind, t: t ?? this.t(), ...fields };
    this.lines.push(obj);
    const s = toJsonl(obj);
    this._enqueue(() => appendFile(this.sessionPath, s));
    return obj;
  }

  /** Append one tape.jsonl line (any object). */
  tape(obj) {
    const s = toJsonl(obj);
    this._enqueue(() => appendFile(this.tapePath, s));
    return obj;
  }

  /** Append many tape lines in one write. */
  tapeMany(objs) {
    if (!objs.length) return;
    const s = objs.map(toJsonl).join("");
    this._enqueue(() => appendFile(this.tapePath, s));
  }

  /** Write env.json (whole). */
  writeEnv(env) {
    this.env = env;
    const s = JSON.stringify(env, null, 2) + "\n";
    return this._enqueue(() => atomicWrite(this.envPath, s));
  }

  /** Deep-merge a patch into env.json and rewrite it atomically. */
  patchEnv(patch) {
    this.env = deepMerge(this.env || {}, patch);
    const s = JSON.stringify(this.env, null, 2) + "\n";
    return this._enqueue(() => atomicWrite(this.envPath, s));
  }

  /** Allocate the next mark id ("0001", …). */
  nextMarkId() {
    this.markCount += 1;
    return markId(this.markCount);
  }

  /** Relative and absolute folder of a mark. */
  markRel(id) {
    return `marks/${id}`;
  }
  markPath(id, ...rest) {
    return join(this.dir, "marks", id, ...rest);
  }

  /** Create marks/<id>/ and, unless `before` is false (a --bare session has no ring buffer, v1.3), marks/<id>/before/. */
  async makeMarkDir(id, { before = true } = {}) {
    await mkdir(before ? this.markPath(id, "before") : this.markPath(id), { recursive: true });
    return this.markPath(id);
  }

  /**
   * Write a file inside a mark folder. Strings and buffers are written as is; anything else as
   * pretty JSON. Not queued behind the JSONL appends: mark files are independent.
   */
  async writeMarkFile(id, rel, data) {
    const p = this.markPath(id, ...rel.split("/"));
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, serialise(data));
    return p;
  }

  /** Wait for every queued append/env write. Throws the first failure, if any. */
  async flush() {
    await this._queue;
    if (this._failures.length) {
      const err = this._failures[0];
      this._failures = [];
      throw err;
    }
  }

  /** Regenerate SESSION.md from the files on disk (atomic). */
  renderSummary() {
    return this._enqueue(async () => {
      const s = await readSession(this.dir);
      await atomicWrite(this.summaryPath, renderSessionMd(s));
    });
  }

  /** Regenerate SESSION.html (derived, v1.4) from the files on disk (atomic). The host calls it at session end. */
  renderReport() {
    return this._enqueue(async () => {
      const s = await readSession(this.dir);
      await atomicWrite(join(this.dir, "SESSION.html"), renderSessionHtml(s));
    });
  }

  async close() {
    await this.flush();
  }
}

/** Regenerate SESSION.md and SESSION.html (v1.4) for any session folder. Returns the markdown. */
export async function writeSummary(dir) {
  const s = await readSession(dir);
  const md = renderSessionMd(s);
  await atomicWrite(join(dir, "SESSION.md"), md);
  await atomicWrite(join(dir, "SESSION.html"), renderSessionHtml(s));
  return md;
}
