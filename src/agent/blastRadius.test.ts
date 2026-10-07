/**
 * Gate 1 of auto-merge (#9): what a diff may be and still be merged without a person. Each allowed class is shown
 * passing once, and then every way to get past it that we could think of is shown failing: unsure is never allowed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessBlastRadius, excludedPathCategories, isTestPath, judgedTheVerifiedFiles, parsePatch, testOnlyPatch, type BlastRadiusConfig } from "./blastRadius.js";

/**
 * The base revision of every file a patch changes, as the patch's own old side: each hunk's context and removed lines
 * at its line numbers, gaps blank. The helpers below start every hunk at line 1 and end it with the file, so this is the
 * whole file.
 */
function basesOf(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of parsePatch(patch) ?? []) {
    if (f.oldPath === null) continue;
    const lines: string[] = [];
    for (const h of f.hunks) {
      let at = h.oldStart - 1;
      for (const l of h.lines) if (l.kind !== "+") lines[at++] = l.text;
    }
    out.set(f.oldPath, Array.from(lines, (l) => l ?? "").join("\n") + "\n");
  }
  return out;
}
const gate = (patch: string, over: Partial<BlastRadiusConfig> = {}) => assessBlastRadius(patch, { excludedPaths: [], baseFiles: basesOf(patch), ...over });

