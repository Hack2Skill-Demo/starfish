import { describe, expect, it } from "vitest";
import { sanitizeEvent } from "./cycle.js";

describe("sanitizeEvent: what a run event stores is well-formed (#183)", () => {
  const wellFormed = (s: string) => Buffer.from(s, "utf8").toString("utf8") === s;

  it("never splits a surrogate pair where it cuts the summary or a record value", () => {
    const long = "x".repeat(299) + "😢 Payment failed";
    const clean = sanitizeEvent({ stage: "triage", type: "decision", summary: long, data: { rule: long }, record: { reason: long } });
    expect(clean.summary).toBe("x".repeat(299));
    expect(clean.data.rule).toBe("x".repeat(299));
    expect(clean.record!.reason).toBe("x".repeat(299));
  });

  it("replaces a lone surrogate model text already held", () => {
    const clean = sanitizeEvent({ stage: "fix", type: "proposed", summary: "cause \ud83d here", record: { rootCause: "\udc00 alone" } });
    expect(wellFormed(clean.summary)).toBe(true);
    expect(wellFormed(String(clean.record!.rootCause))).toBe(true);
  });
});
