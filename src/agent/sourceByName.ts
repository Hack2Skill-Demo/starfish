/**
 * The fixer's source when no stack frame names a repository file (#259). A Firebase callable that fails through
 * `logger.error` or an `HttpsError` logs a stack made only of framework frames (firebase-functions' logger, its https
 * provider, cors), so `pathsFromStack` finds nothing and the fixer would be shown no source at all. What the incident
 * still has is the function's name: `orders-createOrder` is the export `createOrder` (in the group `orders`), and the
 * file that defines that export is where the fix has to start.
 *
 * The search is deterministic and bounded:
 *   - only code files of the repository's own list (never `node_modules`, a `.d.ts`, a test file or an excluded path),
 *     under the configured roots (`functionsSourceRoots`; empty: the whole checkout), in sorted order;
 *   - more candidate files than `maxFiles`, or more characters than `maxChars`, finds nothing ("capped"): with part of the
 *     repository unread, "the one file that exports it" could not be claimed;
 *   - a file counts only if it DEFINES the export (`export const|let|var|function|class NAME`, a local `export { … }`,
 *     `exports.NAME =`, `module.exports = { … }`): a barrel's `export { NAME } from "./x"` is a re-export, not the code;
 *   - names are matched exactly when any file matches exactly, else ignoring case (a gen2 function's Cloud Run service
 *     name is lowercased: `orders-createorder`);
 *   - a compiled twin (`lib/orders.js` beside `src/orders.ts`) is dropped for its TypeScript source; then, of several,
 *     those whose path names the group (`orders/…` or `orders.ts`) are kept;
 *   - still more than one: nothing ("ambiguous"). Guessing between two files would show the fixer the wrong code with
 *     the same confidence as the right one.
 *
 * The file found this way is evidence of a weaker kind than a stack frame, and the run record says which rule found the
 * source (loop.ts, `summary.fix.source`). It never makes the cause structural: auto-merge's `causeFrame` is computed from
 * the stack alone (autoMerge.ts), so it stays false for a file found by name.
 *
 * The exporting file alone is often not enough (#347): a callable that fails in a local helper it imports
 * (`./lib/track`) shows the fixer the call, not the code, and the fixer can only decline. So the file's own RELATIVE
 * imports are shown after it (`followRelativeImports`), one level deep, bounded, each one a file of the repository's own
 * list that a search could have shown (code, not a test, a declaration, `node_modules` or an excluded path). The
 * specifiers come from the repository's code, never from incident or sample text (#304).
 */
import { posix } from "node:path";
import type { SourceFile } from "./fixer.js";
import { isExcludedPath } from "./verifyGate.js";

/** The most candidate files one search reads. */
export const MAX_NAME_SCAN_FILES = 2_000;
/** The most characters one search reads, over all its files. */
export const MAX_NAME_SCAN_CHARS = 20_000_000;

export type NameSearchOutcome =
  /** Exactly one file defines the export. */
  | "found"
  /** The incident has no function name, or it is not `<group>-…-<identifier>`. */
  | "no-name"
  /** No file defines the export. */
  | "no-export"
  /** Several files do, and the group does not tell them apart. */
  | "ambiguous"
  /** More candidate files or characters than the search reads: narrow it with `functionsSourceRoots`. */
  | "capped";

/**
 * Which rule found the source the fixer is shown, as the run record keeps it (`summary.fix.source`): frames of the
 * stack trace, the function-name search when no frame named a repository file, or neither. `search` is the
 * function-name search's outcome, present whenever it ran.
 */
export interface SourceProvenance {
  rule: "stack" | "function-name" | "none";
  search?: NameSearchOutcome;
  /** With `function-name`: how many of the files shown are ones the found file imports (#347), shown after it. */
  imports?: number;
}

export interface NameSearchResult {
  outcome: NameSearchOutcome;
  /** Present only when `found`: the file, as `read` returned it. */
  file?: SourceFile;
}

