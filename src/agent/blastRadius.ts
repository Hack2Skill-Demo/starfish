/**
 * Gate 1 of auto-merge (#9, docs/design/auto-merge-policy.md): LOW BLAST RADIUS, a static check on the verified diff.
 * Pure: it reads the patch text and nothing else, and it never runs anything.
 *
 * A patch passes only when ALL of this holds:
 *   - it parses as a plain unified diff (no binary, no mode change, no rename, copy or delete), every `---`/`+++` path
 *     in git's `a/`/`b/` form, naming the same file on both sides and in its `diff --git` line: the file read here is
 *     the file `git apply` writes (#200). The loop also requires gate 1's files to be exactly the files the verify gate
 *     saw change (loop.ts);
 *   - exactly ONE production source file changes, an existing JavaScript/TypeScript file, in ONE hunk, and nothing
 *     between its first and last changed line starts or ends a function: one function or handler is touched;
 *   - every other file is a test file (by path), and only GAINS lines: a patch that removes a test line could pass by
 *     disabling the test that judges it. Added lines could do that too (`/*` … `*\/`, an early `return;`, `.skip`), so
 *     in a test file that already exists each run of added lines must be whole new `it`/`test`/`describe` calls and
 *     nothing else, and no added line may open or close a block comment, skip or focus a test, mock a module or exit
 *     the process (#204). A new test file has no existing test to switch off, and is not limited this way;
 *   - no path, and no changed line of the source file, hits the hard-exclude list: auth or access control, security
 *     rules, money paths, secrets and crypto, schema, dependencies and lockfiles, imports, CI and deploy config,
 *     shared packages, or anything the deployment excludes from patches (`patchExcludedPaths`) or from auto-merge
 *     (`autoMergeExcludedPaths`). Access control is also checked on the hunk's unchanged context lines: a guard added
 *     right above an ownership check is a change to that check (#202);
 *   - every changed block of the source file is ONE allowed class, the same one throughout:
 *       null-guard                 an early exit added when a value is missing (`if (!order) return null;`): `return;`,
 *                                  `return null`, `return undefined` or a `throw`, never a value that changes what the
 *                                  function decides (`return true`, #202); or `?.` / `?? <literal>` added to a line that
 *                                  is otherwise unchanged;
 *       missing-await              `await ` added to a line that is otherwise unchanged;
 *       firestore-undefined-field  a field written as `key: value` becomes `...(value !== undefined && { key: value })`
 *                                  or `key: value ?? null`.
 *
 * Each classifier is deliberately narrow and literal: what it cannot recognise with certainty it refuses. UNSURE IS
 * NOT ALLOWED. A refusal here never blocks the pull request; it only means a person merges it.
 *
 * What this cannot know from a diff: whether the enclosing function is async (a missing `await` in a non-async
 * function is a compile error the verify gate catches), or that an object literal is really a Firestore write.
 */
import { isExcludedPath } from "./verifyGate.js";

export type FixClass = "null-guard" | "missing-await" | "firestore-undefined-field";
export const FIX_CLASSES: readonly FixClass[] = ["null-guard", "missing-await", "firestore-undefined-field"];

export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  /** `null` for `/dev/null` (a new file). */
  oldPath: string | null;
  /** `null` for `/dev/null` (a deleted file). */
  newPath: string | null;
  hunks: Hunk[];
  /** Anything but a plain content change: binary, a mode change, a rename or copy. */
  unusual: string[];
  /** The file's section of the patch, verbatim, so a part of a patch can be rebuilt exactly. */
  raw: string;
}

export interface BlastRadius {
  allowed: boolean;
  /** The one class every change fell into, when it did. */
  fixClass?: FixClass;
  /** The one production file the patch changes, when there is one. */
  sourceFile?: string;
  testFiles: string[];
  /** Why it is not allowed: short rule names, never patch text. Empty when allowed. */
  problems: string[];
}

export interface BlastRadiusConfig {
  /** The deployment's patch exclusions (verifyGate.ts) and its auto-merge-only exclusions. */
  excludedPaths: readonly string[];
}

