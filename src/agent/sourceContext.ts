/**
 * The SOURCE CONTEXT block a stage shows the model: the files the caller assembled for one incident (assemble.ts), each
 * one a section (promptSections.ts: shape-only redaction, since `token = getToken()` is code, not a leak; every cut
 * marked) and the whole block bounded. Triage, the fixer and the reviewer each pass their stage's budget; the block reads
 * the same in all three.
 *
 * Each file's header says how it was found (#417): named by a stack frame (and at which line, around which a file too
 * long for its budget is windowed), found because it exports the failing function by name, or imported by such a file.
 * Three notes before the files said this for the set as a whole and could be wrong: one file had no note at all, and
 * the stack's files could be missing while the note still said the first file was one.
 */
import { redactPii } from "../ingest/redact.js";
import { describeCut, section } from "./promptSections.js";

/** How a file shown to a stage was found (#417). */
export type FoundBy =
  /** A frame of the incident's own stack trace names it. */
  | "frame"
  /** It exports the failing function by name (sourceByName.ts), and no frame named it. */
  | "name"
  /** The file found by name imports it by a relative path (#347). */
  | "import";

export interface ShownFile {
  /** Repo-relative path, as it appears in the patch. */
  path: string;
  content: string;
  /** Absent: the caller did not say (a corpus case lists its files). */
  foundBy?: FoundBy;
  /** With `frame`: the line the top frame naming it gives, when that frame is this very file (not its compiled twin). */
  frameLine?: number;
  /** With `import`: the file that imports it. */
  importedBy?: string;
}

export interface SourceBudget {
  maxFileChars: number;
  maxTotalChars: number;
}

/**
 * Each stage's budget. The reviewer gets the fixer's (#416): it must be able to see every line the fixer saw, or it can
 * approve a patch to code it was never shown. Triage judges whether code is at fault and writes nothing, so it sees less.
 */
export const SOURCE_BUDGETS = {
  triage: { maxFileChars: 8_000, maxTotalChars: 20_000 },
  fix: { maxFileChars: 20_000, maxTotalChars: 60_000 },
  review: { maxFileChars: 20_000, maxTotalChars: 60_000 },
} as const satisfies Record<string, SourceBudget>;

/** Below this much budget left, a file is listed as not shown rather than shown as a few lines. */
const MIN_FILE_CHARS = 400;
const MAX_PATH_CHARS = 300;

/** Said before the files when any of them was not named by a stack frame. */
export const WEAKER_EVIDENCE_NOTE =
  "(Each file below says how it was found. One named by a stack frame is where the error passed; one found by the failing function's name, or imported by such a file, is weaker evidence. The fault may be in any of them, or in code they call, which you were not shown.)";

/** Said before the files when any of them is shown only in part. */
export const CUT_NOTE = "(A file marked CUT is shown only in part: the lines left out are marked where they were.)";

const safePath = (p: string) => redactPii(p).slice(0, MAX_PATH_CHARS);

/** How the file was found, as its header says it. */
export function provenanceOf(file: ShownFile): string | undefined {
  switch (file.foundBy) {
    case "frame":
      return file.frameLine !== undefined ? `named by a stack frame, line ${file.frameLine}` : "named by a stack frame";
    case "name":
      return "exports the failing function by name; no stack frame named it";
    case "import":
      return file.importedBy !== undefined ? `imported by ${safePath(file.importedBy)}` : "imported by the file that exports the failing function";
    default:
      return undefined;
  }
}

/** The whole SOURCE CONTEXT block, header included, or nothing when there are no files. */
export function renderSourceContext(files: readonly ShownFile[], budget: SourceBudget): string[] {
  if (files.length === 0) return [];
  const blocks: string[] = [];
  let left = budget.maxTotalChars;
  let anyCut = false;
  const unshown: string[] = [];
  for (const file of files) {
    if (left < Math.min(MIN_FILE_CHARS, budget.maxFileChars)) {
      unshown.push(safePath(file.path));
      continue;
    }
    const how = provenanceOf(file);
    const head = (extra?: string) => `--- ${safePath(file.path)}${how || extra ? ` (${[how, extra].filter(Boolean).join("; ")})` : ""} ---`;
    const s = section({
      title: head(),
      body: file.content,
      redact: "shape",
      max: Math.min(budget.maxFileChars, left),
      keep: file.foundBy === "frame" && file.frameLine !== undefined ? { aroundLine: file.frameLine } : "head",
      markCut: (cut) => head(`CUT: ${describeCut(cut)}`),
    });
    anyCut ||= s.cut !== null;
    left -= s.cut?.shownChars ?? file.content.length;
    blocks.push(...s.lines, "");
  }
  if (unshown.length > 0) {
    anyCut = true;
    blocks.push(`[… ${unshown.length} more file(s) not shown, past the source budget: ${unshown.join(", ")} …]`, "");
  }
  const notes = [
    ...(files.some((f) => f.foundBy !== undefined && f.foundBy !== "frame") ? [WEAKER_EVIDENCE_NOTE] : []),
    ...(anyCut ? [CUT_NOTE] : []),
  ];
  return ["SOURCE CONTEXT", ...notes, ...(notes.length > 0 ? [""] : []), ...blocks];
}