export interface NameSearchOptions {
  /** Repo-relative directories to search; empty: the whole checkout. */
  roots: readonly string[];
  /** `patchExcludedPaths`: a file a patch may never touch is never shown as the place to fix. */
  excluded: readonly string[];
  maxFiles?: number;
  maxChars?: number;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CODE_EXT = /\.[cm]?[jt]sx?$/;
const TS_EXT = /\.[cm]?tsx?$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const BUILD_DIRS = new Set(["src", "lib", "dist", "build", "out"]);

/**
 * `orders-createOrder` -> export `createOrder` in the group `orders`; `createOrder` -> no group. Firebase joins a grouped
 * export's path with `-`, and an export is an identifier, so the last part is the export. Null when any part is not an
 * identifier.
 */
export function exportNameOf(functionName: string | undefined): { name: string; groups: string[] } | null {
  if (!functionName || functionName.length > 200) return null;
  const parts = functionName.split("-");
  if (!parts.every((p) => IDENT.test(p))) return null;
  return { name: parts[parts.length - 1]!, groups: parts.slice(0, -1) };
}

/** A file the fixer may be shown as source: code, not a test, a declaration, `node_modules` or an excluded path. */
function isShowableCode(f: string, excluded: readonly string[]): boolean {
  if (!CODE_EXT.test(f) || DECLARATION.test(f) || TEST_FILE.test(f)) return false;
  const segs = f.split("/");
  if (segs.includes("node_modules") || segs.includes("__tests__")) return false;
  return !isExcludedPath(f, excluded);
}

/** The repository files the search may read, sorted. */
export function nameSearchCandidates(repoFiles: readonly string[], roots: readonly string[], excluded: readonly string[]): string[] {
  return repoFiles.filter((f) => isShowableCode(f, excluded) && (roots.length === 0 || roots.some((r) => f.startsWith(`${r}/`)))).sort();
}

const escapeRe = (s: string) => s.replace(/[$]/g, "\\$");
const MAX_LIST = 4_000;

/** The names an `export { … }` / `module.exports = { … }` list exports. */
function listedNames(list: string, objectLiteral: boolean): string[] {
  const out: string[] = [];
  for (const raw of list.split(",")) {
    const item = raw.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (objectLiteral) {
      const m = /^([A-Za-z_$][\w$]*)\s*(?::|$|\()/.exec(item);
      if (m) out.push(m[1]!);
    } else {
      const m = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(item);
      if (m && !item.startsWith("type ")) out.push(m[2] ?? m[1]!);
    }
  }
  return out;
}

/**
 * Whether `content` defines an export named `name`: "exact", "folded" (only when case is ignored), or null. Re-exports
 * (`export { x } from "…"`, `export * from "…"`) do not count. A text scan, not a parser: a commented-out definition
 * counts too, which can only make a search more ambiguous, never pick a file that does not mention the name. A
 * `module.exports = { … }` whose values hold braces (an inline handler) is not read: its names are missed, never invented.
 */
export function definesExport(content: string, name: string): "exact" | "folded" | null {
  const lower = name.toLowerCase();
  if (!content.toLowerCase().includes(lower)) return null;
  const n = escapeRe(name);
  const found: string[] = [];
  const declared = new RegExp(
    `(?<![\\w$.])export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*|const\\s+|let\\s+|var\\s+|class\\s+)(${n})(?![\\w$])`,
    "gi"
  );
  const commonJs = new RegExp(`(?<![\\w$.])(?:module\\s*\\.\\s*)?exports\\s*\\.\\s*(${n})(?![\\w$])\\s*=(?!=)`, "gi");
  for (const re of [declared, commonJs]) for (const m of content.matchAll(re)) found.push(m[1]!);
  for (const m of content.matchAll(new RegExp(`(?<![\\w$.])export\\s*\\{([^{}]{0,${MAX_LIST}})\\}(\\s*from\\b)?`, "g"))) {
    if (m[2] === undefined) found.push(...listedNames(m[1]!, false));
  }
  for (const m of content.matchAll(new RegExp(`(?<![\\w$.])module\\s*\\.\\s*exports\\s*=\\s*\\{([^{}]{0,${MAX_LIST}})\\}`, "g"))) {
    found.push(...listedNames(m[1]!, true));
  }
  if (found.includes(name)) return "exact";
  return found.some((f) => f.toLowerCase() === lower) ? "folded" : null;
}

/** A path once build directories and the extension are ignored: `functions/lib/orders.js` ~ `functions/src/orders.ts`. */
const sourceKey = (p: string) =>
  p
    .replace(CODE_EXT, "")
    .split("/")
    .filter((s) => !BUILD_DIRS.has(s))
    .join("/");

/** Whether the path names every group, as a directory or as the file's own name (case ignored). */
function namesGroups(path: string, groups: readonly string[]): boolean {
  const segs = path.replace(CODE_EXT, "").toLowerCase().split("/");
  return groups.every((g) => segs.includes(g.toLowerCase()));
}

/**
 * The one repository file that defines the export a function name stands for, or why there is none. `read` returns the
 * file as the fixer would see it, or null when it may not be shown (too big, binary, a symlink): such a file is neither
 * a match nor a reason to stop. Never throws when `read` does not.
 */
export async function findSourceByFunctionName(
  functionName: string | undefined,
  repoFiles: readonly string[],
  read: (rel: string) => Promise<SourceFile | null>,
  opts: NameSearchOptions
): Promise<NameSearchResult> {
  const wanted = exportNameOf(functionName);
  if (wanted === null) return { outcome: "no-name" };
  const candidates = nameSearchCandidates(repoFiles, opts.roots, opts.excluded);
  if (candidates.length > (opts.maxFiles ?? MAX_NAME_SCAN_FILES)) return { outcome: "capped" };
  const maxChars = opts.maxChars ?? MAX_NAME_SCAN_CHARS;

  let chars = 0;
  const exact: SourceFile[] = [];
  const folded: SourceFile[] = [];
  for (const rel of candidates) {
    const file = await read(rel);
    if (file === null) continue;
    chars += file.content.length;
    if (chars > maxChars) return { outcome: "capped" };
    const hit = definesExport(file.content, wanted.name);
    if (hit === "exact") exact.push(file);
    else if (hit === "folded") folded.push(file);
  }

  let hits = exact.length > 0 ? exact : folded;
  if (hits.length === 0) return { outcome: "no-export" };
  // Compiled output kept in the repository defines the same export as its source: the source is the one to fix.
  const tsKeys = new Set(hits.filter((f) => TS_EXT.test(f.path)).map((f) => sourceKey(f.path)));
  hits = hits.filter((f) => TS_EXT.test(f.path) || !tsKeys.has(sourceKey(f.path)));
  if (hits.length > 1 && wanted.groups.length > 0) {
    const grouped = hits.filter((f) => namesGroups(f.path, wanted.groups));
    if (grouped.length > 0) hits = grouped;
  }
  return hits.length === 1 ? { outcome: "found", file: hits[0]! } : { outcome: "ambiguous" };
}

/** The most files `followRelativeImports` adds. The loader passes what is left of its own file budget. */
export const MAX_FOLLOWED_IMPORTS = 4;

// A quoted relative specifier; `quote` is the number of its quote's group, which the closing quote must match.
const spec = (quote: number) => String.raw`(['"])(\.{1,2}\/[^'"\n]{1,300})` + `\\${quote}`;
/** `from "./x"` (an import or a re-export), a bare `import "./x"`, `require("./x")` and `import("./x")`. */
const RELATIVE_SPECIFIER = new RegExp(
  String.raw`(?<![\w$.])(?:from\s*${spec(1)}|import\s*${spec(3)}|(?:require|import)\s*\(\s*${spec(5)}\s*\))`,
  "g"
);

/**
 * The relative module specifiers `content` names, in order of first appearance, each once. A text scan, not a parser: a
 * specifier in a comment or a string counts too, which can only add a file the repository's own code names, never one
 * that does not exist (`resolveRelativeImport` checks the file list).
 */
export function relativeImportsOf(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(RELATIVE_SPECIFIER)) {
    const found = m[2] ?? m[4] ?? m[6];
    if (found !== undefined && !out.includes(found)) out.push(found);
  }
  return out;
}

// A TypeScript ESM import names the compiled file (`./track.js`): its source is tried first.
const TS_FOR_JS: Readonly<Record<string, readonly string[]>> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * The repository file a relative specifier in `fromPath` names, as Node and TypeScript would look for it: the path with
 * a JavaScript extension swapped for its TypeScript source, then as written, then with each code extension, then as a
 * directory's `index`. Null when it leaves the repository or names no file of `files`.
 */
export function resolveRelativeImport(fromPath: string, specifier: string, files: ReadonlySet<string>): string | null {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) return null;
  const ext = posix.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const tries = [
    ...(TS_FOR_JS[ext] ?? []).map((e) => stem + e),
    base,
    ...RESOLVE_EXTS.map((e) => base + e),
    ...RESOLVE_EXTS.map((e) => `${base}/index${e}`),
  ];
  return tries.find((t) => files.has(t)) ?? null;
}

/**
 * The files `file` imports by a relative path, one level deep and at most `max` of them, in the order it names them:
 * each one a showable code file of the repository's own list, other than `file` itself, and readable (`read` returns
 * null for one too big, binary or a symlink, which is skipped). Never throws when `read` does not.
 */
export async function followRelativeImports(
  file: SourceFile,
  repoFiles: readonly string[],
  read: (rel: string) => Promise<SourceFile | null>,
  opts: { excluded: readonly string[]; max?: number }
): Promise<SourceFile[]> {
  const max = Math.max(0, opts.max ?? MAX_FOLLOWED_IMPORTS);
  const files = new Set(repoFiles);
  const out: SourceFile[] = [];
  for (const specifier of relativeImportsOf(file.content)) {
    if (out.length >= max) break;
    const rel = resolveRelativeImport(file.path, specifier, files);
    if (rel === null || rel === file.path || !isShowableCode(rel, opts.excluded) || out.some((f) => f.path === rel)) continue;
    const imported = await read(rel);
    if (imported) out.push(imported);
  }
  return out;
}
