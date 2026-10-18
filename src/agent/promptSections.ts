/**
 * The one way a model stage shows a bounded block of text (#416): a source file, a patch, a test run's output, a list
 * of attacks. Triage, the fixer and the reviewer each cut their text their own way before: a bare `slice` with no marker,
 * always from the top, so a fault at character 9,000 of a stack-named file was invisible to triage, the fixer wrote a
 * diff "against the files you were shown" without knowing they were cut, and the reviewer saw less than the fixer did.
 *
 * Here every block is redacted first, then cut by whole lines to its budget, and every cut is said twice: in the title
 * (what part is shown) and in the body, where the missing lines were. What is kept is the head, the tail (a test run says
 * what failed at its end) or a window around one line (the line a stack frame names). Pure; never throws.
 */
import { redactCredentials, redactHead, redactPii, redactTail, sliceWellFormed } from "../ingest/redact.js";

/** Which part of a block is kept when it does not fit: the start, the end, or the lines around one (1-based) line. */
export type Keep = "head" | "tail" | { aroundLine: number };

/** What a cut kept: lines `from` to `to` (1-based, inclusive) of `of`, and how many characters of how many. */
export interface Cut {
  from: number;
  to: number;
  of: number;
  shownChars: number;
  totalChars: number;
}

export interface SectionSpec {
  /** The block's first line, as the model reads it (`PATCH`, `--- path ---`). The caller makes it safe to show. */
  title: string;
  body: string;
  /** `pii` for log, CI and model text; `shape` for code, where `token = getToken()` is an assignment, not a leak. */
  redact: "pii" | "shape";
  /** The most characters of the body shown (the cut markers come on top). */
  max: number;
  /** Default: the head. */
  keep?: Keep;
  /** The title to use when the body was cut. Default: the title, then what part is shown. */
  markCut?: (cut: Cut) => string;
}

export interface RenderedSection {
  /** The title line, then the body (with a marker where lines were left out). */
  lines: string[];
  /** Null when the whole body is shown. */
  cut: Cut | null;
}

/**
 * Past this many characters a body is cut before it is redacted, so redaction stays linear in the budget. The cut there
 * is the redaction helpers' own (`redactHead`, `redactTail`), which drop what a cut left of a secret across it. A
 * source file never reaches it (assemble.ts reads none over 100 KB).
 */
const preCutChars = (max: number) => Math.max(4 * max, 200_000);

const lineCount = (s: string): number => {
  let n = 1;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
};

const notShown = (from: number, to: number) => (from === to ? `[… line ${from} not shown …]` : `[… lines ${from}–${to} not shown …]`);

/** The default title of a cut block. */
export function describeCut(cut: Cut): string {
  return cut.from === cut.to ? `line ${cut.from} of ${cut.of} shown` : `lines ${cut.from}–${cut.to} of ${cut.of} shown`;
}

/**
 * The body redacted, the line number (1-based) its first line had in the body as given, and whether it was cut before
 * redaction (only a body past `preCutChars`).
 */
function redacted(body: string, redact: SectionSpec["redact"], keep: Keep, max: number): { text: string; firstLine: number; preCut: boolean } {
  const fn = redact === "pii" ? redactPii : redactCredentials;
  const pre = preCutChars(max);
  if (body.length <= pre) return { text: fn(body), firstLine: 1, preCut: false };
  if (keep === "tail") {
    // The cut's first (partial) line is dropped, as redactTail does, so no fragment of a secret across it is kept.
    const text = redact === "pii" ? redactTail(body, pre) : ((w) => w.slice(w.indexOf("\n") + 1))(fn(body.slice(-2 * pre)).slice(-pre));
    return { text, firstLine: lineCount(body) - lineCount(text) + 1, preCut: true };
  }
  if (typeof keep === "object") {
    // A window of whole lines that starts well before the line, so the line is inside what is redacted and kept.
    let offset = 0;
    for (let line = 1; line < keep.aroundLine; line++) {
      const nl = body.indexOf("\n", offset);
      if (nl === -1) break;
      offset = nl + 1;
    }
    const from = Math.max(0, offset - Math.floor(pre / 2));
    const lineStart = from === 0 ? 0 : body.indexOf("\n", from - 1) + 1;
    return { text: redactHead(body.slice(lineStart), pre, fn), firstLine: lineCount(body.slice(0, lineStart)), preCut: true };
  }
  return { text: redactHead(body, pre, fn), firstLine: 1, preCut: true };
}

/**
 * The lines kept: contiguous, around the anchor, as many whole lines as fit in `max` (newlines counted). For `head` the
 * window only grows down, for `tail` only up, around a line it grows both ways in turn.
 */
function fit(lines: readonly string[], anchor: number, max: number, keep: Keep): [number, number] {
  let start = anchor;
  let end = anchor + 1;
  let used = lines[anchor]!.length;
  const down = keep !== "tail";
  const up = keep !== "head";
  for (;;) {
    let grew = false;
    if (down && end < lines.length && used + 1 + lines[end]!.length <= max) {
      used += 1 + lines[end]!.length;
      end++;
      grew = true;
    }
    if (up && start > 0 && used + 1 + lines[start - 1]!.length <= max) {
      used += 1 + lines[start - 1]!.length;
      start--;
      grew = true;
    }
    if (!grew) return [start, end];
  }
}

/** One block, redacted and bounded, every cut marked. */
export function section(spec: SectionSpec): RenderedSection {
  const keep = spec.keep ?? "head";
  const max = Math.max(1, Math.floor(spec.max));
  const { text, firstLine, preCut } = redacted(spec.body, spec.redact, keep, max);
  if (!preCut && text.length <= max) return { lines: [spec.title, text], cut: null };
  // Counted on what the model reads, unless the body was cut before redaction: then on the body as given.
  const totalLines = preCut ? lineCount(spec.body) : lineCount(text);
  const totalChars = preCut ? spec.body.length : text.length;

  const lines = text.split("\n");
  const anchor =
    keep === "head" ? 0 : keep === "tail" ? lines.length - 1 : Math.min(lines.length - 1, Math.max(0, keep.aroundLine - firstLine));
  const body: string[] = [];
  let from: number;
  let to: number;
  let shownChars: number;
  if (lines[anchor]!.length > max) {
    // One line longer than the whole budget (minified code, a JSON blob): part of it, said as such.
    const line = lines[anchor]!;
    const part = keep === "tail" ? line.slice(-max) : sliceWellFormed(line, max);
    from = to = firstLine + anchor;
    shownChars = part.length;
    const rest = `[… ${line.length - part.length} more characters of this line not shown …]`;
    body.push(...(keep === "tail" ? [rest, part] : [part, rest]));
  } else {
    const [start, end] = fit(lines, anchor, max, keep);
    from = firstLine + start;
    to = firstLine + end - 1;
    const kept = lines.slice(start, end);
    shownChars = kept.reduce((n, l) => n + l.length, 0) + kept.length - 1;
    body.push(...kept);
  }
  if (from > 1) body.unshift(notShown(1, from - 1));
  if (to < totalLines) body.push(notShown(to + 1, totalLines));
  const cut: Cut = { from, to, of: totalLines, shownChars, totalChars };
  return { lines: [spec.markCut ? spec.markCut(cut) : `${spec.title} (CUT: ${describeCut(cut)})`, ...body], cut };
}
