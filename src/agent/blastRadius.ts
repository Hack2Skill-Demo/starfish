/**
 * Gate 1 of auto-merge (#9, docs/design/auto-merge-policy.md): LOW BLAST RADIUS, a static check on the verified diff.
 * Pure: it reads the patch text and the base revision's content of the file it changes (passed in, never read here),
 * and it never runs anything.
 *
 * A patch passes only when ALL of this holds:
 *   - it parses as a plain unified diff (no binary, no mode change, no rename, copy or delete), every `---`/`+++` path
 *     in git's `a/`/`b/` form, naming the same file on both sides and in its `diff --git` line: the file read here is
 *     the file `git apply` writes (#200). The loop also requires gate 1's files to be exactly the files the verify gate
 *     saw change (loop.ts);
 *   - nothing in it is a control character other than a tab and a line's own end: no lone carriage return, no Unicode
 *     line or paragraph separator, no zero-width or bidirectional mark. JavaScript ends a line where a reader of the diff
 *     does not, so `// note<CR>return;` is a comment to a diff and a `return` to the test runner (#204);
 *   - exactly ONE production source file changes, an existing JavaScript/TypeScript file, in ONE hunk with at least three
 *     lines of context on each side (fewer only at the file's start or end), and nothing between its first and last
 *     changed line starts or ends a function: one function or handler is touched;
 *   - every other file is a NEW test file (`--- /dev/null`, named `*.test.*` or `*.spec.*`, outside `__mocks__` and
 *     `__snapshots__`) made only of added lines. A test file that already exists is never changed: a removed line can
 *     disable the test that judges the patch, and so can an added one (a block comment, an early `return;`, `.skip`, a
 *     matcher re-defined with `expect.extend`, a spy), a list that cannot be completed (#204);
 *   - no path, and no changed line of the source file, hits the hard-exclude list: auth or access control, security
 *     rules, money paths, secrets and crypto, schema, dependencies and lockfiles, imports, CI and deploy config,
 *     shared packages, or anything the deployment excludes from patches (`patchExcludedPaths`) or from auto-merge
 *     (`autoMergeExcludedPaths`). Access control, money and secrets are also checked on every statement that DECIDES
 *     something (a comparison, a condition, a return or a throw) in the whole enclosing function as the base revision
 *     has it, not only in the context the patch's author chose to show: a guard added above an ownership check is a
 *     change to that check (#202). Without that base content, or when it does not hold the hunk's lines, nothing passes;
 *   - every changed block of the source file is ONE allowed class, the same one throughout:
 *       null-guard                 an early exit added when a value is null or undefined, said so explicitly
 *                                  (`if (order == null) return null;`, `=== undefined`, `typeof x === "undefined"`, and
 *                                  `||` of those; never `!x`, which is also true for 0, "", false and NaN): `return;`,
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
 * function is a compile error the verify gate catches), that an object literal is really a Firestore write, or what a
 * new test file does to state other tests share (or to a test process they share, where the runner has one).
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
  /** How many lines of the old file the hunk covers. */
  oldCount: number;
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
  /**
   * The base revision's content of the files the patch changes, by path (the loop reads them from its checkout). The
   * source file's must be here: without it the enclosing function cannot be judged, and nothing passes.
   */
  baseFiles?: ReadonlyMap<string, string>;
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
  const path = p.slice(prefix.length);
  // `..`, `.` or an empty segment names the file by a way round: never the plain path the rest of the gate reasons on.
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return undefined;
  return path;
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
      oldLeft = h[2] === undefined ? 1 : Number(h[2]);
      cur.hunks.push({ oldStart: Number(h[1]), oldCount: oldLeft, newStart: Number(h[3]), lines: [] });
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

/**
 * Text that DECIDES something: a comparison, a condition, a boolean operator, a return or a throw. With an access-control,
 * money or secrets word in it (`return doc.ownerId === user.uid;`, `if (!context.auth)`, `if (order.amount > 0)`) it is
 * such a check, and a guard added in the same function changes what that check is reached with (#202). Text that only
 * carries such a word (`uid,` in a write, `const total = priceItems(items);`) decides nothing.
 */
const DECIDING = /[!=]==?|[<>]=?|&&|\|\||\?|\b(if|return|throw|while|case)\b/;
const DECISION_CATEGORIES = ["access-control", "money", "secrets"];
const DECISION_RULES = LINE_RULES.filter(([category]) => DECISION_CATEGORIES.includes(category));
const decisionCategories = (text: string): string[] => (DECIDING.test(text) ? DECISION_RULES.filter(([, re]) => re.test(text)).map(([c]) => c) : []);

export function excludedLineCategories(text: string): string[] {
  return LINE_RULES.filter(([, re]) => re.test(text)).map(([category]) => category);
}

// ---- Characters ------------------------------------------------------------------------------------------------