/** A handler around every hunk the helpers build: the change is inside one function, with the file's start and end. */
const PRE = [" export async function handler(id, data) {", "   const started = Date.now();", '   log("start", id);'];
const POST = ['   log("done", started);', " }"];
/** One hunk on one file, wrapped in PRE/POST: `body` is the hunk's lines with their ` `, `-`, `+` prefixes. */
function diff(path: string, body: string[], wrap = true): string {
  const all = wrap ? [...PRE, ...body, ...POST] : body;
  const old = all.filter((l) => !l.startsWith("+")).length;
  const neu = all.filter((l) => !l.startsWith("-")).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${old} +1,${neu} @@`, ...all].join("\n") + "\n";
}
const SRC = "functions/src/orders/createOrder.ts";
const TEST = "functions/src/orders/createOrder.test.ts";
const addedTest = [
  `diff --git a/${TEST} b/${TEST}`,
  "new file mode 100644",
  "--- /dev/null",
  `+++ b/${TEST}`,
  "@@ -0,0 +1,3 @@",
  '+it("works without a coupon", async () => {',
  "+  expect(await createOrder({})).toBeDefined();",
  "+});",
].join("\n") + "\n";

const guard = diff(SRC, ["  const order = await load(id);", "+  if (order == null) return null;", "   return order.total;"]);
const guardBlock = diff(SRC, ["  const order = await load(id);", "+  if (order === null || order === undefined || order.items === undefined) {", "+    return undefined;", "+  }", "   return order.items;"]);
const chaining = diff(SRC, ["  const order = await load(id);", "-  const n = order.items.length;", "+  const n = order?.items?.length ?? 0;", "   return n;"]);
const missingAwait = diff(SRC, ["  const ref = db.collection(\"orders\").doc(id);", "-  ref.set(data);", "+  await ref.set(data);", "   return ref.id;"]);
const undefinedField = diff(SRC, ["  await ref.set({", "    total: data.total,", "-    couponCode: data.couponCode,", "+    ...(data.couponCode !== undefined && { couponCode: data.couponCode }),", "  });"]);
const coalesceNull = diff(SRC, ["  await ref.set({", "-    note: data.note,", "+    note: data.note ?? null,", "  });"]);

describe("parsePatch", () => {
  it("reads files, hunks and line kinds, with or without a diff --git header", () => {
    const files = parsePatch(guard + addedTest)!;
    expect(files.map((f) => [f.oldPath, f.newPath])).toEqual([[SRC, SRC], [null, TEST]]);
    expect(files[0]!.hunks[0]!.lines.map((l) => l.kind)).toEqual([" ", " ", " ", " ", "+", " ", " ", " "]);
    expect(parsePatch("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n")).toHaveLength(1);
  });
  it("is null (unsure) for anything it does not understand", () => {
    expect(parsePatch("")).toBeNull();
    expect(parsePatch("not a diff\n")).toBeNull();
    expect(parsePatch("--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n")).toBeNull(); // counts do not add up
    expect(parsePatch('--- "a/we ird.ts"\n+++ "b/we ird.ts"\n@@ -1 +1 @@\n-a\n+b\n')).toBeNull();
    expect(parsePatch("--- a/x.ts\n@@ -1 +1 @@\n-a\n+b\n")).toBeNull(); // no +++ header
    expect(parsePatch("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\ngarbage\n")).toBeNull();
  });
});

describe("assessBlastRadius: the allowed classes", () => {
  it.each([
    ["an early return when a value is missing", guard, "null-guard"],
    ["a multi-line guard with ||", guardBlock, "null-guard"],
    ["optional chaining and ?? a literal", chaining, "null-guard"],
    ["a missing await", missingAwait, "missing-await"],
    ["a field written only when defined", undefinedField, "firestore-undefined-field"],
    ["a field written as ?? null", coalesceNull, "firestore-undefined-field"],
  ])("allows %s", (_name, patch, fixClass) => {
    const r = gate(patch);
    expect(r).toMatchObject({ allowed: true, fixClass, sourceFile: SRC, problems: [] });
  });

  it("allows an added test file beside the one source change, and names it", () => {
    expect(gate(guard + addedTest)).toMatchObject({ allowed: true, fixClass: "null-guard", testFiles: [TEST] });
  });

  it("allows shorthand fields, a bare return and throw guards, and `return await`", () => {
    expect(gate(diff(SRC, ["  batch.set(ref, {", "-    coupon,", "+    ...(coupon !== undefined && { coupon }),", "  });"])).allowed).toBe(true);
    expect(gate(diff(SRC, ["  const o = get(id);", "+  if (o.items == null) return;", "   total += o.items.length;"])).allowed).toBe(true);
    expect(gate(diff(SRC, ["  const o = get(id);", '+  if (typeof o === "undefined") throw new NotFoundError("no order");', "   return o;"])).allowed).toBe(true);
    expect(gate(diff(SRC, ["  const ref = doc(id);", "-  return ref.get();", "+  return await ref.get();", " }"])).allowed).toBe(true);
  });
});

describe("assessBlastRadius: never on unsure (adversarial diffs)", () => {
  const refused = (patch: string, problem: string) => {
    const r = gate(patch);
    expect(r.allowed).toBe(false);
    expect(r.problems).toContain(problem);
  };

  it("refuses a guard that does more than exit", () => {
    refused(diff(SRC, ["  const o = get(id);", "+  if (!o) return sendEmail(o);", "   return o;"]), "not-an-allowed-class");
    refused(diff(SRC, ["  const o = get(id);", "+  if (!o) { o = {}; }", "   return o;"]), "not-an-allowed-class");
    refused(diff(SRC, ["  const o = get(id);", "+  if (o.isDeleted) return null;", "   return o;"]), "not-an-allowed-class"); // not a missing check
    refused(diff(SRC, ["  const o = get(id);", "+  if (!load(id)) return null;", "   return o;"]), "not-an-allowed-class"); // a call in the condition
    refused(diff(SRC, ["  const o = get(id);", "+  if (o != null) return null;", "   return o;"]), "not-an-allowed-class");
    refused(diff(SRC, ["  const o = get(id);", "+  if (!o) return null; deleteAll();", "   return o;"]), "not-an-allowed-class");
  });

  it("refuses a guard that returns a decision instead of leaving: `!x` is any falsy value, not only a missing one (#202)", () => {
    for (const exit of ["return true;", "return false;", "return 0;", 'return "ok";', "return [];", "return {};", "continue;", "break;"]) {
      refused(diff(SRC, ["  const o = get(id);", `+  if (!o.flagged) ${exit}`, "   return check(o);"]), "not-an-allowed-class");
    }
  });

  it("refuses an access-control path, whatever its word for it (#202)", () => {
    for (const path of ["src/guards/isOwner.ts", "src/policies/canRead.ts", "src/firebase/appCheck.ts", "functions/src/verifyRequest.ts", "src/app-check/x.ts", "src/canShip.ts"]) {
      const r = gate(diff(path, ["  const doc = get(id);", "+  if (doc == null) return null;", "   return doc.total;"]));
      expect(r.problems, path).toContain("excluded:access-control");
    }
    expect(excludedPathCategories("src/scanner/cancel.ts")).toEqual([]); // "can" is a word, not a prefix
  });

  it("refuses a guard whose context is an ownership check: the guard changes what that check decides (#202)", () => {
    refused(diff(SRC, ["  const doc = await get(id);", "+  if (doc == null) return null;", "   return doc.ownerId === user.uid;"]), "excluded:access-control");
    refused(diff(SRC, ["  if (!context.auth) throw new HttpsError(\"unauthenticated\");", "+  if (order == null) return null;", "   return order.total;"]), "excluded:access-control");
  });

  it("does not take a context line that only carries an access word for a check: the order's owner written with it", () => {
    const write = diff(SRC, ["  await ref.set({", "    uid,", "    items: input.items,", "-    couponCode: input.couponCode,", "+    ...(input.couponCode !== undefined && { couponCode: input.couponCode }),", "    status: \"pending\",", "  });"]);
    expect(gate(write)).toMatchObject({ allowed: true, fixClass: "firestore-undefined-field" });
  });

  it("refuses a line changed beyond the class", () => {
    refused(diff(SRC, ["  x();", "-  ref.set(data);", "+  await ref.set(other);", "  y();"]), "not-an-allowed-class");
    refused(diff(SRC, ["  x();", "-  const n = order.items.length;", "+  const n = order?.items?.length ?? compute();", "  y();"]), "not-an-allowed-class");
    refused(diff(SRC, ["  x();", "-  const n = order.items.length;", "+  const n = order?.items?.size;", "  y();"]), "not-an-allowed-class");
    refused(diff(SRC, ["  x();", "-    couponCode: data.couponCode,", "+    ...(data.other !== undefined && { couponCode: data.couponCode }),", "  y();"]), "not-an-allowed-class");
    refused(diff(SRC, ["  x();", "-    couponCode: data.couponCode,", "+    couponCode: data.couponCode || null,", "  y();"]), "not-an-allowed-class");
    refused(diff(SRC, ["  x();", '-  log("saved");', '+  log("await saved");', "  y();"]), "not-an-allowed-class");
    refused(diff(SRC, ["  x();", "-  const a = 1;", "  y();"]), "not-an-allowed-class"); // a pure removal
  });

  it("refuses two classes in one patch", () => {
    refused(diff(SRC, ["  const o = get(id);", "+  if (o == null) return null;", "   x();", "-  ref.set(o);", "+  await ref.set(o);", "  y();"]), "mixed-classes");
  });

  it("refuses more than one function: two hunks, a definition between the changes, a module-level line", () => {
    const two = guard + ["@@ -80,2 +81,3 @@", "  const p = get(id);", "+  if (!p) return null;", "   return p;"].join("\n") + "\n";
    expect(parsePatch(two)![0]!.hunks).toHaveLength(2);
    refused(two, "more-than-one-function");
    refused(diff(SRC, ["  const o = get(id);", "+  if (!o) return null;", " }", " ", " export async function other(id) {", "+  if (!id) return null;", "   return id;"]), "more-than-one-function");
    refused(diff(SRC, ["  const o = get(id);", "+  if (!o) return null;", "   const f = () => 1;", "+  if (!f) return null;", "   return o;"]), "more-than-one-function");
    refused(diff(SRC, [" const o = get(id);", "+if (!o) return null;", " export default o;"]), "more-than-one-function");
  });

  it("refuses more than one production file, and a new one", () => {
    refused(guard + diff("functions/src/orders/listOrders.ts", ["  const o = get(id);", "+  if (!o) return null;", "   return o;"]), "more-than-one-file");
    const created = ["diff --git a/functions/src/orders/x.ts b/functions/src/orders/x.ts", "new file mode 100644", "--- /dev/null", "+++ b/functions/src/orders/x.ts", "@@ -0,0 +1 @@", "+if (!o) return null;"].join("\n") + "\n";
    refused(created, "new-source-file");
    refused(addedTest, "no-source-change");
  });

  it("refuses any change to a test file that already exists: tests may only be added as new files (#204)", () => {
    // Losing a line: deleting the test that judges a patch.
    refused(guard + diff(TEST, [' it("x", () => {', "-  expect(f()).toBe(1);", " });"], false), "existing-test-file-changed");
    // Gaining lines can switch existing tests off just as well. A deny-list of what added lines may not say cannot be
    // completed: a whole new describe can still re-define a matcher the existing tests use (the review's proof).
    const extend = [
      " import { describe, it, expect } from \"vitest\";",
      ' import { createOrder } from "./createOrder";',
      " ",
      '+describe("no coupon", () => { expect.extend({ toThrow: () => ({ pass: true, message: () => "" }) }); it("works", () => { expect(createOrder({})).toBeDefined(); }); });',
      ' describe("createOrder", () => {',
      '   it("rejects zero", () => {',
      "     expect(() => createOrder({ qty: 0 })).toThrow();",
    ];
    refused(guard + diff(TEST, extend, false), "existing-test-file-changed");
    for (const added of [
      ['+it("works without a coupon", async () => {', "+  expect(await createOrder({})).toEqual({ total: 0, items: [] });", "+});"],
      ['+vi.spyOn(console, "error").mockImplementation(() => {});'],
      ['+Object.defineProperty(globalThis, "fetch", { value: () => null });'],
      ['+it.skip("x", () => {});'],
      ["+    return;"],
    ]) {
      refused(guard + diff(TEST, [" });", ...added, ' it("y", () => {});'], false), "existing-test-file-changed");
    }
  });

  it("still allows a new test file, and only one made of added lines", () => {
    expect(gate(guard + addedTest)).toMatchObject({ allowed: true, testFiles: [TEST] });
    expect(gate(addedTest + guard)).toMatchObject({ allowed: true, testFiles: [TEST] });
  });

  it("refuses a new test file that is not a test by name, or a mock or snapshot directory's file", () => {
    const created = (path: string) =>
      [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1 @@", "+export const x = 1;"].join("\n") + "\n";
    for (const path of ["test/helpers.ts", "tests/setup.js", "src/__tests__/__mocks__/db.test.ts", "test/__snapshots__/a.test.ts.snap"]) {
      const r = gate(guard + created(path));
      expect(r.allowed, path).toBe(false);
      expect(r.problems, path).toContain("test-file-not-a-test");
    }
  });

  it("refuses a carriage return, a Unicode line or paragraph separator, or another control character anywhere (#204)", () => {
    // The review's proof: JS ends a line at a lone CR, so this "comment" runs `return;` and unregisters the tests after it.
    const crInExisting = [' describe("shipOrder", () => {', '+  it("none", () => { expect(f()).toBeUndefined(); });', "+  // covered elsewhere\r  return;", '   it("rejects zero", () => {'];
    refused(guard + diff(TEST, crInExisting, false), "control-characters");
    const inNewTest = addedTest.replace("+});", "+}); // done\r  process.exitCode = 0;");
    refused(guard + inNewTest, "control-characters");
    for (const ch of ["\u2028", "\u2029", "\u0000", "\u000b", "\u000c", "\u001b", "\u007f", "\u0085", "\u200b", "\u202e", "\u2066", "\ufeff"]) {
      refused(diff(SRC, ["  const order = await load(id);", `+  if (order == null) return null; //${ch}`, "   return order.total;"]), "control-characters");
      refused(diff(SRC, [`  const order = await load(id); //${ch}`, "+  if (order == null) return null;", "   return order.total;"]), "control-characters");
    }
    // A tab is ordinary, and a CRLF file's line endings are not a lone CR.
    expect(gate(diff(SRC, ["  const order = await load(id);", "+\tif (order == null) return null;", "   return order.total;"])).allowed).toBe(true);
    expect(gate(guard.replace(/\n/g, "\r\n")).allowed).toBe(true);
  });

  it("refuses a header path git would read differently, and a rename hidden in the headers (#200)", () => {
    const evil = "test/src/inventory.ts";
    const unprefixed = [`--- ${evil}`, `+++ ${evil}`, "@@ -1 +1,2 @@", " x();", '+fetch("https://evil.example/");'].join("\n") + "\n";
    // git apply (-p1) strips `test/`, and writes src/inventory.ts: a second production file, read here as a test.
    expect(parsePatch(guard + unprefixed)).toBeNull();
    refused(guard + unprefixed, "diff-not-understood");
    refused(guard + [`diff --git a/${evil} b/${evil}`, `--- b/${evil}`, `+++ a/${evil}`, "@@ -1 +1,2 @@", " x();", "+y();"].join("\n") + "\n", "diff-not-understood");
    // A rename with no `rename from` header: two names in the headers.
    const renamed = ["diff --git a/src/other.ts b/test/x.test.ts", "--- a/src/other.ts", "+++ b/test/x.test.ts", "@@ -1 +1,2 @@", " x();", "+y();"].join("\n") + "\n";
    refused(guard + renamed, "rename-or-copy");
    // diff --git names one file and the headers another.
    const mismatched = ["diff --git a/src/other.ts b/src/other.ts", "--- a/test/x.test.ts", "+++ b/test/x.test.ts", "@@ -1 +1,2 @@", " x();", "+y();"].join("\n") + "\n";
    expect(parsePatch(mismatched)).toBeNull();
    // A diff --git section with no file headers at all.
    refused(guard + "diff --git a/src/other.ts b/test/x.test.ts\n", "no-file-headers");
  });

  it("refuses deletes, renames, mode changes and binary files", () => {
    refused(["diff --git a/functions/src/a.ts b/functions/src/a.ts", "deleted file mode 100644", "--- a/functions/src/a.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x"].join("\n") + "\n", "file-deleted");
    refused(["diff --git a/x.ts b/y.ts", "similarity index 100%", "rename from x.ts", "rename to y.ts"].join("\n") + "\n" + guard, "rename-or-copy");
    refused(["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"].join("\n") + "\n" + guard, "mode-change");
    refused(["diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ"].join("\n") + "\n" + guard, "binary");
  });

  it("refuses a change too large or too spread out to be one small fix", () => {
    const big = ["  const o = get(id);", ...Array.from({ length: 9 }, (_, i) => `+  if (o${i} == null) return null;`), "   return o;"];
    refused(diff(SRC, big), "change-too-large");
  });

  it("refuses anything that is not JavaScript or TypeScript", () => {
    refused(diff("functions/main.py", ["  o = get(id)", "+  if (!o) return null;", "   return o"]), "not-javascript-or-typescript");
  });
});

