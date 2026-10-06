/**
 * The evidence pull request's change (#11): the repository's `firestore.indexes.json` with the one index that was
 * created added to it, as a unified diff the existing opener (src/integrations/githubPr.ts) can apply and push. No
 * model writes it: the entry is `toIndexFileEntry(spec)`, the file is re-serialised as the Firebase CLI writes it
 * (two-space JSON), and the diff is checked here before it is returned:
 *
 *   - every index the file held is still there, in order, unchanged (the file is only ever added to: a file with an
 *     entry removed, deployed later, would delete that index);
 *   - the new file holds exactly the created spec;
 *   - every other top-level key (`fieldOverrides`...) is unchanged.
 *
 * The explanation that goes with it is a template too (`indexPullRequestText` in githubPr.ts), not model text.
 */
import { inIndexFile, toIndexFileEntry, type IndexSpec } from "./createIndexUrl.js";

/** A repository path for the index file: relative, plain segments, no `..`. */
export const INDEX_FILE_PATH_RE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.json$/;

const MAX_FILE_BYTES = 1_000_000;

export type IndexFilePatch =
  | { ok: true; patch: string; after: string; created: boolean }
  | { ok: false; rule: "already-present" | "unreadable" | "too-large" | "bad-path" | "self-check"; reason: string };

/** The longest common prefix and suffix, in lines, that do not overlap. */
function commonEnds(a: string[], b: string[]): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

const CONTEXT = 3;

/** Lines of a file, and whether it ends with a newline (the last line is then not an empty one). */
function lines(text: string): { lines: string[]; eol: boolean } {
  if (text === "") return { lines: [], eol: true };
  const eol = text.endsWith("\n");
  const body = eol ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), eol };
}

/** A one-hunk unified diff from `before` to `after` (a modification; `before` null is a new file). */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  const a = lines(before ?? "");
  const b = lines(after);
  const header =
    before === null
      ? [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`]
      : [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  const { prefix, suffix } = before === null ? { prefix: 0, suffix: 0 } : commonEnds(a.lines, b.lines);
  const start = Math.max(0, prefix - CONTEXT);
  const aEnd = Math.min(a.lines.length, a.lines.length - suffix + CONTEXT);
  const bEnd = Math.min(b.lines.length, b.lines.length - suffix + CONTEXT);
  const out: string[] = [];
  const noEol = "\\ No newline at end of file";
  const emit = (mark: string, text: string, isLast: boolean, eol: boolean) => {
    out.push(`${mark}${text}`);
    if (isLast && !eol) out.push(noEol);
  };
  for (let i = start; i < prefix; i++) emit(" ", a.lines[i]!, i === a.lines.length - 1, a.eol && b.eol);
  for (let i = prefix; i < a.lines.length - suffix; i++) emit("-", a.lines[i]!, i === a.lines.length - 1, a.eol);
  for (let i = prefix; i < b.lines.length - suffix; i++) emit("+", b.lines[i]!, i === b.lines.length - 1, b.eol);
  for (let i = a.lines.length - suffix; i < aEnd; i++) emit(" ", a.lines[i]!, i === a.lines.length - 1, a.eol);
  const range = (from: number, count: number) => (count === 0 ? `${from},0` : `${from + 1},${count}`);
  const hunk = `@@ -${range(start, aEnd - start)} +${range(start, bEnd - start)} @@`;
  return [...header, hunk, ...out, ""].join("\n");
}

/**
 * The diff that adds `spec` to the index file at `path`, whose current content is `before` (null: there is none, so
 * it is created). A file that already has the entry, or cannot be read as an index file, is a refusal: the PR step
 * then opens nothing, and a person looks.
 */
export function indexFilePatch(path: string, before: string | null, spec: IndexSpec): IndexFilePatch {
  if (!INDEX_FILE_PATH_RE.test(path)) return { ok: false, rule: "bad-path", reason: "The configured index file is not a plain relative .json path." };
  const entry = toIndexFileEntry(spec);
  if (before === null) {
    const after = `${JSON.stringify({ indexes: [entry], fieldOverrides: [] }, null, 2)}\n`;
    return { ok: true, patch: unifiedDiff(path, null, after), after, created: true };
  }
  if (Buffer.byteLength(before, "utf8") > MAX_FILE_BYTES) return { ok: false, rule: "too-large", reason: "The index file is larger than Starfish will rewrite." };
  if (before.includes("\r")) return { ok: false, rule: "unreadable", reason: "The index file uses CRLF line endings; Starfish leaves it to a person." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch {
    return { ok: false, rule: "unreadable", reason: "The index file is not JSON." };
  }
  const state = inIndexFile(spec, parsed);
  if (state === "present") return { ok: false, rule: "already-present", reason: "The index file already has this index." };
  if (state === "unknown" || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, rule: "unreadable", reason: "The index file is not an index file Starfish can read." };
  }
  const original = parsed as Record<string, unknown> & { indexes: unknown[] };
  const next = { ...original, indexes: [...original.indexes, entry] };
  const after = `${JSON.stringify(next, null, 2)}${before.endsWith("\n") ? "\n" : ""}`;

  // The self-check: added to, never changed.
  const reread = JSON.parse(after) as Record<string, unknown> & { indexes: unknown[] };
  const kept =
    reread.indexes.length === original.indexes.length + 1 &&
    original.indexes.every((e, i) => JSON.stringify(e) === JSON.stringify(reread.indexes[i])) &&
    Object.keys(original).every((k) => k === "indexes" || JSON.stringify(original[k]) === JSON.stringify(reread[k])) &&
    Object.keys(reread).length === Object.keys(original).length &&
    inIndexFile(spec, reread) === "present";
  if (!kept) return { ok: false, rule: "self-check", reason: "The rewritten index file did not keep every existing entry; nothing is proposed." };
  return { ok: true, patch: unifiedDiff(path, before, after), after, created: false };
}