const MAX_TEST_FILES = 3;
/** The most lines a one-function change may add or remove in the source file. */
const MAX_ADDED = 8;
const MAX_REMOVED = 4;
/** The most lines from the first changed line to the last, context included. */
const MAX_SPAN = 15;

// ---- Parsing ---------------------------------------------------------------------------------------------------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const EXTENDED_HEADER_RE = /^(index |similarity index |dissimilarity index |old mode |new mode |new file mode |deleted file mode |rename from |rename to |copy from |copy to |Binary files |GIT binary patch)/;

/**
 * A `---` (prefix `a/`) or `+++` (prefix `b/`) header's path, without its prefix. `git apply` (-p1) strips the FIRST
 * path component whatever it is, so a header without git's own prefix (`--- test/src/x.ts`) would be read here as one
 * file and written by git as another (`src/x.ts`, #200): that is not understood, and undefined.
 */
function stripPath(raw: string, prefix: "a/" | "b/"): string | null | undefined {
  const p = raw.replace(/\t.*$/, "").trim();
  if (p === "/dev/null") return null;
  // A quoted path is git's spelling of an unusual name: not something to reason about here.
  if (p.startsWith('"')) return undefined;
  if (!p.startsWith(prefix) || p.length === prefix.length) return undefined;
  return p.slice(prefix.length);
}

/**
 * A unified diff split into files and hunks, or null when any part of it is not understood: an unexpected line, a
 * hunk whose line counts do not add up, a quoted path. Null is "unsure", and unsure is never allowed.
 */
export function parsePatch(patch: string): FileDiff[] | null {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: FileDiff[] = [];
  let cur: (FileDiff & { start: number; gitLine?: string }) | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  const close = (end: number) => {
    if (cur) files.push({ oldPath: cur.oldPath, newPath: cur.newPath, hunks: cur.hunks, unusual: cur.unusual, raw: lines.slice(cur.start, end).join("\n") + "\n" });
    cur = undefined;
  };
  const open = (i: number) => {
    close(i);
    cur = { oldPath: null, newPath: null, hunks: [], unusual: [], raw: "", start: i };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (oldLeft > 0 || newLeft > 0) {
      const hunk = cur!.hunks.at(-1)!;
      const kind = line[0];
      if (kind === "\\") continue; // "\ No newline at end of file"
      if (kind === " " || line === "") {
        hunk.lines.push({ kind: " ", text: line.slice(1) });
        oldLeft--;
        newLeft--;
      } else if (kind === "-") {
        hunk.lines.push({ kind: "-", text: line.slice(1) });
        oldLeft--;
      } else if (kind === "+") {
        hunk.lines.push({ kind: "+", text: line.slice(1) });
        newLeft--;
      } else return null;
      if (oldLeft < 0 || newLeft < 0) return null;
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("diff --git ")) {
      open(i);
      cur!.gitLine = line;
      continue;
    }
    if (line.startsWith("--- ")) {
      // A `---` header starts a new file unless it follows this file's own `diff --git` and extended headers.
      if (!cur || cur.hunks.length > 0 || cur.oldPath !== null || cur.newPath !== null) open(i);
      const p = stripPath(line.slice(4), "a/");
      if (p === undefined) return null;
      cur!.oldPath = p;
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith("+++ ")) return null;
      const q = stripPath(next.slice(4), "b/");
      if (q === undefined || (p === null && q === null)) return null;
      cur!.newPath = q;
      // Two names are a rename to git, with or without a `rename from` header (#200): never a plain content change.
      if (p !== null && q !== null && p !== q) cur!.unusual.push("rename-or-copy");
      // Where `diff --git` names a file, git goes by it: it must name exactly the file the headers do (#200).
      if (cur!.gitLine !== undefined && cur!.gitLine !== `diff --git a/${p ?? q} b/${q ?? p}`) return null;
      i++;
      continue;
    }
    const h = HUNK_RE.exec(line);
    if (h) {
      if (!cur || (cur.oldPath === null && cur.newPath === null)) return null;
      cur.hunks.push({ oldStart: Number(h[1]), newStart: Number(h[3]), lines: [] });
      oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      newLeft = h[4] === undefined ? 1 : Number(h[4]);
      continue;
    }
    if (cur && EXTENDED_HEADER_RE.test(line)) {
      if (/^(Binary files |GIT binary patch)/.test(line)) cur.unusual.push("binary");
      else if (/^(old mode |new mode )/.test(line)) cur.unusual.push("mode-change");
      else if (/^(rename |copy |similarity index |dissimilarity index )/.test(line)) cur.unusual.push("rename-or-copy");
      continue;
    }
    return null;
  }
  if (oldLeft > 0 || newLeft > 0) return null;
  close(lines.length);
  return files.length > 0 ? files : null;
}