describe("assessBlastRadius: the hard-exclude list", () => {
  const guardIn = (path: string) => diff(path, ["  const o = get(id);", "+  if (o == null) return null;", "   return o;"]);
  it.each([
    ["functions/src/auth/verify.ts", "access-control"],
    ["functions/src/authMiddleware.ts", "access-control"],
    ["functions/src/admin/users.ts", "access-control"],
    ["firestore.rules", "security-rules"],
    ["storage.rules", "security-rules"],
    ["functions/src/payments/charge.ts", "money"],
    ["functions/src/stripeWebhook.ts", "money"],
    ["functions/src/crypto/sign.ts", "secrets"],
    ["functions/src/secrets.ts", "secrets"],
    ["db/migrations/001_add.ts", "schema"],
    ["firestore.indexes.json", "schema"],
    ["package.json", "dependencies"],
    ["pnpm-lock.yaml", "dependencies"],
    ["node_modules/x/index.js", "dependencies"],
    [".github/workflows/ci.yml", "ci-config"],
    ["cloudbuild.yaml", "ci-config"],
    ["firebase.json", "dependencies"],
    ["functions/src/config.ts", "ci-config"],
    ["packages/core/index.ts", "shared-package"],
    ["functions/src/shared/db.ts", "shared-package"],
    ["functions/src/utils/format.ts", "shared-package"],
  ])("%s is %s", (path, category) => {
    expect(excludedPathCategories(path)).toContain(category);
    const r = gate(guardIn(path));
    expect(r.allowed).toBe(false);
    expect(r.problems).toContain(`excluded:${category}`);
  });

  it("excludes what the deployment lists, test files included", () => {
    expect(gate(guard, { excludedPaths: ["functions/src/orders/"] }).problems).toContain("excluded:configured");
    expect(gate(guard + addedTest, { excludedPaths: ["*.test.ts"] }).problems).toContain("excluded:configured");
  });

  it.each([
    ["an access check", "+  if (!context.auth) return null;"],
    ["a role", "+  if (!user.role) return null;"],
    ["money", "+  if (!order.amount) return null;"],
    ["a key", "+  if (!process.env.KEY) return null;"],
    ["a checkout session", "+  if (!checkoutSession.url) return null;"],
    ["an import", "+import { x } from \"y\";"],
    ["a require", "+  if (!require(\"x\")) return null;"],
  ])("refuses a changed line that touches %s, whatever the path", (_name, line) => {
    const r = gate(diff(SRC, ["  const o = get(id);", line, "   return o;"]));
    expect(r.allowed).toBe(false);
    expect(r.problems.some((p) => p.startsWith("excluded:"))).toBe(true);
  });

  it("does not exclude ordinary product code", () => {
    expect(excludedPathCategories(SRC)).toEqual([]);
    expect(excludedPathCategories(TEST)).toEqual([]);
  });
});

