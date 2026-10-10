import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { capHolds, correctedAtMillis, levelCap, readCorrection, ruleMatches, validateClassRules, type ClassRule } from "./triageRules.js";

const payments: ClassRule = { id: "payments-human", match: { service: "payments" }, maxLevel: "log" };
const noisy: ClassRule = { id: "health-noise", match: { functionName: "healthCheck", errorType: "TimeoutError" }, maxLevel: "noise" };
const noMerge: ClassRule = { id: "orders-no-merge", match: { service: "orders" }, maxLevel: "fix" };

describe("validateClassRules", () => {
  it("accepts rules, trimming values and dropping an empty note", () => {
    expect(
      validateClassRules([
        { id: "payments-human", match: { service: " payments " }, maxLevel: "log", note: " money " },
        { id: "health-noise", match: { functionName: "healthCheck", errorType: "TimeoutError" }, maxLevel: "noise", note: "" },
      ])
    ).toEqual({
      ok: true,
      rules: [
        { id: "payments-human", match: { service: "payments" }, maxLevel: "log", note: "money" },
        { id: "health-noise", match: { functionName: "healthCheck", errorType: "TimeoutError" }, maxLevel: "noise" },
      ],
    });
    expect(validateClassRules([])).toEqual({ ok: true, rules: [] });
  });

  it.each([
    ["not a list", { id: "x" }],
    ["too many", Array.from({ length: 51 }, (_, n) => ({ id: `r${n}x`, match: { service: "s" }, maxLevel: "log" }))],
    ["a duplicate id", [payments, payments]],
    ["a bad id", [{ ...payments, id: "Payments" }]],
    ["merge as a level: a rule can only hold back", [{ ...payments, maxLevel: "merge" }]],
    ["an unknown level", [{ ...payments, maxLevel: "page" }]],
    ["an empty match", [{ ...payments, match: {} }]],
    ["an unknown match key", [{ ...payments, match: { message: "x" } }]],
    ["an empty match value", [{ ...payments, match: { service: " " } }]],
    ["a control character", [{ ...payments, match: { service: "pay\nments" } }]],
    ["a value too long", [{ ...payments, match: { service: "s".repeat(201) } }]],
    ["an unknown key", [{ ...payments, extra: true }]],
    ["a note too long", [{ ...payments, note: "n".repeat(301) }]],
  ])("refuses %s, naming the rule and never the value", (_name, raw) => {
    const r = validateClassRules(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toMatch(/^classRules: /);
      expect(r.problem).not.toContain("pay\nments");
    }
  });
});

describe("ruleMatches", () => {
  it("matches only when every field the rule names is equal", () => {
    expect(ruleMatches(noisy, { functionName: "healthCheck", errorType: "TimeoutError", service: "x" })).toBe(true);
    expect(ruleMatches(noisy, { functionName: "healthCheck", errorType: "Other" })).toBe(false);
    expect(ruleMatches(noisy, { functionName: "healthCheck" })).toBe(false);
    expect(ruleMatches(payments, { service: "Payments" })).toBe(false);
  });
});

describe("levelCap", () => {
  it("is null when nothing matches and there is no correction, or the correction is merge", () => {
    expect(levelCap({ service: "web" }, [payments, noisy])).toBeNull();
    expect(levelCap({ service: "web" }, [], { level: "merge" })).toBeNull();
  });

  it("takes the lowest of the matching rules and the correction", () => {
    expect(levelCap({ service: "payments" }, [noMerge, payments])).toEqual({ level: "log", by: "rule", ruleId: "payments-human" });
    expect(levelCap({ service: "payments" }, [payments], { level: "noise" })).toEqual({ level: "noise", by: "correction" });
    expect(levelCap({ service: "orders" }, [noMerge], { level: "log" })).toEqual({ level: "log", by: "correction" });
  });

  it("never lets an operator's correction lift an admin's rule", () => {
    expect(levelCap({ service: "payments" }, [payments], { level: "merge" })).toEqual({ level: "log", by: "rule", ruleId: "payments-human" });
    expect(levelCap({ service: "payments" }, [payments], { level: "fix" })).toEqual({ level: "log", by: "rule", ruleId: "payments-human" });
  });

  it("names the correction on a tie: a person looked at this incident", () => {
    expect(levelCap({ service: "payments" }, [payments], { level: "log" })).toEqual({ level: "log", by: "correction" });
  });

  it("capHolds says whether a level is above the cap", () => {
    const cap = levelCap({ service: "orders" }, [noMerge]);
    expect(capHolds(cap, "merge")).toBe(true);
    expect(capHolds(cap, "fix")).toBe(false);
    expect(capHolds(null, "merge")).toBe(false);
  });
});

describe("readCorrection", () => {
  const at = Timestamp.fromDate(new Date("2026-10-10T08:00:00Z"));
  it("reads a stored correction", () => {
    expect(readCorrection({ correctedLevel: "log", correctedBy: "u1", correctedAt: at, correctionNote: " a person fixes this " })).toEqual({
      level: "log",
      by: "u1",
      at: "2026-10-10T08:00:00.000Z",
      note: "a person fixes this",
    });
    expect(correctedAtMillis({ correctedLevel: "log", correctedAt: at })).toBe(at.toMillis());
  });

  it("is no correction without a known level or an operator", () => {
    expect(readCorrection({ correctedLevel: "page", correctedBy: "u1" })).toBeUndefined();
    expect(readCorrection({ correctedLevel: "log" })).toBeUndefined();
    expect(readCorrection(undefined)).toBeUndefined();
    expect(correctedAtMillis({ correctedAt: at })).toBeUndefined();
  });
});
