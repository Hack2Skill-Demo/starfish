/**
 * Gate 1 of auto-merge (#9, docs/design/auto-merge-policy.md): LOW BLAST RADIUS, a static check on the verified diff.
 * Pure: it reads the patch text and the base revision's content of the file it changes (passed in, never read here),
 * and it never runs anything.
 *
 * A patch passes only when ALL of this holds:
 *   - it parses as a plain unified diff (no binary, no mode change, no rename, copy or delete), every `---`/`+++` path
 *     in git's `a/`/`b/` form, naming the same file on both sides and in its `diff --git` line: the file read here is
 *     the file `git apply` writes (#200). The loop also requires gate 1's files to be exactly the files the verify gate
 *     saw change (loop.ts). A `\ No newline at end of file` marker only after a side's last line at the file's end:
 *     anywhere else git joins the line onto the next, and writes a line read here as two (#237);
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
 *     change to that check (#202). For a null guard, which can skip a statement, EVERY statement naming one counts: a
 *     check can decide by being called and throwing (`await requireAdmin(context);`). Without that base content, or when
 *     it does not hold the hunk's lines, nothing passes;
 *   - every changed block of the source file is ONE allowed class, the same one throughout:
 *       null-guard                 an early exit added when a value is null or undefined, said so explicitly
 *                                  (`if (order == null) return null;`, `=== undefined`, `typeof x === "undefined"`, and
 *                                  `||` of those; never `!x`, which is also true for 0, "", false and NaN): `return;`,
 *                                  `return null`, `return undefined` or a `throw`, never a value that changes what the
 *                                  function decides (`return true`, #202), ended by its own `;` or a block (#238), and
 *                                  after a line that ends a statement (never the body of a braceless `if`/`else`/loop);
 *                                  or `?.` / `?? null` / `?? undefined` added to a line that is otherwise unchanged, a
 *                                  `??` never on a line that compares or does arithmetic (#239), a `?.` never before a
 *                                  call it would skip;
 *       missing-await              `await ` added to a line that is otherwise unchanged;
 *       firestore-undefined-field  a field written as `key: value` becomes `...(value !== undefined && { key: value })`
 *                                  or `key: value ?? null`.
 *     A changed line is judged on its code: its strings, templates, regular expressions and comments must not change.
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
  /**
   * Which side's last line has no line end (`\ No newline at end of file` after it): only ever the hunk's last line on
   * that side, in the file's last hunk (#237). Whether that is really the file's end is the base content's to say.
   */
  noNewlineAtEnd?: { old: boolean; new: boolean };
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
  /** The hunk line read last: where it was, its kind, and whether its hunk had no more lines on each side after it. */
  let last: { at: number; kind: DiffLine["kind"]; oldDone: boolean; newDone: boolean } | undefined;
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
    if (line.startsWith("\\")) {
      // "\ No newline at end of file": the line before it has no line end. Anywhere but after the last line of a side
      // of the file's last hunk, git joins that line onto the next one, and writes code this parse never saw:
      // `+  if (doc.meta == null) return` then `   await assertCanRead(…)` becomes one line, the check skipped (#237).
      const hunk = cur?.hunks.at(-1);
      if (!hunk || last?.at !== i - 1) return null;
      const old = last.kind !== "+";
      const neu = last.kind !== "-";
      if ((old && !last.oldDone) || (neu && !last.newDone)) {
        cur!.unusual.push("no-newline-marker");
      } else {
        hunk.noNewlineAtEnd = { old: old || (hunk.noNewlineAtEnd?.old ?? false), new: neu || (hunk.noNewlineAtEnd?.new ?? false) };
      }
      last = undefined; // a second marker in a row follows no line
      continue;
    }
    if (oldLeft > 0 || newLeft > 0) {
      const hunk = cur!.hunks.at(-1)!;
      const kind = line[0];
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
      last = { at: i, kind: hunk.lines.at(-1)!.kind, oldDone: oldLeft === 0, newDone: newLeft === 0 };
      continue;
    }
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
      // A line with no line end is the file's last: a hunk after it is not the end of the file it claimed (#237).
      if (cur.hunks.at(-1)?.noNewlineAtEnd !== undefined) cur.unusual.push("no-newline-marker");
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
  ["access-control", /auth|token|\brole|permission|admin|claim|password|session|login|credential|\buid\b|\bacl\b|rbac|jwt|allow|deny|isOwner|owner|appcheck|\bpolic(?:y|ies)\b|access|assert|ensure|verify/i],
  // A check written as a call (`canRead(…)`, `requireAdmin(…)`, `userCanEdit`): case matters here, or `cancel` would
  // be one (review of #202). Wider is the safe direction.
  ["access-control", /(?:^|[^A-Za-z])can[A-Z]|Can[A-Z]|(?:^|[^A-Za-z])require[A-Z]|Require[A-Z]/],
  ["money", /payment|billing|invoice|\bcharge|checkoutSession|stripe|paypal|refund|payout|wallet|subscription|price|amount|currency|balance|ledger|\btax/i],
  ["secrets", /secret|api_?key|apikey|private_?key|crypto|encrypt|decrypt|signature|hmac|cipher|process\.env|\bkey\b/i],
  ["schema", /schema|migration|createIndex|setRules|\bindex(es)?\b/i],
];

/**
 * Text that DECIDES something: a comparison, a condition, a boolean operator, a return or a throw. With an access-control,
 * money or secrets word in it (`return doc.ownerId === user.uid;`, `if (!context.auth)`, `if (order.amount > 0)`) it is
 * such a check, and a guard added in the same function changes what that check is reached with (#202). Text that only
 * carries such a word (`uid,` in a write, `const total = priceItems(items);`) decides nothing.
 *
 * That holds for a change that never leaves early. A null guard does (an added exit, or a `?.` that turns a throw into
 * going on): it can skip a check that DECIDES by being called and throwing (`await requireAdmin(context);`,
 * `assertIsOwner(uid, doc)`), with no condition in sight. So for the null-guard class, and for a change of no certain
 * class, ANY statement naming access control, money or a secret counts (`wide`).
 */