// ---- Paths -----------------------------------------------------------------------------------------------------

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

/** A test file, by its path: `*.test.ts`, `*.spec.js`, or anything under `test/`, `tests/`, `spec/` or `__tests__/`. */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** The words of a path: split at `/ . _ -` and at camelCase, lowercased. `src/authMiddleware.ts` -> src, auth, middleware, ts. */
function words(path: string): string[] {
  return path
    .split(/[/._\-\s]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((w) => w.toLowerCase())
    .filter((w) => w !== "");
}

/**
 * The hard-exclude list, by the words of a path. Policy, not deployment detail: these are the kinds of code where a
 * wrong one-line change is a security, money or availability incident of its own. A deployment adds to it
 * (`autoMergeExcludedPaths`); it cannot take anything away.
 */
const PATH_WORDS: Readonly<Record<string, readonly string[]>> = {
  "access-control": ["auth", "authn", "authz", "authorize", "authorization", "authentication", "login", "logout", "signin", "signup", "session", "sessions", "permission", "permissions", "acl", "rbac", "role", "roles", "oauth", "jwt", "token", "tokens", "password", "passwords", "credential", "credentials", "access", "iam", "admin", "admins", "claims", "owner", "owners", "ownership", "guard", "guards", "policy", "policies", "appcheck", "verify", "can"],
  "security-rules": ["rules"],
  // Where money MOVES or is priced. An order that merely carries a coupon code is not one (the demo's CODE-01 is
  // exactly that); a checkout session, a charge or a price is.
  money: ["payment", "payments", "pay", "billing", "invoice", "invoices", "charge", "charges", "stripe", "paypal", "refund", "refunds", "payout", "payouts", "wallet", "wallets", "subscription", "subscriptions", "price", "prices", "pricing", "ledger", "money", "currency", "tax", "taxes"],
  secrets: ["secret", "secrets", "crypto", "key", "keys", "cert", "certs", "certificate", "certificates", "pem", "env", "vault", "kms", "encryption", "cipher", "keystore"],
  schema: ["schema", "schemas", "migration", "migrations", "migrate", "prisma", "sql", "proto", "graphql", "indexes"],
  dependencies: ["node", "modules", "vendor", "third", "lock", "lockb", "shrinkwrap", "requirements", "gemfile", "pipfile", "pyproject", "cargo", "pom", "gradle", "composer"],
  "ci-config": ["github", "gitlab", "circleci", "cloudbuild", "jenkinsfile", "travis", "workflows", "dockerfile", "docker", "compose", "firebaserc", "apphosting", "terraform", "tf", "deploy", "deployment", "k8s", "helm", "makefile", "config", "configs", "settings"],
  "shared-package": ["packages", "shared", "common", "libs", "lib", "utils", "util", "helpers", "core", "middleware", "middlewares"],
};
/** Manifests and lockfiles, by base name, whatever words they split into. */
const DEPENDENCY_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lockb", "go.mod", "go.sum", "firebase.json", ".npmrc"]);

/** The hard-exclude categories a path falls in. */
export function excludedPathCategories(path: string): string[] {
  const base = path.split("/").at(-1)!.toLowerCase();
  const list = words(path);
  const w = new Set(list);
  // A name written as two words (`appCheck`, `signIn`) is also the one word it spells: only the longer list words are
  // matched this way, so two short parts never spell a short one by accident.
  for (let i = 0; i + 1 < list.length; i++) {
    const joined = list[i]! + list[i + 1]!;
    if (joined.length >= 6) w.add(joined);
  }
  const out = Object.entries(PATH_WORDS)
    .filter(([, list]) => list.some((x) => w.has(x)))
    .map(([category]) => category);
  if (DEPENDENCY_FILES.has(base) && !out.includes("dependencies")) out.push("dependencies");
  if (base.endsWith(".rules") && !out.includes("security-rules")) out.push("security-rules");
  return out;
}

// ---- Changed lines ---------------------------------------------------------------------------------------------

/** What a changed line of production code must never mention. Matched on the line's text, case-insensitively. */
const LINE_RULES: readonly [string, RegExp][] = [
  ["dependencies", /^\s*(import|export)\b|\brequire\s*\(|\bimport\s*\(/],
  ["access-control", /auth|token|\brole|permission|admin|claim|password|session|login|credential|\buid\b|\bacl\b|rbac|jwt|allow|deny|isOwner|owner|appcheck|\bpolic(?:y|ies)\b/i],
  ["money", /payment|billing|invoice|\bcharge|checkoutSession|stripe|paypal|refund|payout|wallet|subscription|price|amount|currency|balance|ledger|\btax/i],
  ["secrets", /secret|api_?key|apikey|private_?key|crypto|encrypt|decrypt|signature|hmac|cipher|process\.env|\bkey\b/i],
  ["schema", /schema|migration|createIndex|setRules|\bindex(es)?\b/i],
];

const ACCESS_CONTROL_LINE = LINE_RULES.find(([category]) => category === "access-control")![1];

export function excludedLineCategories(text: string): string[] {
  return LINE_RULES.filter(([, re]) => re.test(text)).map(([category]) => category);
}

// ---- Test files: what added lines may be -----------------------------------------------------------------------

/** Added lines that switch tests off or reach past their own test, anywhere in an existing test file (#204). */
const TEST_LINE_NEVER: readonly RegExp[] = [
  /\/\*|\*\//, // a block comment can swallow the existing lines between two added ones
  /\.\s*(skip|only|todo|skipIf|runIf|fails)\b/, // skips or focuses tests
  /\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(/,
  /\b(vi|jest)\s*\.\s*(mock|doMock|unmock|hoisted|stubGlobal|stubEnv|resetModules)\b/, // vi.mock is hoisted to the whole file
  /\bprocess\s*\.\s*(exit|abort|kill)\b/,
];
/** A whole-line comment with nothing in it that could matter if it were really inside a string. */
const PLAIN_COMMENT_LINE = /^\s*\/\/[^"'`${}()[\]\\]*$/;
const WHOLE_TESTS = /^(?:\s*(?:it|test|describe)(?:\.each\(\))?\(\)\s*;?)+\s*$/;
const CLOSE: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

/**
 * True when `added` (one run of consecutive added lines) is whole new `it`/`test`/`describe` calls and nothing else:
 * every bracket it opens it closes, it never closes one it did not open, and at its own top level there is nothing but
 * those calls. Anything else (`return;`, `if (false) {` … `}`, `false &&`) could change an existing test it sits in or
 * next to. Read with a scanner, not a parser, so it reads only what it can read for certain: plain strings and
 * templates without `${`, and no `/` at all (a regex literal, a division and a comment cannot be told apart without a
 * parser). Anything else is a refusal.
 */
function isWholeNewTests(added: readonly string[]): boolean {
  const text = added.filter((l) => !PLAIN_COMMENT_LINE.test(l)).join("\n");
  const stack: string[] = [];
  let top = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      else if (ch === "\n" && quote !== "`") return false;
      else if (quote === "`" && ch === "$" && text[i + 1] === "{") return false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "/" || text.startsWith("<!--", i) || text.startsWith("-->", i)) return false;
    else if (ch in CLOSE) {
      if (stack.length === 0) top += ch;
      stack.push(CLOSE[ch]!);
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return false;
      if (stack.length === 0) top += ch;
    } else if (stack.length === 0) top += ch;
  }
  return quote === null && stack.length === 0 && WHOLE_TESTS.test(top);
}

/** Why a test file's added lines are not allowed: empty when they are. */
function testAdditionProblems(t: FileDiff): string[] {
  const out = new Set<string>();
  // A new file has no existing test to switch off; one that exists may only gain whole new tests.
  if (t.oldPath === null) return [];
  for (const h of t.hunks) {
    if (h.lines.some((l) => l.kind === "+" && TEST_LINE_NEVER.some((re) => re.test(l.text)))) out.add("test-lines-disable-tests");
    let run: string[] = [];
    for (const l of [...h.lines, { kind: " ", text: "" } as DiffLine]) {
      if (l.kind === "+") run.push(l.text);
      else if (run.length > 0) {
        if (run.some((x) => x.trim() !== "") && !isWholeNewTests(run)) out.add("test-lines-not-whole-tests");
        run = [];
      }
    }
  }
  return [...out];
}

/**
 * A line that starts or ends a function, a method, a class or a type: anything between a change's first and last line
 * that matches means two definitions could be touched. Deliberately broad: an arrow anywhere counts.
 */
const DEFINITION_RE = [
  /\bfunction\b/,
  /=>/,
  /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(class|interface|type|enum|namespace|module)\b/,
  /^\s*(public|private|protected|static|readonly|async|get|set|\*)?\s*(?!(if|for|while|switch|catch|with|return|await|new|typeof)\b)[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(:\s*[^={;]+)?\{\s*$/,
  /^\S/, // anything at column 0 (a closing `}` of a top-level definition, a new statement at module level)
];
const isDefinitionLine = (text: string) => DEFINITION_RE.some((re) => re.test(text));

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const LITERAL = String.raw`(?:null|undefined|true|false|-?\d+(?:\.\d+)?|""|''|"[^"\\\n]*"|'[^'\\\n]*'|\[\]|\{\})`;
const REF = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\?\.\[\d+\]|\[\d+\])*`;
const MISSING_ATOM = String.raw`(?:!\s*${REF}|${REF}\s*===?\s*(?:null|undefined)|(?:null|undefined)\s*===?\s*${REF}|typeof\s+${REF}\s*===?\s*["']undefined["'])`;
// What the guard does: leave with nothing, or throw. Never `return true`, a number or a string: on a falsy value (`!x`
// matches any) that is a change to what the function decides, not a null guard (#202). Nor `continue`/`break`, which
// skip work the same way.
const ACTION = String.raw`(?:return(?:\s+(?:null|undefined))?|throw\s+new\s+[A-Z][\w$]*\(\s*(?:"[^"\\\n]*"|'[^'\\\n]*')?\s*\))`;
const GUARD_RE = new RegExp(
  String.raw`^if\s*\(\s*${MISSING_ATOM}(?:\s*\|\|\s*${MISSING_ATOM})*\s*\)\s*(?:\{\s*${ACTION}\s*;?\s*\}|${ACTION}\s*;?)$`
);

/** An early exit when a value is missing, added as its own lines. */
function isAddedGuard(added: readonly string[]): boolean {
  return GUARD_RE.test(norm(added.join(" ")));
}

const OPTIONAL_RE = /\?\.(?=[[(])|\?\./g;
const NULLISH_RE = new RegExp(String.raw`\s*\?\?\s*${LITERAL}`, "g");
const stripOptional = (s: string) => s.replace(/\?\.(?=[[(])/g, "").replace(/\?\./g, ".").replace(NULLISH_RE, "");
const markers = (s: string) => count(s, OPTIONAL_RE) + count(s, /\?\?/g);

/** The same line, with `?.` or `?? <literal>` added and nothing else. */
function isOptionalChaining(removed: string, added: string): boolean {
  if (markers(added) <= markers(removed)) return false;
  // Every `??` in the added line must be followed by a literal: one followed by an expression could call anything.
  if (count(added, /\?\?/g) !== count(added, NULLISH_RE)) return false;
  return norm(stripOptional(added)) === norm(stripOptional(removed)) && norm(added) !== norm(removed);
}

/** The same line with one `await ` added before a call, and nothing else. */
function isAddedAwait(removed: string, added: string): boolean {
  if (count(added, /\bawait\s/g) !== count(removed, /\bawait\s/g) + 1) return false;
  for (let at = added.indexOf("await"); at >= 0; at = added.indexOf("await", at + 1)) {
    const rest = added.slice(at);
    if (!/^await\s+[A-Za-z_$(]/.test(rest)) continue;
    // Where an expression starts: the line's start, `return`, or after an operator or an opening bracket. Not inside a
    // string or an identifier.
    if (!/(^|\breturn|[=(,:!?&|[{;])\s*$/.test(added.slice(0, at))) continue;
    const without = added.slice(0, at) + rest.replace(/^await\s+/, "");
    if (norm(without) === norm(removed)) return /\(/.test(rest); // something is called after it
  }
  return false;
}

const KEY = String.raw`[A-Za-z_$][\w$]*`;
const FIELD_RE = new RegExp(String.raw`^(${KEY})\s*(?::\s*(.+?))?\s*,?$`);
const SPREAD_RE = new RegExp(String.raw`^\.\.\.\(\s*(.+?)\s*!==?\s*(?:undefined|null)\s*&&\s*\{\s*(${KEY})\s*(?::\s*(.+?))?\s*\}\s*\)\s*,?$`);
const COALESCE_RE = new RegExp(String.raw`^(${KEY})\s*:\s*(.+?)\s*\?\?\s*null\s*,?$`);

/** `key: value` written only when defined (`...(value !== undefined && { key: value })`) or as `value ?? null`. */
function isUndefinedField(removed: string, added: string): boolean {
  const r = FIELD_RE.exec(norm(removed));
  if (!r) return false;
  const key = r[1]!;
  const value = norm(r[2] ?? key); // shorthand `key,` is `key: key`
  if (/[,;]$/.test(value) || value.includes("=>")) return false;
  const s = SPREAD_RE.exec(norm(added));
  if (s) return norm(s[1]!) === value && s[2] === key && norm(s[3] ?? key) === value;
  const c = COALESCE_RE.exec(norm(added));
  return c !== null && c[1] === key && norm(c[2]!) === value;
}

/** The class of one block of consecutive changed lines, or null when it is none of them, or not certainly one. */
function classifyBlock(removed: readonly string[], added: readonly string[]): FixClass | null {
  if (removed.length === 0) return added.length > 0 && isAddedGuard(added) ? "null-guard" : null;
  if (removed.length !== added.length) return null;
  const classes = new Set<FixClass | null>();
  removed.forEach((r, i) => {
    const a = added[i]!;
    if (isAddedAwait(r, a)) classes.add("missing-await");
    else if (isUndefinedField(r, a)) classes.add("firestore-undefined-field");
    else if (isOptionalChaining(r, a)) classes.add("null-guard");
    else classes.add(null);
  });
  return classes.size === 1 && !classes.has(null) ? [...classes][0]! : null;
}

// ---- The gate --------------------------------------------------------------------------------------------------

/** Gate 1 on a patch. Pure; never throws. */
export function assessBlastRadius(patch: string, cfg: BlastRadiusConfig): BlastRadius {
  const problems = new Set<string>();
  const done = (extra: Partial<BlastRadius> = {}): BlastRadius => ({ allowed: problems.size === 0, testFiles: [], problems: [...problems], ...extra });
  const files = parsePatch(patch);
  if (files === null) {
    problems.add("diff-not-understood");
    return done();
  }

  const sources: FileDiff[] = [];
  const tests: FileDiff[] = [];
  for (const f of files) {
    for (const u of f.unusual) problems.add(u);
    if (f.newPath === null) {
      // No `---`/`+++` at all is a `diff --git` section of headers only (an empty file, a bare rename): never plain.
      problems.add(f.oldPath === null ? "no-file-headers" : "file-deleted");
      continue;
    }
    for (const path of new Set([f.oldPath, f.newPath].filter((p): p is string => p !== null))) {
      for (const c of excludedPathCategories(path)) problems.add(`excluded:${c}`);
      if (isExcludedPath(path, cfg.excludedPaths)) problems.add("excluded:configured");
    }
    (isTestPath(f.newPath) ? tests : sources).push(f);
  }

  if (tests.length > MAX_TEST_FILES) problems.add("too-many-test-files");
  for (const t of tests) {
    if (t.hunks.some((h) => h.lines.some((l) => l.kind === "-"))) problems.add("test-lines-removed");
    for (const p of testAdditionProblems(t)) problems.add(p);
  }

  if (sources.length !== 1) {
    problems.add(sources.length === 0 ? "no-source-change" : "more-than-one-file");
    return done({ testFiles: tests.map((t) => t.newPath!) });
  }
  const src = sources[0]!;
  const sourceFile = src.newPath!;
  const testFiles = tests.map((t) => t.newPath!);
  if (src.oldPath === null) problems.add("new-source-file");
  if (!CODE_EXT.test(sourceFile)) problems.add("not-javascript-or-typescript");
  if (src.hunks.length !== 1) {
    problems.add("more-than-one-function");
    return done({ sourceFile, testFiles });
  }

  const lines = src.hunks[0]!.lines;
  const changedAt = lines.flatMap((l, i) => (l.kind === " " ? [] : [i]));
  if (changedAt.length === 0) {
    problems.add("no-source-change");
    return done({ sourceFile, testFiles });
  }
  const first = changedAt[0]!;
  const last = changedAt.at(-1)!;
  if (last - first + 1 > MAX_SPAN) problems.add("change-too-spread");
  if (lines.slice(first, last + 1).some((l) => isDefinitionLine(l.text))) problems.add("more-than-one-function");
  const added = lines.filter((l) => l.kind === "+");
  const removed = lines.filter((l) => l.kind === "-");
  if (added.length > MAX_ADDED || removed.length > MAX_REMOVED) problems.add("change-too-large");
  for (const l of [...added, ...removed]) for (const c of excludedLineCategories(l.text)) problems.add(`excluded:${c}`);
  // The lines around the change are what it changes the meaning of: an early exit right above an ownership check is a
  // change to that check, whatever the guard's own line says (#202).
  if (lines.some((l) => l.kind === " " && ACCESS_CONTROL_LINE.test(l.text))) problems.add("excluded:access-control");

  // Blocks of consecutive changed lines: each must be one class, and all the same one.
  const classes = new Set<FixClass | null>();
  let block: { removed: string[]; added: string[] } | undefined;
  const flush = () => {
    if (block) classes.add(classifyBlock(block.removed, block.added));
    block = undefined;
  };
  for (const l of lines) {
    if (l.kind === " ") {
      flush();
      continue;
    }
    block ??= { removed: [], added: [] };
    // A removal after an addition in the same run is still one block: git orders a run's removals first anyway.
    (l.kind === "-" ? block.removed : block.added).push(l.text);
  }
  flush();
  const fixClass = classes.size === 1 && !classes.has(null) ? [...classes][0]! : undefined;
  if (fixClass === undefined) problems.add(classes.size > 1 && !classes.has(null) ? "mixed-classes" : "not-an-allowed-class");

  return done({ sourceFile, testFiles, ...(fixClass && { fixClass }) });
}

/**
 * Whether gate 1 judged exactly the files the verify gate saw the patch change (`VerifyResult.changedFiles`, what
 * `git apply` really wrote): no more and no fewer (#200). Gate 1 reads headers; this ties them to the tree.
 */
export function judgedTheVerifiedFiles(r: Pick<BlastRadius, "sourceFile" | "testFiles">, changedFiles: readonly string[]): boolean {
  if (r.sourceFile === undefined) return false;
  const judged = [...new Set([r.sourceFile, ...r.testFiles])].sort();
  const changed = [...new Set(changedFiles)].sort();
  return judged.length === changed.length && judged.every((p, i) => p === changed[i]);
}

/**
 * The test files' part of a patch, verbatim, or null when the patch changes no test file or is not understood: what is
 * run against the base revision to show the test FAILS BEFORE the fix (gate 2). Built from the parsed sections, so it
 * is exactly those files' diffs and nothing of the source file's.
 */
export function testOnlyPatch(patch: string): string | null {
  const files = parsePatch(patch);
  if (files === null) return null;
  const tests = files.filter((f) => f.newPath !== null && isTestPath(f.newPath));
  if (tests.length === 0 || tests.length === files.length) return null;
  return tests.map((f) => f.raw).join("");
}