describe("assessBlastRadius: a null guard checks for null or undefined, never for any falsy value (#202)", () => {
  const at = (cond: string) => gate(diff(SRC, ["  const o = await load(id);", `+  if (${cond}) return null;`, "   return o.total;"]));
  it.each(["o == null", "o === null", "o === undefined", "o == undefined", 'typeof o === "undefined"', "typeof o == 'undefined'", "null == o", "undefined === o", "o == null || o.items == null", "o?.items === undefined"])(
    "allows `if (%s)`",
    (cond) => {
      expect(at(cond)).toMatchObject({ allowed: true, fixClass: "null-guard" });
    }
  );
  it.each(["!o", "!o.items", "!o?.items", "o == null || !o.items", "!o || o.items == null", "!!o", "o == 0", "o === false", 'o === ""', "o != null"])("refuses `if (%s)`: true for 0, \"\", false or NaN too", (cond) => {
    expect(at(cond)).toMatchObject({ allowed: false });
    expect(at(cond).problems).toContain("not-an-allowed-class");
  });
});

describe("assessBlastRadius: the whole function in the base file, not only the context the patch chose (#202)", () => {
  const FILE = "functions/src/docs/denialReason.ts";
  /** One function, and a line after it; `line2` is its second line, a decision far from the change. */
  const base = (line2: string) =>
    [
      "export function denialReason(doc: Doc, user: User): string | null {",
      line2,
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  const meta = doc.meta;",
      "  log(meta);",
      "  const d = 4;",
      "  const e = 5;",
      "  const f = 6;",
      "  return null;",
      "}",
      "",
      "export const other = 1;",
    ].join("\n") + "\n";
  /** The guard after `const meta`, with three lines of context on each side, in a file whose line 1 is `first`. */
  const hunkAt = (first: number) =>
    diff(FILE, ["   const b = 2;", "   const c = 3;", "   const meta = doc.meta;", "+  if (meta == null) return null;", "   log(meta);", "   const d = 4;", "   const e = 5;"], false)
      .replace("@@ -1,", `@@ -${first + 3},`)
      .replace(" +1,", ` +${first + 3},`);
  const patch = hunkAt(1);
  const withBase = (line2: string) => gate(hunkAt(1 + line2.split("\n").length - 1), { baseFiles: new Map([[FILE, base(line2)]]) });
  /** The same function after `before` (whole lines). */
  const after = (before: string[]) => gate(hunkAt(before.length + 1), { baseFiles: new Map([[FILE, [...before, base("  const z = 0;")].join("\n")]]) });

  it("allows the guard when nothing in the function decides access, money or a secret", () => {
    expect(withBase("  const z = 0;")).toMatchObject({ allowed: true, fixClass: "null-guard" });
  });

  it.each([
    ["an ownership check", "  if (doc.ownerId !== user.uid) return \"not yours\";", "excluded:access-control"],
    ["an auth check over two lines", "  if (\n    !context.auth\n  ) throw new Error(\"x\");", "excluded:access-control"],
    ["a return of an ownership test, split over lines", "  if (gone(doc)) return (\n    doc.owner\n  );", "excluded:access-control"],
    ["a money decision", "  if (order.amount > 0) charge(order);", "excluded:money"],
    ["a secret compared", "  if (signature !== expected) throw new Error(\"bad\");", "excluded:secrets"],
  ])("refuses the guard when the function holds %s outside the hunk", (_name, line2, problem) => {
    const r = withBase(line2);
    expect(r.allowed).toBe(false);
    expect(r.problems).toContain(problem);
  });

  it("judges only the enclosing function: a check in another function of the file does not count", () => {
    expect(after(["export function isOwner(doc: Doc, uid: string): boolean {", "  return doc.ownerId === uid;", "}", ""])).toMatchObject({ allowed: true });
    expect(after(["export const isOwner = (doc: Doc, uid: string): boolean => {", "  return doc.ownerId === uid;", "};", ""])).toMatchObject({ allowed: true });
  });

  it("judges the whole file when it cannot delimit the function for certain", () => {
    for (const odd of ["const s = 'unterminated", "const r = /unterminated", "const t = `${"]) {
      const r = after(["export function isOwner(doc: Doc, uid: string): boolean {", "  return doc.ownerId === uid;", "}", odd]);
      expect(r.allowed, odd).toBe(false);
      expect(r.problems, odd).toContain("excluded:access-control");
    }
  });

  it("refuses with no base content (fail closed), and when the base does not hold the hunk's lines", () => {
    expect(gate(patch, { baseFiles: new Map() })).toMatchObject({ allowed: false, problems: expect.arrayContaining(["base-not-available"]) });
    expect(gate(patch, { baseFiles: undefined })).toMatchObject({ allowed: false, problems: expect.arrayContaining(["base-not-available"]) });
    expect(gate(patch, { baseFiles: new Map([[FILE, base("  const z = 0;").replace("const meta = doc.meta", "const meta = doc.other")]]) })).toMatchObject({ allowed: false, problems: expect.arrayContaining(["base-mismatch"]) });
  });

  it("refuses a hunk with fewer than 3 lines of context on a side, unless that side is the file's start or end", () => {
    const thin = diff(FILE, ["   const c = 3;", "   const meta = doc.meta;", "+  if (meta == null) return null;", "   log(meta);"], false).replace("@@ -1,", "@@ -5,").replace(" +1,", " +5,");
    expect(gate(thin, { baseFiles: new Map([[FILE, base("  const z = 0;")]]) })).toMatchObject({ allowed: false, problems: expect.arrayContaining(["too-little-context"]) });
    // The helpers' hunks start at line 1 and end with the file: less context is all there is.
    expect(gate(guard)).toMatchObject({ allowed: true });
  });

  it("keeps the demo's CODE-01 fix allowed, judged against the fixture's real handler", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../fixtures/incidents/firestore-undefined-field.json", import.meta.url), "utf8")) as { context: { path: string; excerpt: string }[] };
    const { path, excerpt } = fixture.context[0]!;
    const lines = excerpt.split("\n");
    const at = lines.findIndex((l) => l.trim() === "couponCode: input.couponCode,");
    expect(at).toBeGreaterThan(3);
    const hunk = [
      ...lines.slice(at - 3, at).map((l) => ` ${l}`),
      `-${lines[at]!}`,
      "+    ...(input.couponCode !== undefined && { couponCode: input.couponCode }),",
      ...lines.slice(at + 1, at + 4).map((l) => ` ${l}`),
    ];
    const fix = diff(path, hunk, false).replace("@@ -1,", `@@ -${at - 2},`).replace(" +1,", ` +${at - 2},`);
    expect(gate(fix, { baseFiles: new Map([[path, excerpt + "\n"]]) })).toMatchObject({ allowed: true, fixClass: "firestore-undefined-field", problems: [] });
  });
});

