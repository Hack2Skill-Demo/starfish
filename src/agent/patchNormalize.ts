/**
 * Makes a model-written unified diff something `git apply` can read (#317).
 *
 * The fixer is shown file text with no line numbers and asked to write a unified diff, so the `@@ -a,b +c,d @@`
 * headers are the model's own arithmetic. They are often wrong while the lines of the change itself are right; the
 * first live fix attempt (2026-10-12) was rejected twice by the verify gate with "does not apply".
 *
 * This keeps what the model decided (which lines are context, which are removed, which are added) and rebuilds what
 * it only guessed: where each hunk sits in the file and how many lines it spans. Each hunk is found in the file by its
 * old-side text; a hunk that is not found exactly once, in order, leaves the whole file's section untouched for the
 * gate to refuse as before. It never invents a change: every `+` line is the model's, every context and `-` line is
 * rewritten from the file itself, and the verify gate still judges the result. Pure; it neither throws nor reads
 * anything but its arguments.
 */

export interface SourceFile {
  /** Repo-relative path, as listed to the model. */
  path: string;
  content: string;
}

type Kind = " " | "-" | "+";
interface Op {
  kind: Kind;
  text: string;
}
interface Hunk {
  declaredOldStart: number;
  ops: Op[];
}
interface Section {
  /** Lines before the first hunk: `diff --git`, `index`, `---`, `+++`, mode lines. */
  header: string[];
  hunks: Hunk[];
  /** The path in the `+++` line (or `---` for a deletion), without `a/`/`b/`; null for /dev/null. */
  path: string | null;
  /** The `---` line named /dev/null: a new file. */
  isNew: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function stripPrefix(raw: string): string | null {
  const p = raw.trim().split("\t")[0] ?? "";
  if (p === "/dev/null" || p === "") return null;
  return p.replace(/^[ab]\//, "");
}

/** Splits the patch into per-file sections. Returns undefined when it holds anything this does not understand. */
function parse(patch: string): Section[] | undefined {
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const sections: Section[] = [];
  let cur: Section | undefined;
  let hunk: Hunk | undefined;

  const startSection = (): Section => {
    cur = { header: [], hunks: [], path: null, isNew: false };
    sections.push(cur);
    hunk = undefined;
    return cur;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // A `--- ` line starts a new file only once the current file has hunks; right after `diff --git` it is its header.
    const startsFile =
      line.startsWith("diff --git ") ||
      (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ") && (cur === undefined || cur.hunks.length > 0));
    if (startsFile || cur === undefined) startSection();
    const section = cur as Section;
    if (section.hunks.length === 0 && !line.startsWith("@@")) {
      section.header.push(line);
      if (line.startsWith("--- ")) {
        section.path = stripPrefix(line.slice(4));
        section.isNew = section.path === null;
      }
      if (line.startsWith("+++ ")) section.path = stripPrefix(line.slice(4)) ?? section.path;
      continue;
    }
    const m = HUNK.exec(line);
    if (m) {
      hunk = { declaredOldStart: Number(m[1]), ops: [] };
      section.hunks.push(hunk);
      continue;
    }
    if (hunk === undefined) return undefined;
    if (line.startsWith("\\")) return undefined; // "\ No newline at end of file": not handled, left to the gate
    if (line === "") {
      hunk.ops.push({ kind: " ", text: "" }); // a blank context line whose leading space was dropped
      continue;
    }
    const kind = line[0] as string;
    if (kind !== " " && kind !== "-" && kind !== "+") return undefined;
    hunk.ops.push({ kind, text: line.slice(1) });
  }
  return sections;
}

function fileLines(content: string): string[] | undefined {
  if (content.includes("\r")) return undefined;
  const lines = content.split("\n");
  if (lines[lines.length - 1] !== "") return undefined; // no final newline: out of scope
  lines.pop();
  return lines;
}

/** Index of `old` in `file` at or after `from`, nearest to `near`; exact text first, then ignoring trailing space. */
function locate(file: string[], old: string[], from: number, near: number): number {
  for (const same of [(a: string, b: string) => a === b, (a: string, b: string) => a.trimEnd() === b.trimEnd()]) {
    let best = -1;
    for (let i = from; i + old.length <= file.length; i++) {
      let ok = true;
      for (let k = 0; k < old.length; k++) {
        if (!same(file[i + k] as string, old[k] as string)) {
          ok = false;
          break;
        }
      }
      if (ok && (best === -1 || Math.abs(i - near) < Math.abs(best - near))) best = i;
    }
    if (best !== -1) return best;
  }
  return -1;
}

/** `start,count` as git writes it: a count of 1 is left off. */
const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);

/** The section rebuilt against its file, or undefined when any hunk cannot be placed. */
function rebuild(section: Section, file: string[]): string[] | undefined {
  const out = [...section.header];
  let from = 0;
  let delta = 0;
  for (const h of section.hunks) {
    const old = h.ops.filter((o) => o.kind !== "+").map((o) => o.text);
    const added = h.ops.filter((o) => o.kind === "+").length;
    const removed = h.ops.filter((o) => o.kind === "-").length;
    if (old.length === 0) return undefined;
    const at = locate(file, old, from, h.declaredOldStart - 1);
    if (at === -1) return undefined;
    out.push(`@@ -${range(at + 1, old.length)} +${range(at + 1 + delta, old.length - removed + added)} @@`);
    let seen = 0;
    for (const o of h.ops) {
      if (o.kind === "+") out.push("+" + o.text);
      else out.push(o.kind + (file[at + seen++] as string));
    }
    delta += added - removed;
    from = at + old.length;
  }
  return out;
}

/** A new file's hunk needs only its counts put right. */
function recountNew(section: Section): string[] | undefined {
  if (section.hunks.length !== 1) return undefined;
  const ops = (section.hunks[0] as Hunk).ops;
  if (ops.some((o) => o.kind !== "+")) return undefined;
  return [...section.header, `@@ -0,0 +${range(1, ops.length)} @@`, ...ops.map((o) => "+" + o.text)];
}

/**
 * The patch with each hunk's position and counts rebuilt from the files it names. A section for a file that was not
 * shown, or whose hunks are not found, is kept exactly as written. Returns the input unchanged when it cannot be read.
 */
export function normalizePatch(patch: string, files: readonly SourceFile[]): string {
  if (patch.includes("\r")) return patch;
  const sections = parse(patch);
  if (sections === undefined || !sections.some((sec) => sec.hunks.length > 0)) return patch;
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const raw = patch.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();

  // Sections were parsed in order; their original text is needed to keep the ones that are left alone.
  const original: string[][] = [];
  let at = 0;
  for (let s = 0; s < sections.length; s++) {
    const sec = sections[s] as Section;
    const size = sec.header.length + sec.hunks.reduce((n, h) => n + 1 + h.ops.length, 0);
    original.push(raw.slice(at, at + size));
    at += size;
  }
  if (at !== raw.length) return patch; // the split disagreed with the text: change nothing

  const out: string[] = [];
  sections.forEach((sec, i) => {
    let rebuilt: string[] | undefined;
    if (sec.isNew) rebuilt = recountNew(sec);
    else if (sec.path !== null && byPath.has(sec.path)) {
      const lines = fileLines(byPath.get(sec.path) as string);
      if (lines !== undefined) rebuilt = rebuild(sec, lines);
    }
    out.push(...(rebuilt ?? (original[i] as string[])));
  });
  return out.join("\n") + "\n";
}
