/**
 * The SOURCE CONTEXT block a stage shows the model: the files the caller assembled for one incident (assemble.ts), each
 * bounded and the whole block bounded, with shape-only redaction (`token = getToken()` is code, not a leak). Triage, the
 * fixer and the reviewer each pass their own budgets; the block reads the same in all three.
 */
import { redactCredentials, redactPii } from "../ingest/redact.js";

/** Said before source found by the function's name rather than by a stack frame (#259). */
export const FOUND_BY_NAME_NOTE =
  "(No stack frame named a repository file. The file below was chosen because it exports the failing function by name; the fault may be in code it calls, which you were not shown.)";

/** The same, when the files it imports by a relative path are shown after it (#347). */
export const FOUND_BY_NAME_WITH_IMPORTS_NOTE =
  "(No stack frame named a repository file. The first file below was chosen because it exports the failing function by name; the files after it are the ones it imports by a relative path, one level deep. The fault may be in any of them, or in code they call, which you were not shown.)";

/** The same, when the stack named files and the exporting file of the failing function was added after them. */
export const STACK_AND_NAME_NOTE =
  "(The stack trace named only the first file(s) below, which may be shared code rather than the failing function. The files after them were added because the first of those exports the failing function by name, followed by the files it imports by a relative path, one level deep. The fault may be in any of them, or in code they call, which you were not shown.)";

/** How the files were found (sourceByName.ts `SourceProvenance`), as far as the note before them needs it. */
export interface SourceFound {
  rule?: "stack" | "stack-and-function-name" | "function-name" | "none";
  /** With `function-name`: how many of the files, after the first, are files it imports (#347). */
  imports?: number;
}

/** The note to put before the files, when they were found by the function's name; else none. */
export function sourceNote(found: SourceFound, fileCount: number): string | undefined {
  if (found.rule === "stack-and-function-name" && fileCount > 1) return STACK_AND_NAME_NOTE;
  if (found.rule !== "function-name" || fileCount === 0) return undefined;
  return (found.imports ?? 0) > 0 && fileCount > 1 ? FOUND_BY_NAME_WITH_IMPORTS_NOTE : FOUND_BY_NAME_NOTE;
}

/** Each file as `--- path ---`, its bounded body and a blank line, until the total budget is spent. */
export function renderSourceFiles(
  files: readonly { path: string; content: string }[],
  limits: { maxFileChars: number; maxTotalChars: number }
): string[] {
  const parts: string[] = [];
  let budget = limits.maxTotalChars;
  for (const file of files) {
    if (budget <= 0) break;
    const body = redactCredentials(file.content).slice(0, Math.min(limits.maxFileChars, budget));
    budget -= body.length;
    parts.push(`--- ${redactPii(file.path).slice(0, 300)} ---`, body, "");
  }
  return parts;
}