/**
 * Anything a reader of a diff does not see as what a JavaScript engine sees: C0 controls but the tab (a lone carriage
 * return among them: JS ends a line there, a diff does not), DEL and C1 controls (NEL), the Unicode line and paragraph
 * separators (line ends to JS), and the zero-width, bidirectional, invisible-operator and byte-order marks that make
 * text read differently from how it runs (#204).
 */
function isControlCharacter(cp: number): boolean {
  return (
    (cp < 0x20 && cp !== 0x09) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xfffb)
  );
}

/** True when `text` holds a control character other than a tab and its `\n` or `\r\n` line ends. */
function hasControlCharacter(text: string): boolean {
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    for (const ch of line) if (isControlCharacter(ch.codePointAt(0)!)) return true;
  }
  return false;
}

// ---- Test files ------------------------------------------------------------------------------------------------

/** A test by its name (`*.test.ts`, `*.spec.js`), not a mock, a snapshot or a helper beside the tests. */
const TEST_FILE_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_SUPPORT_DIR = /(^|\/)(__mocks__|__snapshots__|__fixtures__|fixtures)\//i;

/** Why a test file in the patch is not allowed: empty when it is a new test file made only of added lines. */
function testFileProblems(t: FileDiff): string[] {
  // An existing test file is never changed: removed lines can disable the test that judges the patch, and added ones
  // can too, in more ways than a list can name (#204). Tests come as new files only.
  if (t.oldPath !== null) return ["existing-test-file-changed"];
  const out: string[] = [];
  if (!TEST_FILE_NAME.test(t.newPath ?? "") || TEST_SUPPORT_DIR.test(t.newPath ?? "")) out.push("test-file-not-a-test");
  if (t.hunks.some((h) => h.lines.some((l) => l.kind !== "+"))) out.push("test-lines-removed");
  return out;
}

// ---- The base file: the function around the change -------------------------------------------------------------

/** Words after which a `/` starts a regular expression, not a division. */
const BEFORE_EXPRESSION = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

interface Scanned {
  /** Each top-level `{ … }` (not inside another `{`): where its statement starts, and its braces, as offsets. */
  blocks: { start: number; open: number; close: number }[];
  /** The text with every comment blanked (line ends kept), so a word in a comment decides nothing. */
  code: string;
}

/**
 * The top-level blocks of a JavaScript/TypeScript file, read with a scanner, not a parser: strings, templates (with
 * `${…}` nested), comments and regular expressions are skipped so a brace in them does not count. Null when anything is
 * not read for certain (an unterminated string, template, comment or regex, a bracket closed by another kind, brackets
 * left open): the caller then judges the whole file.
 */
function scanBlocks(text: string): Scanned | null {
  const n = text.length;
  const stack: string[] = []; // "{", "${", "(", "["
  const blocks: Scanned["blocks"] = [];
  const code = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (code[k] !== "\n") code[k] = " ";
  };
  const braceDepth = () => stack.filter((x) => x === "{" || x === "${").length;
  let stmtStart = 0;
  let openAt = -1;
  let regexOk = true;
  /** From inside a template literal at `j`: past its closing backtick, or past a `${` (pushed). -1: unterminated. */
  const template = (j: number): number => {
    for (; j < n; j++) {
      const c = text[j];
      if (c === "\\") j++;
      else if (c === "`") return j + 1;
      else if (c === "$" && text[j + 1] === "{") {
        stack.push("${");
        return j + 2;
      }
    }
    return -1;
  };
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    if (ch === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      if (e < 0) return null;
      blank(i, e + 2);
      i = e + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      for (; j < n && text[j] !== ch; j++) {
        if (text[j] === "\\") j++;
        else if (text[j] === "\n") return null;
      }
      if (j >= n) return null;
      i = j + 1;
      regexOk = false;
      continue;
    }
    if (ch === "`") {
      i = template(i + 1);
      if (i < 0) return null;
      regexOk = false;
      continue;
    }
    if (ch === "/") {
      if (!regexOk) {
        i++;
        regexOk = true;
        continue;
      }
      let j = i + 1;
      let inClass = false;
      for (; j < n; j++) {
        const c = text[j];
        if (c === "\\") j++;
        else if (c === "\n") return null;
        else if (inClass) inClass = c !== "]";
        else if (c === "[") inClass = true;
        else if (c === "/") break;
      }
      if (j >= n) return null;
      i = j + 1;
      while (i < n && /[a-z]/i.test(text[i]!)) i++;
      regexOk = false;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      if (ch === "{" && braceDepth() === 0) openAt = i;
      stack.push(ch);
      regexOk = true;
      i++;
      continue;
    }
    if (ch === "}") {
      const top = stack.pop();
      if (top === "${") {
        i = template(i + 1);
        if (i < 0) return null;
        regexOk = false;
        continue;
      }
      if (top !== "{") return null;
      if (braceDepth() === 0) {
        blocks.push({ start: stmtStart, open: openAt, close: i });
        if (stack.length === 0) stmtStart = i + 1;
      }
      regexOk = true;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      if (stack.pop() !== (ch === ")" ? "(" : "[")) return null;
      regexOk = false;
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j]!)) j++;
      regexOk = BEFORE_EXPRESSION.has(text.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      while (i < n && /[\w.]/.test(text[i]!)) i++;
      regexOk = false;
      continue;
    }
    if (ch === ";" && stack.length === 0) stmtStart = i + 1;
    if (!/\s/.test(ch)) regexOk = true;
    i++;
  }
  if (stack.length > 0) return null;
  return { blocks, code: code.join("") };
}

