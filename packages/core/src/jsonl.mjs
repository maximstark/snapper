// Tolerant JSONL parsing: a live session may end in a half-written line, and readers
// must skip anything they cannot parse instead of failing.

export function parseJsonl(text) {
  const lines = [];
  let bad = 0;
  for (const raw of String(text || "").split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v)) lines.push(v);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { lines, bad };
}

export const toJsonl = obj => JSON.stringify(obj) + "\n";