const DECIDING = /[!=]==?|[<>]=?|&&|\|\||\?|\b(if|return|throw|while|case)\b/;
const DECISION_CATEGORIES = ["access-control", "money", "secrets"];
const DECISION_RULES = LINE_RULES.filter(([category]) => DECISION_CATEGORIES.includes(category));
const decisionCategories = (text: string, wide: boolean): string[] =>
  wide || DECIDING.test(text) ? DECISION_RULES.filter(([, re]) => re.test(text)).map(([c]) => c) : [];

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
function decisionsIn(text: string, wide: boolean): string[] {
  const out = new Set<string>();
  for (const part of text.split(/[;{}]/)) for (const c of decisionCategories(part, wide)) out.add(c);
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

const REF = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\?\.\[\d+\]|\[\d+\])*`;
// Null or undefined, said so: `x == null`, `x === undefined`, `typeof x === "undefined"`. Never `!x`, which is also
// true for 0, "", false and NaN: an exit on those is a change to what the function decides, not a null guard (#202).
const MISSING_ATOM = String.raw`(?:${REF}\s*===?\s*(?:null|undefined)|(?:null|undefined)\s*===?\s*${REF}|typeof\s+${REF}\s*===?\s*["']undefined["'])`;
// What the guard does: leave with nothing, or throw. Never `return true`, a number or a string: that is a change to what
// the function decides, not a null guard (#202). Nor `continue`/`break`, which skip work the same way.
const ACTION = String.raw`(?:return(?:\s+(?:null|undefined))?|throw\s+new\s+[A-Z][\w$]*\(\s*(?:"[^"\\\n]*"|'[^'\\\n]*')?\s*\))`;
// Ended by its own `;` or a block's `}`: without either, JavaScript reads a next line that starts with `(`, `[`, a
// backtick, `+`, `-` or `/` as part of the `return` (`return null` then `[stock] = …` is `return null[stock] = …`, #238).
const GUARD_RE = new RegExp(
  String.raw`^if\s*\(\s*${MISSING_ATOM}(?:\s*\|\|\s*${MISSING_ATOM})*\s*\)\s*(?:\{\s*${ACTION}\s*;?\s*\}|${ACTION}\s*;)$`
);
/**
 * A line that would continue the statement before it if that one had no `;` (a comment does not), or that would take the
 * guard's `if` for its own: an `else` after it attaches to the added `if` (`if (a) x(); +guard else y();`).
 */
const CONTINUES_RE = /^\s*(?:[([`+\-.]|else\b|\/(?![/*]))/;
/**
 * What the line before an added guard must end with, so the guard is a statement of its own: `;`, `{` or `}`. After a
 * braceless `if (…)`, `else`, `for (…)`, `while (…)`, `do`, a label or `case x:`, the guard would BECOME that statement's
 * body and push the statement that was its body out of it, to run every time (the review's `if (user.plan === "pro")`
 * then `features.push("export")`). After a line that ends in anything else, the guard is not certainly its own statement.
 */
const ENDS_STATEMENT_RE = /[;{}]$/;

/**
 * An early exit when a value is missing, added as its own lines: preceded by a line that ends a statement (`prev`: the
 * nearest line before it in the new file that is neither blank nor a comment; null at the file's start, undefined when
 * the hunk does not show one), and not followed by a line that could join it or take its `if`.
 */
function isAddedGuard(added: readonly string[], prev: string | null | undefined, next: string | undefined): boolean {
  if (prev === undefined || (prev !== null && !ENDS_STATEMENT_RE.test(prev.trim()))) return false;
  if (next !== undefined && CONTINUES_RE.test(next)) return false;
  return GUARD_RE.test(norm(added.join(" ")));
}

/** A line that holds nothing but a comment, or a blank one: not where a statement ends. */
const isBlankOrComment = (text: string) => /^\s*(?:$|\/\/|\/\*|\*)/.test(text);

/**
 * One line's code with every string, template, regular-expression literal and comment replaced by a fixed placeholder,
 * and the literals themselves, in order: a `?.`, `??` or `await` inside a literal is text, not code, and the classes below
 * judge the code (`isOn("orders.hold")` to `isOn("orders?.hold")` is a changed string, not optional chaining). Null when
 * the line is not read for certain: an unterminated literal or comment, or a template with `${…}` in it.
 */
function lexLine(text: string): { code: string; literals: string[] } | null {
  const n = text.length;
  let code = "";
  const literals: string[] = [];
  let regexOk = true;
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    if (ch === "/" && text[i + 1] === "/") {
      literals.push(text.slice(i));
      code += "//";
      break;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      if (e < 0) return null;
      literals.push(text.slice(i, e + 2));
      code += "/**/";
      i = e + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      for (; j < n && text[j] !== ch; j++) if (text[j] === "\\") j++;
      if (j >= n) return null;
      const literal = text.slice(i, j + 1);
      if (ch === "`" && literal.includes("${")) return null;
      literals.push(literal);
      code += ch + ch;
      i = j + 1;
      regexOk = false;
      continue;
    }
    if (ch === "/" && regexOk) {
      let j = i + 1;
      let inClass = false;
      for (; j < n; j++) {
        const c = text[j];
        if (c === "\\") j++;
        else if (inClass) inClass = c !== "]";
        else if (c === "[") inClass = true;
        else if (c === "/") break;
      }
      if (j >= n) return null;
      j++;
      while (j < n && /[a-z]/i.test(text[j]!)) j++;
      literals.push(text.slice(i, j));
      code += "/_/";
      i = j;
      regexOk = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j]!)) j++;
      regexOk = BEFORE_EXPRESSION.has(text.slice(i, j));
      code += text.slice(i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[\w.]/.test(text[j]!)) j++;
      code += text.slice(i, j);
      regexOk = false;
      i = j;
      continue;
    }
    if (ch === ")" || ch === "]") regexOk = false;
    else if (!/\s/.test(ch)) regexOk = true;
    code += ch;
    i++;
  }
  return { code, literals };
}

const OPTIONAL_RE = /\?\.(?=[[(])|\?\./g;
// Only `?? null` or `?? undefined`. Any other default is a value the code then acts on wherever it lands: `if (x.hidden
// ?? true)` takes the branch (#202), and so does `const hide = x.hidden ?? true; … if (hide)`, `return x.visible ??
// true` or `(x.reports ?? 99) > 2` (#239). The default must also end its expression: `??` binds looser than arithmetic
// and comparison, so `a ?? null + b` is `a ?? (null + b)`.
const NULLISH_RE = /\s*\?\?\s*(?:null|undefined)\b(?=\s*(?:[)\],;}]|$))/g;
// Where null and undefined differ: compared (`>= 0` is true for null, false for undefined), strictly compared, or in
// arithmetic (null is 0, undefined NaN). A null default there is a change to what the line computes.
const NULL_DIFFERS_RE = /[<>]|[!=]==|[-+*/%]/;
const stripOptional = (s: string) => s.replace(/\?\.(?=[[(])/g, "").replace(/\?\./g, ".").replace(NULLISH_RE, "");
const markers = (s: string) => count(s, OPTIONAL_RE) + count(s, /\?\?/g);
/**
 * The `?.` with a call after it on the line. A missing value short-circuits the whole chain, call included: `order?.items
 * .push(x)` or `ref?.update({ paid: true })` skips the call and goes on where it used to throw, which is not a null
 * guard's early exit (a check written as a call would be skipped the same way). Counted wide: any `(` after the `?.`.
 */
const callsAfterOptional = (code: string) => [...code.matchAll(/\?\./g)].filter((m) => code.slice(m.index + 2).includes("(")).length;

/** The same line, with `?.` or `?? null` / `?? undefined` added and nothing else. */
function isOptionalChaining(removed: string, added: string): boolean {
  if (markers(added) <= markers(removed)) return false;
  if (callsAfterOptional(added) > callsAfterOptional(removed)) return false;
  // Every `??` in the added line must be followed by null or undefined: anything else is a value, or could call anything.
  if (count(added, /\?\?/g) !== count(added, NULLISH_RE)) return false;
  if (count(added, /\?\?/g) > 0 && NULL_DIFFERS_RE.test(stripOptional(added))) return false;
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
const SPREAD_RE = new RegExp(String.raw`^\.\.\.\(\s*(.+?)\s*!==\s*undefined\s*&&\s*\{\s*(${KEY})\s*(?::\s*(.+?))?\s*\}\s*\)\s*,?$`);
const PLAIN_REF_RE = new RegExp(String.raw`^${REF}$`);
const COALESCE_RE = new RegExp(String.raw`^(${KEY})\s*:\s*(.+?)\s*\?\?\s*null\s*,?$`);

/** `key: value` written only when defined (`...(value !== undefined && { key: value })`) or as `value ?? null`. */
function isUndefinedField(removed: string, added: string): boolean {
  const r = FIELD_RE.exec(norm(removed));
  if (!r) return false;
  const key = r[1]!;
  const value = norm(r[2] ?? key); // shorthand `key,` is `key: key`
  if (/[,;]$/.test(value) || value.includes("=>")) return false;
  // A plain reference only: a call would run twice in the spread form (the value checked is not the value written),
  // and `!= null` would also drop an explicit null meant to clear the field.
  if (!PLAIN_REF_RE.test(value)) return false;
  const s = SPREAD_RE.exec(norm(added));
  if (s) return norm(s[1]!) === value && s[2] === key && norm(s[3] ?? key) === value;
  const c = COALESCE_RE.exec(norm(added));
  return c !== null && c[1] === key && norm(c[2]!) === value;
}

/**
 * The class of one block of consecutive changed lines, or null when it is none of them, or not certainly one. `prev` and
 * `next` are the lines around the block (see `isAddedGuard`).
 */
function classifyBlock(removed: readonly string[], added: readonly string[], prev: string | null | undefined, next: string | undefined): FixClass | null {
  if (removed.length === 0) return added.length > 0 && isAddedGuard(added, prev, next) ? "null-guard" : null;
  if (removed.length !== added.length) return null;
  const classes = new Set<FixClass | null>();
  removed.forEach((rawRemoved, i) => {
    // Judged on the code alone, its literals and comments unchanged byte for byte.
    const lr = lexLine(rawRemoved);
    const la = lexLine(added[i]!);
    if (lr === null || la === null || lr.literals.length !== la.literals.length || lr.literals.some((l, k) => l !== la.literals[k])) {
      classes.add(null);
      return;
    }
    const r = lr.code;
    const a = la.code;
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

  // Blocks of consecutive changed lines: each must be one class, and all the same one.
  const classes = new Set<FixClass | null>();
  let block: { removed: string[]; added: string[]; prev: string | null | undefined } | undefined;
  // The nearest line before the current one in the NEW file that is neither blank nor a comment; null at the file's start,
  // undefined when the hunk starts later and shows none.
  let prev: string | null | undefined = hunk.oldStart <= 1 && hunk.newStart <= 1 ? null : undefined;
  const flush = (next: string | undefined) => {
    if (block) classes.add(classifyBlock(block.removed, block.added, block.prev, next));
    block = undefined;
  };
  for (const l of lines) {
    if (l.kind === " ") flush(l.text);
    else {
      block ??= { removed: [], added: [], prev };
      // A removal after an addition in the same run is still one block: git orders a run's removals first anyway.
      (l.kind === "-" ? block.removed : block.added).push(l.text);
    }
    if (l.kind !== "-" && !isBlankOrComment(l.text)) prev = l.text;
  }
  flush(undefined);
  const fixClass = classes.size === 1 && !classes.has(null) ? [...classes][0]! : undefined;
  if (fixClass === undefined) problems.add(classes.size > 1 && !classes.has(null) ? "mixed-classes" : "not-an-allowed-class");

  // The lines around the change are what it changes the meaning of: an early exit right above an ownership check is a
  // change to that check, whatever the guard's own line says (#202). A change that can leave early, or skip a call, is
  // judged on every statement that names access control, money or a secret, not only those that compare (`wide`).
  const wide = fixClass !== "missing-await" && fixClass !== "firestore-undefined-field";
  for (const l of lines) if (l.kind === " ") for (const c of decisionCategories(l.text, wide)) problems.add(`excluded:${c}`);
  for (const p of baseProblems(src, hunk, first, last, cfg.baseFiles, wide)) problems.add(p);

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
function baseProblems(src: FileDiff, hunk: Hunk, first: number, last: number, baseFiles: ReadonlyMap<string, string> | undefined, wide: boolean): string[] {
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
  // A line with no line end must be the file's last, on its side: anywhere else git joins it onto the next line (#237).
  const noEol = hunk.noNewlineAtEnd;
  if (noEol && (!atEnd || (noEol.old && raw.endsWith("\n")))) out.push("no-newline-marker");

  // The base lines on each side of the change (0-based): the last one before it, the first one after it.
  const oldIndex = (i: number) => start + hunk.lines.slice(0, i).filter((l) => l.kind !== "+").length;
  const lo = Math.max(0, oldIndex(first) - 1);
  const hi = Math.min(base.length - 1, oldIndex(last + 1));
  for (const c of decisionsIn(enclosingText(base.join("\n"), lo, hi), wide)) out.push(`excluded:${c}`);
  return out;
}

// ---- The merge floor -------------------------------------------------------------------------------------------

/**
 * The SAFETY FLOOR every merge Starfish makes must clear (docs/design/auto-merge-policy.md). Gemini decides that an
 * incident is one of the admin's merge cases (triage.ts); this decides that the patch it led to is one Starfish may
 * merge at all. It is gate 1 without gate 1's shape rules. Pure; never throws. A patch clears it only when ALL holds:
 *   - the diff is understood exactly as git applies it (gate 1's parsing, `a/`/`b/` paths and `\ No newline` markers)
 *     and has no control character;
 *   - exactly one production file changes, an existing JavaScript/TypeScript file, and the base revision's content of it
 *     is there and holds every hunk's lines where the hunk says;
 *   - every other file is a NEW test file made only of added lines (gate 1's rule): an existing test is never changed,
 *     so a patch cannot turn the required checks green by weakening the test that judges it;
 *   - no path, no changed line, and no statement of the function around any hunk (every statement naming one, as for a
 *     null guard) hits the hard-exclude list: auth and access control, security rules, money, secrets, schema,
 *     dependencies and imports, CI and deploy config, shared packages, and the deployment's own exclusions. That list
 *     is WORDS: a check on `order.createdBy !== req.user.id` names none of them (#295), hence the rules below;
 *   - at most `MAX_FLOOR_CHANGED` (40) lines added and removed in the production file;
 *   - not a JSX file (`.jsx`/`.tsx`: the scanner cannot read JSX text, `jsx-not-judged`);
 *   - no removed line decides, steers or calls (a condition, comparison, `&&`/`||`, `return`, `throw`, a branch, a loop,
 *     an `await`, a block's brace, any call) unless the same run of changed lines puts it back as itself with only `?.`,
 *     `?? null` or `await` added; and no call is taken out of the file (`removes-a-decision`, `removes-a-call`);
 *   - no added `try`/`catch`/`finally` (`.catch(` included); no added `if`, `return`, `throw`, loop or branch but an
 *     explicit null guard (gate 1's `MISSING_ATOM`, leaving with nothing or throwing a new error) placed as gate 1
 *     places one; and every run of added lines closes the brackets it opens, so nothing existing is wrapped in a new
 *     block or function (`adds-try-catch`, `adds-control-flow`, `adds-unbalanced-brackets`);
 *   - no added line, in the production file or a new test, names a network, process, dynamic-code, destructive or
 *     file-system sink (`SINKS`, matched on the whole line, strings and comments included) or holds `://`;
 *   - the added code calls nothing the base file does not already call (by name: `foo(`, `.bar(`, `new X`, a tagged
 *     template), except the pure calls in `PURE_CALLS`; calls nothing that is not a name (`fns[k](…)`, `f()(…)`); and
 *     binds no name the base file calls (`const load = …`, an arrow parameter `load`).
 * What it does NOT ask, unlike gate 1: one of three fix classes, one hunk, a span limit, three lines of context. Those
 * were Starfish deciding WHAT KIND of change may merge; that call is now Gemini's, within the cases an admin lists.
 * The code rules read text with a scanner, not a parser, and by name, not by receiver: a method the base calls on one
 * object may be added on another. Unsure refuses. They are a floor under the target's required checks, not a proof.
 */
export function assessMergeFloor(patch: string, cfg: BlastRadiusConfig): BlastRadius {
  const problems = new Set<string>();
  const done = (extra: Partial<BlastRadius> = {}): BlastRadius => ({ allowed: problems.size === 0, testFiles: [], problems: [...problems], ...extra });
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
  const testFiles = tests.map((t) => t.newPath!);

  if (sources.length !== 1) {
    problems.add(sources.length === 0 ? "no-source-change" : "more-than-one-file");
    return done({ testFiles });
  }
  const src = sources[0]!;
  const sourceFile = src.newPath!;
  if (src.oldPath === null) problems.add("new-source-file");
  if (!CODE_EXT.test(sourceFile)) problems.add("not-javascript-or-typescript");
  const changed = src.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== " "));
  if (changed.length === 0) problems.add("no-source-change");
  if (changed.length > MAX_FLOOR_CHANGED) problems.add("change-too-large");
  for (const l of changed) for (const c of excludedLineCategories(l.text)) problems.add(`excluded:${c}`);
  for (const p of floorBaseProblems(src, cfg.baseFiles)) problems.add(p);
  // JSX text is not JavaScript (`<p>Don't</p>` is no string): the code rules cannot read it, so a JSX file never passes.
  if (JSX_EXT.test(sourceFile)) problems.add("jsx-not-judged");
  else for (const p of floorCodeProblems(src, cfg.baseFiles)) problems.add(p);
  // A new test file runs in the target's CI on every later commit once merged: what it may not reach is the same.
  for (const t of tests) for (const l of t.hunks.flatMap((h) => h.lines)) if (l.kind === "+") for (const p of addedLineHazards(l.text, true)) problems.add(p);
  return done({ sourceFile, testFiles });
}

// ---- The merge floor: what the changed code does (#295) ---------------------------------------------------------
//
// The hard-exclude list is a list of words: a check on `order.createdBy !== req.user.id` names none of them, and neither
// does a `fetch` that posts a collection to another host. These rules judge the code itself, deterministically and
// conservatively; each refuses what it cannot read for certain. They are a floor under Gemini's decision and the
// target's own required checks, not a proof that a patch is harmless.

/** The most lines the production file's hunks may add and remove together. Tests are judged apart (new files only). */
const MAX_FLOOR_CHANGED = 40;
/** A file that may hold JSX, which the floor's scanner does not read. */
const JSX_EXT = /\.[cm]?[jt]sx$/i;

/**
 * One piece of JavaScript/TypeScript with every string, template text, regular expression and comment replaced by a
 * placeholder, and those literals in order. A template's `${…}` is code and is kept, inside `(…)`. Null when anything is
 * not read for certain: an unterminated string, template, comment or regex, or a string that runs over a line end.
 */
function lexCode(text: string): { code: string; literals: string[] } | null {
  const n = text.length;
  const literals: string[] = [];
  const out: string[] = [];
  let i = 0;
  /** Reads until the end, or, inside a template's `${`, until its closing `}` (consumed). False when not certain. */
  const run = (inTemplate: boolean): boolean => {
    let depth = 0;
    let regexOk = true;
    while (i < n) {
      const ch = text[i]!;
      if (ch === "/" && text[i + 1] === "/") {
        const e = text.indexOf("\n", i);
        const end = e < 0 ? n : e;
        literals.push(text.slice(i, end));
        out.push("//");
        i = end;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        if (e < 0) return false;
        literals.push(text.slice(i, e + 2));
        out.push("/**/");
        i = e + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        for (; j < n && text[j] !== ch; j++) {
          if (text[j] === "\\") j++;
          else if (text[j] === "\n") return false;
        }
        if (j >= n) return false;
        literals.push(text.slice(i, j + 1));
        out.push(ch + ch);
        i = j + 1;
        regexOk = false;
        continue;
      }
      if (ch === "`") {
        out.push("``");
        i++;
        let start = i;
        for (;;) {
          if (i >= n) return false;
          const c = text[i];
          if (c === "\\") i += 2;
          else if (c === "`") {
            literals.push(text.slice(start, i));
            i++;
            break;
          } else if (c === "$" && text[i + 1] === "{") {
            literals.push(text.slice(start, i));
            i += 2;
            out.push(",(");
            if (!run(true)) return false;
            out.push(")");
            start = i;
          } else i++;
        }
        regexOk = false;
        continue;
      }
      if (ch === "/" && regexOk) {
        let j = i + 1;
        let inClass = false;
        for (; j < n; j++) {
          const c = text[j];
          if (c === "\\") j++;
          else if (c === "\n") return false;
          else if (inClass) inClass = c !== "]";
          else if (c === "[") inClass = true;
          else if (c === "/") break;
        }
        if (j >= n) return false;
        j++;
        while (j < n && /[a-z]/i.test(text[j]!)) j++;
        literals.push(text.slice(i, j));
        out.push("/_/");
        i = j;
        regexOk = false;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i + 1;
        while (j < n && /[\w$]/.test(text[j]!)) j++;
        const word = text.slice(i, j);
        regexOk = BEFORE_EXPRESSION.has(word);
        out.push(word);
        i = j;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        let j = i;
        while (j < n && /[\w.]/.test(text[j]!)) j++;
        out.push(text.slice(i, j));
        regexOk = false;
        i = j;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        if (inTemplate && depth === 0) {
          i++;
          return true;
        }
        depth--;
      }
      if (ch === ")" || ch === "]") regexOk = false;
      else if (!/\s/.test(ch)) regexOk = true;
      out.push(ch);
      i++;
    }
    return !inTemplate;
  };
  return run(false) ? { code: out.join(""), literals } : null;
}

/** Words followed by `(` that are not calls. `new`, `super` and `import` are not here: they are (or are refused) calls. */
const NOT_CALLS = new Set(["if", "for", "while", "switch", "catch", "return", "typeof", "await", "function", "void", "in", "of", "yield", "throw", "case", "do", "else", "instanceof", "async", "with", "delete"]);
/** An optional TypeScript type argument list before a call's `(`: `get<Order>(…)`. Read wide: it may also match a comparison. */
const TYPE_ARGS = String.raw`(?:<[\w$ \t,.|[\]<>]*>\s*)?`; // one line at most: no line end inside
const MEMBER_CALL_RE = new RegExp(String.raw`(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?${TYPE_ARGS}\(`, "g");
const PLAIN_CALL_RE = new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?${TYPE_ARGS}\(`, "g");
/** `new X`, with or without its `(`: the constructor runs either way. `new a.b.C` calls `.C`. */
const NEW_RE = /\bnew\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g;
/** A tagged template calls its tag with no `(`: `` tag`…` ``, in lexed code `` tag`` ``. */
const TAGGED_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*``|\.\s*([A-Za-z_$][\w$]*)\s*``/g;
/** A call of something that is not a name: `fns[k](…)`, `get()(…)`, `(0, f)(…)`, `` x[k]`…` ``. */
const COMPUTED_CALL_RE = /[\])]\s*(?:\?\.\s*)?\(|[\])]\s*``/;

/**
 * The names a piece of lexed code calls: `foo` for `foo(…)`, `.bar` for `x.bar(…)` (by name, never by receiver), and the
 * constructor of every `new`. Declarations count too (`function foo(`, a method `foo() {`): wider is the safe direction.
 */
function callsIn(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(MEMBER_CALL_RE)) out.push(`.${m[1]!}`);
  for (const m of code.matchAll(PLAIN_CALL_RE)) if (!NOT_CALLS.has(m[1]!)) out.push(m[1]!);
  for (const m of code.matchAll(NEW_RE)) {
    const parts = m[1]!.split(".").map((p) => p.trim());
    out.push(parts.length > 1 ? `.${parts.at(-1)!}` : parts[0]!);
  }
  for (const m of code.matchAll(TAGGED_RE)) {
    if (m[1] === undefined) out.push(`.${m[2]!}`);
    else if (!NOT_CALLS.has(m[1]) && m[1] !== "new") out.push(m[1]);
  }
  return out;
}

/**
 * Calls a fix may add though the base file never makes them: pure conversions and checks of a value, and the standard
 * errors a guard throws. Nothing here reaches the network, the disk, a process or the store, or runs text as code.
 * `console` is not here: a value written to the log is not a fix, and the log is what Starfish reads back. A method the
 * base file already calls (`.log`, `.set`) may be added, by name, whatever object it is called on.
 */
const PURE_CALLS = new Set(["String", "Number", "Boolean", "Error", "TypeError", "RangeError", ".isArray", ".isFinite", ".isInteger", ".isNaN"]);

/**
 * The Node process itself (`process.exit`, `process.kill`, `process.env`): refused in production code. A new test file may
 * name it: a plain-node test fails by `process.exit(1)`.
 */
const NODE_PROCESS: readonly [string, RegExp] = ["process", /\bprocess\b/];
/**
 * What added code may not reach, whether or not the base file already does: matched on the line's whole text, strings
 * and comments included (`globalThis["fetch"]`), so a word in a comment refuses too. Wider is the safe direction.
 */
const SINKS: readonly (readonly [string, RegExp])[] = [
  ["network", /\bfetch\b|\baxios\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bundici\b|\bsuperagent\b|\bgot\s*\(|(?<![.\w$])(?:https?|http2|net|tls|dgram|dns)\s*\.\s*[A-Za-z_$]|\brequest\s*\(/],
  ["process", /\bchild_process\b|(?<![.\w$])exec(?:Sync|File|FileSync)?\s*\(|\bspawn(?:Sync)?\b|\bfork\s*\(|\bworker_threads\b|\bWorker\b/],
  NODE_PROCESS,
  ["dynamic-code", /\beval\b|\bFunction\b|\bvm\s*\.|\bglobalThis\b|\bglobal\s*\.|\bReflect\b|\bProxy\b|__proto__|\bconstructor\b|\bprototype\b|\bset(?:Timeout|Interval|Immediate)\s*\(\s*["'`]/],
  ["destructive", /\.\s*delete\b|\bdelete\s|\brecursiveDelete\b|\bdeleteDoc\b|\bdeleteField\b|\.\s*(?:remove|purge|destroy|drop)\s*\(/],
  ["filesystem", /\bfs\b|\bfs\/promises\b|\b(?:writeFile|appendFile|unlink|rmdir|rm|rename|copyFile|createWriteStream|truncate|chmod|chown|symlink|mkdir)(?:Sync)?\s*\(/],
];

/** The sinks a new test file is judged on: all but the Node process itself. */
const TEST_SINKS = SINKS.filter((sink) => sink !== NODE_PROCESS);

/** What one added line reaches on its own: a sink, or an address (`://`) anywhere in it. */
function addedLineHazards(text: string, inTest = false): string[] {
  const out = (inTest ? TEST_SINKS : SINKS).filter(([, re]) => re.test(text)).map(([kind]) => `adds-sink:${kind}`);
  if (text.includes("://")) out.push("adds-url");
  return out;
}

/**
 * A removed line that decides or steers: a condition, a comparison, a boolean operator, `return`, `throw`, a branch or a
 * loop, an `await`, a brace that opens or closes a block, or ANY call: a check is often a call (`checkOrder(o, who);`), and
 * one whose arguments change (`checkOrder(o, o.placedBy)`) checks something else. Removing one is removing a check
 * (#295). Matched on the code, literals blanked; a line not read for certain counts.
 */
const REMOVED_DECIDING_RE = /\b(?:if|else|throw|return|while|for|do|switch|case|default|break|continue|try|catch|finally|yield|await)\b|&&|\|\||\?|[!=]=|[<>]|[{}]/;
const removedDecides = (text: string): boolean => {
  const lexed = lexCode(text);
  return lexed === null || REMOVED_DECIDING_RE.test(lexed.code) || COMPUTED_CALL_RE.test(lexed.code) || callsIn(lexed.code).length > 0;
};

/**
 * `added` is `removed` with only guards added: `?.`, `?? null` / `?? undefined` and `await`, never one taken away, the
 * literals byte for byte. The one way a deciding line may be removed: rewritten as itself, guarded.
 */
function onlyAddsGuards(removed: string, added: string): boolean {
  const r = lexCode(removed);
  const a = lexCode(added);
  if (r === null || a === null) return false;
  if (r.literals.length !== a.literals.length || r.literals.some((l, k) => l !== a.literals[k])) return false;
  const strip = (s: string) => norm(stripOptional(s).replace(/\bawait\s+/g, ""));
  const atLeast = (re: RegExp) => count(a.code, re) >= count(r.code, re);
  return strip(a.code) === strip(r.code) && atLeast(/\?\./g) && atLeast(/\?\?/g) && atLeast(/\bawait\b/g);
}

/**
 * Control flow in an added line: what can skip, repeat or end the code after it. Allowed only as an explicit null guard
 * (`FLOOR_GUARD_RE`), or as the very line a removed one came back as, guarded. Matched on the code, literals blanked; a
 * property of that name (`x.default`) is not one.
 */
const ADDED_CONTROL_RE = /(?<![.\w$])(?:if|else|return|throw|switch|case|default|while|for|do|break|continue|yield|with)\b/;
/** A caught exception is a check that threw and was ignored: `try`, `catch`, `finally`, and a promise's `.catch(`/`.finally(`. */
const ADDED_TRY_RE = /\b(?:try|catch|finally)\b/;

/** One argument of a guard's error: a string, a reference, a number. Never a call or an expression. */
const GUARD_ARG = String.raw`(?:"[^"\\\n]*"|'[^'\\\n]*'|${REF}|\d+)`;
/**
 * What a floor guard does: leave with nothing (`return;`, `return null`, `return undefined`) or throw a new error whose
 * class may be a member (`functions.https.HttpsError`) and whose arguments are strings, references or numbers. Wider
 * than gate 1's `ACTION` only in the error's arguments.
 */
const FLOOR_ACTION = String.raw`(?:return(?:\s+(?:null|undefined))?|throw\s+new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Z][\w$]*\(\s*(?:${GUARD_ARG}(?:\s*,\s*${GUARD_ARG})*)?\s*\))`;
/** Gate 1's explicit null guard (`MISSING_ATOM`: `== null`, `=== undefined`, `typeof x === "undefined"`; never `!x`). */
const FLOOR_GUARD_RE = new RegExp(String.raw`^if\s*\(\s*${MISSING_ATOM}(?:\s*\|\|\s*${MISSING_ATOM})*\s*\)\s*(?:\{\s*${FLOOR_ACTION}\s*;?\s*\}|${FLOOR_ACTION}\s*;)$`);

/** Whether a piece of lexed code closes every `(`, `[` and `{` it opens, in order, and opens every one it closes. */
function bracketsBalance(code: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const ch of code) {
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch in pairs && stack.pop() !== pairs[ch]) return false;
  }
  return stack.length === 0;
}

/** Names a binding in added code could give a new meaning: `const load = fetch`, `(load) => load(url)`, `load = …`. */
function rebinds(code: string, name: string): boolean {
  const n = name.replace(/\$/g, "\\$");
  return [
    new RegExp(String.raw`\b(?:const|let|var|function|class)\b[^=;]*(?<![\w$])${n}(?![\w$])`),
    new RegExp(String.raw`(?<![\w$.])${n}\s*=(?![=>])`),
    new RegExp(String.raw`\([^()]*(?<![\w$.])${n}(?![\w$])[^()]*\)\s*(?::[^=]*)?=>`),
    new RegExp(String.raw`(?<![\w$.])${n}\s*=>`),
    new RegExp(String.raw`\bcatch\s*\(\s*${n}(?![\w$])`),
  ].some((re) => re.test(code));
}

/**
 * The production file's changed code against what it does (#295): no deciding line removed (unless rewritten as itself
 * with only guards added, in the same run of changed lines), no call removed from the file; and the added code holding no
 * control flow but an explicit null guard, no `try`/`catch`, each run's brackets closed within it (nothing existing
 * wrapped in a new block or function), reaching no sink, no address, no call the base file does not already make (but
 * `PURE_CALLS`), no call of something that is not a name, and no new binding for a name the base file calls.
 */
function floorCodeProblems(src: FileDiff, baseFiles: ReadonlyMap<string, string> | undefined): string[] {
  const out = new Set<string>();
  const removedCalls = new Map<string, number>();
  const addedCalls = new Map<string, number>();
  const tally = (into: Map<string, number>, names: readonly string[]) => {
    for (const name of names) into.set(name, (into.get(name) ?? 0) + 1);
  };
  const addedCode: string[] = [];

  for (const hunk of src.hunks) {
    const lines = hunk.lines;
    /** Added lines (by index in the hunk) that are a removed deciding line put back, guarded. */
    const putBack = new Set<number>();
    // Runs of consecutive changed lines: a deciding line removed must come back, guarded, in its own run.
    for (let i = 0; i < lines.length; ) {
      if (lines[i]!.kind === " ") {
        i++;
        continue;
      }
      const removedAt: number[] = [];
      const addedAt: number[] = [];
      for (; i < lines.length && lines[i]!.kind !== " "; i++) (lines[i]!.kind === "-" ? removedAt : addedAt).push(i);
      const free = [...addedAt];
      for (const at of removedAt) {
        const removed = lines[at]!.text;
        const lexed = lexCode(removed);
        tally(removedCalls, lexed === null ? [] : callsIn(lexed.code));
        if (!removedDecides(removed)) continue;
        const k = free.findIndex((a) => onlyAddsGuards(removed, lines[a]!.text));
        if (k < 0) out.add("removes-a-decision");
        else putBack.add(free.splice(k, 1)[0]!);
      }
      const runCode: string[] = [];
      for (const at of addedAt) {
        const added = lines[at]!.text;
        for (const p of addedLineHazards(added)) out.add(p);
        const lexed = lexCode(added);
        if (lexed === null) {
          out.add("added-line-not-understood");
          continue;
        }
        if (COMPUTED_CALL_RE.test(lexed.code)) out.add("adds-a-computed-call");
        tally(addedCalls, callsIn(lexed.code));
        addedCode.push(lexed.code);
        runCode.push(lexed.code);
      }
      // An opening in one run and its closing in another wraps the context between them: `+ if (o === null) {`, the
      // check, `+ }`; or `+ const skip = () => {`, the check, `+ };`, a function never called.
      if (!bracketsBalance(runCode.join("\n"))) out.add("adds-unbalanced-brackets");
    }
    for (const p of addedControlProblems(hunk, putBack)) out.add(p);
  }
  // A call the patch takes out of the file is a step the code no longer takes: a check written as a call
  // (`await assertCanRead(…)`) among them. Moved or kept with a guard added, its count is unchanged.
  for (const [name, n] of removedCalls) if ((addedCalls.get(name) ?? 0) < n) out.add("removes-a-call");

  // A fix reuses what the code already does. The base file's calls, read the same way (its literals and comments
  // blanked, so a `fetch(` in a string or a comment does not count).
  // Unreadable base: nothing added is judged against it, so nothing added passes.
  if (addedCode.length > 0) {
    const newNames = [...addedCalls.keys()].filter((name) => !PURE_CALLS.has(name));
    const raw = src.oldPath === null ? undefined : baseFiles?.get(src.oldPath);
    const baseLexed = raw === undefined ? null : lexCode(raw.replace(/\r\n/g, "\n"));
    if (baseLexed === null) {
      if (raw !== undefined) out.add("base-not-understood");
    } else {
      const baseCalls = new Set(callsIn(baseLexed.code));
      if (newNames.some((name) => !baseCalls.has(name))) out.add("adds-a-new-call");
      const code = addedCode.join("\n");
      for (const name of new Set([...baseCalls, ...PURE_CALLS])) if (!name.startsWith(".") && rebinds(code, name)) out.add("rebinds-a-called-name");
    }
  }
  return [...out];
}

/**
 * Control flow in a hunk's added lines (#295): an added `try`/`catch`/`finally` is refused (a check that throws is then
 * ignored), and an added `if`, `return`, `throw`, loop or branch is allowed only as an explicit null guard (one line, or
 * `if (…) {` / the action / `}`), placed as gate 1 places one: after a line that ends a statement, and before none that
 * would join it or take its `if`. `if (order) return order;` above a check skips it; this refuses it. The lines a removed
 * one came back as (`putBack`) are that line, already judged.
 */
function addedControlProblems(hunk: Hunk, putBack: ReadonlySet<number>): string[] {
  const out = new Set<string>();
  const seq = hunk.lines.flatMap((l, at) => (l.kind === "-" ? [] : [{ ...l, at }]));
  const isNew = (k: number) => seq[k]?.kind === "+" && !putBack.has(seq[k].at);
  const guardAt = (j: number): number => {
    for (const len of [1, 3]) {
      if (!Array.from({ length: len }, (_, d) => isNew(j + d)).every(Boolean)) continue;
      if (!FLOOR_GUARD_RE.test(norm(seq.slice(j, j + len).map((l) => l.text).join(" ")))) continue;
      let prev: string | null | undefined = hunk.oldStart <= 1 && hunk.newStart <= 1 ? null : undefined;
      for (let k = j - 1; k >= 0; k--) {
        if (!isBlankOrComment(seq[k]!.text)) {
          prev = seq[k]!.text;
          break;
        }
      }
      const next = seq[j + len]?.text;
      if (prev === undefined || (prev !== null && !ENDS_STATEMENT_RE.test(prev.trim()))) continue;
      if (next !== undefined && CONTINUES_RE.test(next)) continue;
      return len;
    }
    return 0;
  };
  for (let j = 0; j < seq.length; j++) {
    if (!isNew(j)) continue;
    const lexed = lexCode(seq[j]!.text);
    if (lexed === null) continue; // refused already: added-line-not-understood
    if (ADDED_TRY_RE.test(lexed.code)) {
      out.add("adds-try-catch");
      continue;
    }
    if (!ADDED_CONTROL_RE.test(lexed.code)) continue;
    const len = guardAt(j);
    if (len === 0) out.add("adds-control-flow");
    else j += len - 1;
  }
  return [...out];
}

/**
 * The source file's base content against every hunk (gate 1's `baseProblems`, for any number of hunks and without the
 * context rule): it must be there and hold each hunk's lines where the hunk says, a `\ No newline` marker only at the
 * file's end, and no function a hunk touches may decide anything about access control, money or secrets.
 */
function floorBaseProblems(src: FileDiff, baseFiles: ReadonlyMap<string, string> | undefined): string[] {
  const raw = src.oldPath === null ? undefined : baseFiles?.get(src.oldPath);
  if (raw === undefined) return ["base-not-available"];
  if (hasControlCharacter(raw)) return ["control-characters"];
  const base = raw.replace(/\r\n/g, "\n").split("\n");
  if (base.at(-1) === "") base.pop();
  const whole = base.join("\n");
  const out = new Set<string>();
  const lastHunk = src.hunks.at(-1);
  for (const hunk of src.hunks) {
    const start = hunk.oldStart - 1;
    const old = hunk.lines.filter((l) => l.kind !== "+");
    if (start < 0 || start + old.length > base.length || old.some((l, k) => l.text !== base[start + k])) return ["base-mismatch"];
    const noEol = hunk.noNewlineAtEnd;
    const atEnd = start + hunk.oldCount === base.length;
    if (noEol && (hunk !== lastHunk || !atEnd || (noEol.old && raw.endsWith("\n")))) out.add("no-newline-marker");
    const changedAt = hunk.lines.flatMap((l, i) => (l.kind === " " ? [] : [i]));
    if (changedAt.length === 0) continue;
    for (const l of hunk.lines) if (l.kind === " ") for (const c of decisionCategories(l.text, true)) out.add(`excluded:${c}`);
    const oldIndex = (i: number) => start + hunk.lines.slice(0, i).filter((l) => l.kind !== "+").length;
    const lo = Math.max(0, oldIndex(changedAt[0]!) - 1);
    const hi = Math.min(base.length - 1, oldIndex(changedAt.at(-1)! + 1));
    for (const c of decisionsIn(enclosingText(whole, lo, hi), true)) out.add(`excluded:${c}`);
  }
  return [...out];
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