/**
 * The text of the top-level statement around base lines `lo`..`hi` (0-based, inclusive): the function, handler or class
 * the change is in, from where its statement starts to its closing brace, comments blanked. The whole file when the
 * scanner cannot read it for certain, or no one block holds both lines: wider is never less safe.
 */
function enclosingText(base: string, lo: number, hi: number): string {
  const scanned = scanBlocks(base);
  if (scanned === null) return base;
  const lineStarts = [0];
  for (let k = 0; k < base.length; k++) if (base[k] === "\n") lineStarts.push(k + 1);
  const lineOf = (offset: number) => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line++;
    return line;
  };
  const block = scanned.blocks.find((b) => lineOf(b.open) <= lo && lineOf(b.close) >= hi);
  if (!block) return base;
  return scanned.code.slice(lineStarts[lineOf(block.start)]!, block.close + 1);
}

/**
 * The decision categories (access control, money, secrets) of the statements in `text`: split at `;`, `{` and `}`, so a
 * condition written over several lines (`if (\n  !context.auth\n)`) is read whole.
 */
function decisionsIn(text: string): string[] {
  const out = new Set<string>();
  for (const part of text.split(/[;{}]/)) for (const c of decisionCategories(part)) out.add(c);
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
// Null or undefined, said so: `x == null`, `x === undefined`, `typeof x === "undefined"`. Never `!x`, which is also
// true for 0, "", false and NaN: an exit on those is a change to what the function decides, not a null guard (#202).
const MISSING_ATOM = String.raw`(?:${REF}\s*===?\s*(?:null|undefined)|(?:null|undefined)\s*===?\s*${REF}|typeof\s+${REF}\s*===?\s*["']undefined["'])`;
// What the guard does: leave with nothing, or throw. Never `return true`, a number or a string: that is a change to what
// the function decides, not a null guard (#202). Nor `continue`/`break`, which skip work the same way.
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
  // Before anything is read: a line end JavaScript sees and a diff does not makes every later reading wrong (#204).
  if (hasControlCharacter(patch)) problems.add("control-characters");
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
  for (const t of tests) for (const p of testFileProblems(t)) problems.add(p);

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

  const hunk = src.hunks[0]!;
  const lines = hunk.lines;
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
  for (const l of lines) if (l.kind === " ") for (const c of decisionCategories(l.text)) problems.add(`excluded:${c}`);
  for (const p of baseProblems(src, hunk, first, last, cfg.baseFiles)) problems.add(p);

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

/** Lines of context a hunk must show on each side of its change, unless that side is the file's start or end. */
const MIN_CONTEXT = 3;

/**
 * What the source file's base content says against the change (#202): it must be there, hold the hunk's lines where the
 * hunk says, show at least `MIN_CONTEXT` lines of context on each side (fewer only at the file's start or end), and the
 * whole function around the change must decide nothing about access control, money or secrets. Fail closed: no base, or
 * one that does not match, is a problem.
 */
function baseProblems(src: FileDiff, hunk: Hunk, first: number, last: number, baseFiles: ReadonlyMap<string, string> | undefined): string[] {
  const raw = src.oldPath === null ? undefined : baseFiles?.get(src.oldPath);
  if (raw === undefined) return ["base-not-available"];
  if (hasControlCharacter(raw)) return ["control-characters"];
  const base = raw.replace(/\r\n/g, "\n").split("\n");
  if (base.at(-1) === "") base.pop();
  const out: string[] = [];

  // The hunk's old side, line by line, against the base: the file judged here is the file the patch applies to.
  const start = hunk.oldStart - 1;
  const old = hunk.lines.filter((l) => l.kind !== "+");
  if (start < 0 || start + old.length > base.length || old.some((l, k) => l.text !== base[start + k])) return ["base-mismatch"];

  const lead = first;
  const trail = hunk.lines.length - 1 - last;
  const atStart = start === 0;
  const atEnd = start + hunk.oldCount === base.length;
  if ((lead < MIN_CONTEXT && !atStart) || (trail < MIN_CONTEXT && !atEnd)) out.push("too-little-context");

  // The base lines on each side of the change (0-based): the last one before it, the first one after it.
  const oldIndex = (i: number) => start + hunk.lines.slice(0, i).filter((l) => l.kind !== "+").length;
  const lo = Math.max(0, oldIndex(first) - 1);
  const hi = Math.min(base.length - 1, oldIndex(last + 1));
  for (const c of decisionsIn(enclosingText(base.join("\n"), lo, hi))) out.push(`excluded:${c}`);
  return out;
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
