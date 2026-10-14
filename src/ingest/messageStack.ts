/**
 * A log message that carries its own stack trace (#361), split into its title and its frames.
 *
 * The firebase-functions logger puts the stack INSIDE the message: `logger.error("x failed: …")` with no Error
 * argument writes `new Error(message).stack`, and an onCall's `logger.error("Unhandled error", err)` appends
 * `err.stack`. Kept whole, the frames became part of the incident's title: they entered the fingerprint (one bug,
 * logged once with the app's frames and once with the logger's, forked into two incidents), the classifier read
 * them (`node:internal/...` gave every Node stack the code "internal", a `node:internal/timers` frame made a
 * TimeoutError) and the guests' copy showed them.
 *
 * Pure and linear in the text: it looks at each line once and never backtracks.
 */

/**
 * One V8 stack frame line: indented, `at `, then a location V8 prints. Which locations:
 *   `at fn (/workspace/lib/x.js:1:2)`, `at async Promise.all (index 0)`, `at new Promise (<anonymous>)`: ends in `)`;
 *   `at /workspace/lib/x.js:1:2`, `at node:internal/process/task_queues:95:5`: ends in `:line:column`;
 *   `at <anonymous>`.
 * Prose that only starts like one (`  at least one field is required`) is not a frame: it ends in none of these.
 */
function isFrameLine(line: string): boolean {
  if (!/^[ \t]+at \S/.test(line)) return false;
  const end = line.trimEnd();
  return end.endsWith(")") || end.endsWith("<anonymous>") || /:\d+:\d+$/.test(end);
}

export interface MessageStack {
  /** The message up to its first frame line, trailing whitespace removed; the whole text when it has no frame. */
  title: string;
  /** The whole text, title and frames, as a V8 `stack` reads; absent when the text holds no frame after a title. */
  stack?: string;
}

/**
 * Split `text` at its first V8 frame line (see {@link isFrameLine}). The title is everything before that line; the
 * stack is the whole text, as `err.stack` would be. A text whose first line with text is a frame has no title to
 * keep, and a text with no frame line has no stack: both come back whole, with no stack. Non-strings are coerced, so a malformed
 * stored row cannot crash a batch.
 */
export function splitMessageStack(text: string): MessageStack {
  const s = String(text ?? "");
  let start = 0;
  let titled = false;
  for (;;) {
    const nl = s.indexOf("\n", start);
    const line = s.slice(start, nl === -1 ? s.length : nl).replace(/\r$/, "");
    if (isFrameLine(line)) {
      // The first line with text is a frame: there is no title to keep.
      return titled ? { title: s.slice(0, start).trimEnd(), stack: s } : { title: s };
    }
    if (line.trim() !== "") titled = true;
    if (nl === -1) return { title: s };
    start = nl + 1;
  }
}

/** The title of `text`: what the fingerprint, the classifier and the guests' copy read. */
export function messageTitle(text: string): string {
  return splitMessageStack(text).title;
}
