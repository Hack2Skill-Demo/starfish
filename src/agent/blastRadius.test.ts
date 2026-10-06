/**
 * Gate 1 of auto-merge (#9): what a diff may be and still be merged without a person. Each allowed class is shown
 * passing once, and then every way to get past it that we could think of is shown failing: unsure is never allowed.
 */
import { describe, expect, it } from "vitest";
import { assessBlastRadius, excludedPathCategories, isTestPath, parsePatch, testOnlyPatch } from "./blastRadius.js";

const cfg = { excludedPaths: [] as string[] };
const gate = (patch: string, over = cfg) => assessBlastRadius(patch, over);

/** One hunk on one file: `body` is the hunk's lines with their ` `, `-`, `+` prefixes. */
function diff(path: string, body: string[], start = 10): string {
  const old = body.filter((l) => !l.startsWith("+")).length;
  const neu = body.filter((l) => !l.startsWith("-")).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${old} +${start},${neu} @@`, ...body].join("\n") + "\n";
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

const guard = diff(SRC, ["  const order = await load(id);", "+  if (!order) return null;", "   return order.total;"]);
const guardBlock = diff(SRC, ["  const order = await load(id);", "+  if (!order || order.items === undefined) {", "+    return [];", "+  }", "   return order.items;"]);
const chaining = diff(SRC, ["  const order = await load(id);", "-  const n = order.items.length;", "+  const n = order?.items?.length ?? 0;", "   return n;"]);
const missingAwait = diff(SRC, ["  const ref = db.collection(\"orders\").doc(id);", "-  ref.set(data);", "+  await ref.set(data);", "   return ref.id;"]);
const undefinedField = diff(SRC, ["  await ref.set({", "    total: data.total,", "-    couponCode: data.couponCode,", "+    ...(data.couponCode !== undefined && { couponCode: data.couponCode }),", "  });"]);
const coalesceNull = diff(SRC, ["  await ref.set({", "-    note: data.note,", "+    note: data.note ?? null,", "  });"]);

describe("parsePatch", () => {
  it("reads files, hunks and line kinds, with or without a diff --git header", () => {
    const files = parsePatch(guard + addedTest)!;
    expect(files.map((f) => [f.oldPath, f.newPath])).toEqual([[SRC, SRC], [null, TEST]]);
    expect(files[0]!.hunks[0]!.lines.map((l) => l.kind)).toEqual([" ", "+", " "]);
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

  it("allows shorthand fields, throw and continue guards, and `return await`", () => {
    expect(gate(diff(SRC, ["  batch.set(ref, {", "-    coupon,", "+    ...(coupon !== undefined && { coupon }),", "  });"])).allowed).toBe(true);
    expect(gate(diff(SRC, ["  for (const o of list) {", "+    if (o.items == null) continue;", "     total += o.items.length;"])).allowed).toBe(true);
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
    refused(diff(SRC, ["  const o = get(id);", "+  if (!o) return null;", "   x();", "-  ref.set(o);", "+  await ref.set(o);", "  y();"]), "mixed-classes");
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

  it("refuses a test file that loses lines: deleting the test that judges a patch must not pass", () => {
    refused(guard + diff(TEST, [" it(\"x\", () => {", "-  expect(f()).toBe(1);", " });"]), "test-lines-removed");
  });

  it("refuses deletes, renames, mode changes and binary files", () => {
    refused(["diff --git a/functions/src/a.ts b/functions/src/a.ts", "deleted file mode 100644", "--- a/functions/src/a.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x"].join("\n") + "\n", "file-deleted");
    refused(["diff --git a/x.ts b/y.ts", "similarity index 100%", "rename from x.ts", "rename to y.ts"].join("\n") + "\n" + guard, "rename-or-copy");
    refused(["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"].join("\n") + "\n" + guard, "mode-change");
    refused(["diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ"].join("\n") + "\n" + guard, "binary");
  });

  it("refuses a change too large or too spread out to be one small fix", () => {
    const big = ["  const o = get(id);", ...Array.from({ length: 9 }, (_, i) => `+  if (!o${i}) return null;`), "   return o;"];
    refused(diff(SRC, big), "change-too-large");
  });

  it("refuses anything that is not JavaScript or TypeScript", () => {
    refused(diff("functions/main.py", ["  o = get(id)", "+  if (!o) return null;", "   return o"]), "not-javascript-or-typescript");
  });
});

describe("assessBlastRadius: the hard-exclude list", () => {
  const guardIn = (path: string) => diff(path, ["  const o = get(id);", "+  if (!o) return null;", "   return o;"]);
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
