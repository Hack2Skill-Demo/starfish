import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { normalizePatch } from "./patchNormalize.js";

// Invented code with the shape of the case that mattered: a handler writes an optional field as `undefined`, and the
// model's fix is one changed line. The first live fix attempts (2026-10-12) were refused as "does not apply" (#317).
const PATH = "app/src/orders/place.ts";
const SOURCE = [
  "      const ref = store.collection('invoices').doc();",
  "      const now = clock.now();",
  "      tx.set(ref, {",
  "        accountId,",
  "        items,",
  "        ...totals,",
  "        promoCode: input.promoCode,",
  "        // Kept so the nightly job can recompute the discount if a total ever drifts.",
  "        promoPercent: promo?.percent ?? null,",
  "        voucherCode: totals.voucherCents > 0 ? input.voucherCode : null,",
  "        wrapped: input.wrapped,",
  "        note: input.note,",
  "        delivery: input.delivery,",
  "        labels: input.labels,",
  "        state: 'open',",
  "      });",
  "",
].join("\n");

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Whether `git apply --check` accepts the patch against a tree holding exactly `files`. */
function gitAccepts(patch: string, files: Record<string, string>): boolean {
  const dir = mkdtempSync(join(tmpdir(), "starfish-normalize-"));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  try {
    execFileSync("git", ["apply", "--check", "--whitespace=nowarn", "-"], { cwd: dir, input: patch, stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

const files = [{ path: PATH, content: SOURCE }];

describe("normalizePatch (#317)", () => {
  it("leaves a correct patch applying and unchanged in effect", () => {
    const good = [
      `--- a/${PATH}`,
      `+++ b/${PATH}`,
      "@@ -4,7 +4,7 @@",
      "         accountId,",
      "         items,",
      "         ...totals,",
      "-        promoCode: input.promoCode,",
      "+        promoCode: input.promoCode ?? null,",
      "         // Kept so the nightly job can recompute the discount if a total ever drifts.",
      "         promoPercent: promo?.percent ?? null,",
      "         voucherCode: totals.voucherCents > 0 ? input.voucherCode : null,",
      "",
    ].join("\n");
    expect(gitAccepts(good, { [PATH]: SOURCE })).toBe(true);
    const out = normalizePatch(good, files);
    expect(gitAccepts(out, { [PATH]: SOURCE })).toBe(true);
    expect(out).toContain("+        promoCode: input.promoCode ?? null,");
  });

  it("puts a/ and b/ on bare file headers: the patch the live model wrote on 2026-10-12", () => {
    // Verbatim shape of the model's answer for the coupon-less checkout: right hunk, no a/ or b/ on the paths. git
    // strips one leading directory, looks for src/orders/place.ts, and refuses it as not applying.
    const live = [
      `--- ${PATH}`,
      `+++ ${PATH}`,
      "@@ -4,3 +4,3 @@",
      "         ...totals,",
      "-        promoCode: input.promoCode,",
      "+        promoCode: input.promoCode ?? null,",
      "         // Kept so the nightly job can recompute the discount if a total ever drifts.",
      "",
    ].join("\n");
    expect(gitAccepts(live, { [PATH]: SOURCE })).toBe(false);
    const out = normalizePatch(live, files);
    expect(out).toContain(`--- a/${PATH}\n+++ b/${PATH}\n`);
    expect(gitAccepts(out, { [PATH]: SOURCE })).toBe(true);
  });

  it("puts b/ on a new file's bare path and leaves already-prefixed paths alone", () => {
    const fresh = ["--- /dev/null", "+++ functions/test/new.test.ts", "@@ -0,0 +1,1 @@", "+one", ""].join("\n");
    expect(normalizePatch(fresh, files)).toContain("+++ b/functions/test/new.test.ts\n");
    const prefixed = [`--- a/${PATH}`, `+++ b/${PATH}`, "@@ -4,1 +4,1 @@", "         accountId,", ""].join("\n");
    expect(normalizePatch(prefixed, files)).toContain(`--- a/${PATH}\n+++ b/${PATH}\n`);
    expect(normalizePatch(prefixed, files)).not.toContain("a/a/");
  });

  it("repairs wrong hunk positions and counts, the model's usual arithmetic slip", () => {
    const wrong = [
      `--- a/${PATH}`,
      `+++ b/${PATH}`,
      "@@ -61,5 +61,5 @@", // the model guessed 61; the lines are at 4
      "         ...totals,",
      "-        promoCode: input.promoCode,",
      "+        promoCode: input.promoCode ?? null,",
      "         // Kept so the nightly job can recompute the discount if a total ever drifts.",
      "",
    ].join("\n");
    expect(gitAccepts(wrong, { [PATH]: SOURCE })).toBe(false);
    const out = normalizePatch(wrong, files);
    expect(gitAccepts(out, { [PATH]: SOURCE })).toBe(true);
    expect(out).toContain("@@ -6,3 +6,3 @@");
  });

  it("accepts a blank context line whose leading space was dropped", () => {
    const src = ["function f() {", "  a();", "", "  b();", "}", ""].join("\n");
    const patch = [`--- a/x.ts`, `+++ b/x.ts`, "@@ -1,9 +1,9 @@", " function f() {", "   a();", "", "-  b();", "+  c();", " }", ""].join("\n");
    expect(gitAccepts(patch, { "x.ts": src })).toBe(false);
    const out = normalizePatch(patch, [{ path: "x.ts", content: src }]);
    expect(gitAccepts(out, { "x.ts": src })).toBe(true);
  });

  it("accepts context that differs from the file only by trailing space", () => {
    const src = ["alpha", "beta", "gamma", ""].join("\n");
    const patch = [`--- a/x.ts`, `+++ b/x.ts`, "@@ -1,3 +1,3 @@", " alpha  ", "-beta", "+BETA", " gamma", ""].join("\n");
    const out = normalizePatch(patch, [{ path: "x.ts", content: src }]);
    expect(gitAccepts(out, { "x.ts": src })).toBe(true);
    expect(out).toContain(" alpha\n"); // the file's own text
  });

  it("handles several hunks in one file, shifting later positions by the earlier hunks", () => {
    const src = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const patch = [
      `--- a/x.ts`,
      `+++ b/x.ts`,
      "@@ -1,1 +1,1 @@",
      " line 3",
      "-line 4",
      "+line 4",
      "+inserted a",
      "+inserted b",
      " line 5",
      "@@ -9,9 +9,9 @@",
      " line 20",
      "-line 21",
      "+line 21 changed",
      " line 22",
      "",
    ].join("\n");
    const out = normalizePatch(patch, [{ path: "x.ts", content: src }]);
    expect(gitAccepts(out, { "x.ts": src })).toBe(true);
    expect(out).toContain("@@ -3,3 +3,5 @@");
    expect(out).toContain("@@ -20,3 +22,3 @@");
  });

  it("recounts a new file's hunk", () => {
    const patch = ["--- /dev/null", "+++ b/test/new.test.ts", "@@ -0,0 +1,99 @@", "+one", "+two", ""].join("\n");
    const out = normalizePatch(patch, files);
    expect(out).toContain("@@ -0,0 +1,2 @@");
    expect(gitAccepts(out, {})).toBe(true);
  });

  it("leaves a section alone when its hunk is not in the file, so the gate still refuses it", () => {
    const patch = [`--- a/${PATH}`, `+++ b/${PATH}`, "@@ -1,2 +1,2 @@", " not a line of the file", "-neither is this", "+nor this", ""].join("\n");
    const out = normalizePatch(patch, files);
    expect(out).toBe(patch);
    expect(gitAccepts(out, { [PATH]: SOURCE })).toBe(false);
  });

  it("leaves a file it was not shown, and a patch it cannot read, exactly as written", () => {
    const other = [`--- a/other.ts`, `+++ b/other.ts`, "@@ -1,1 +1,1 @@", "-a", "+b", ""].join("\n");
    expect(normalizePatch(other, files)).toBe(other);
    expect(normalizePatch("not a diff at all", files)).toBe("not a diff at all");
    const crlf = `--- a/${PATH}\r\n+++ b/${PATH}\r\n@@ -1,1 +1,1 @@\r\n-a\r\n+b\r\n`;
    expect(normalizePatch(crlf, files)).toBe(crlf);
  });

  it("never changes a line the model added", () => {
    const out = normalizePatch(
      [`--- a/${PATH}`, `+++ b/${PATH}`, "@@ -61,3 +61,3 @@", "         ...totals,", "-        promoCode: input.promoCode,", "+        promoCode: input.promoCode ?? null, // x", ""].join("\n"),
      files
    );
    expect(out).toContain("+        promoCode: input.promoCode ?? null, // x\n");
  });
});