describe("isTestPath and testOnlyPatch", () => {
  it("knows a test file by its path", () => {
    expect(isTestPath("a/b.test.ts")).toBe(true);
    expect(isTestPath("a/b.spec.jsx")).toBe(true);
    expect(isTestPath("test/b.ts")).toBe(true);
    expect(isTestPath("src/__tests__/b.ts")).toBe(true);
    expect(isTestPath("src/attest.ts")).toBe(false);
    expect(isTestPath("src/contest/b.ts")).toBe(false);
  });

  it("is exactly the test files' part of the patch, and parses on its own", () => {
    const only = testOnlyPatch(guard + addedTest)!;
    expect(only).toBe(addedTest);
    expect(parsePatch(only)!.map((f) => f.newPath)).toEqual([TEST]);
  });

  it("is null with no test file, with only test files, or for a patch it does not understand", () => {
    expect(testOnlyPatch(guard)).toBeNull();
    expect(testOnlyPatch(addedTest)).toBeNull();
    expect(testOnlyPatch("garbage")).toBeNull();
  });
});

describe("judgedTheVerifiedFiles (#200)", () => {
  it("holds only when gate 1's files are exactly the files the verify gate saw change", () => {
    const r = gate(guard + addedTest);
    expect(judgedTheVerifiedFiles(r, [TEST, SRC])).toBe(true);
    expect(judgedTheVerifiedFiles(r, [SRC, TEST, "functions/src/inventory.ts"])).toBe(false); // git wrote a file gate 1 never read
    expect(judgedTheVerifiedFiles(r, [SRC])).toBe(false);
    expect(judgedTheVerifiedFiles(r, [])).toBe(false);
    expect(judgedTheVerifiedFiles({ testFiles: [] }, [])).toBe(false);
  });
});
