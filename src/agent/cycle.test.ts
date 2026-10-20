import { describe, expect, it } from "vitest";
import { CLOSED_PR_WATCH_MS, prWatchEnded, sanitizeEvent } from "./cycle.js";

describe("prWatchEnded: when reconcile has nothing left to read on a pull request (#422)", () => {
  const T = Date.parse("2026-10-06T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  it("ends for a merged PR with settled checks and its merge commit, never for an open one", () => {
    expect(prWatchEnded({ state: "merged", checks: "passed", mergeCommitSha: "d".repeat(40) })).toBe(true);
    expect(prWatchEnded({ state: "merged", checks: "failed", mergeCommitSha: "d".repeat(40) })).toBe(true);
    expect(prWatchEnded({ state: "merged", checks: "pending", mergeCommitSha: "d".repeat(40) })).toBe(false);
    expect(prWatchEnded({ state: "merged", checks: "passed" })).toBe(false);
    expect(prWatchEnded({ state: "open", checks: "passed", checkedAt: iso(T + 100 * CLOSED_PR_WATCH_MS) })).toBe(false);
    expect(prWatchEnded(undefined)).toBe(false);
  });

  it("ends for a PR closed unmerged a week before it was read, and not before; an unreadable time keeps it", () => {
    expect(prWatchEnded({ state: "closed", closedAt: iso(T), checkedAt: iso(T + CLOSED_PR_WATCH_MS) })).toBe(true);
    expect(prWatchEnded({ state: "closed", closedAt: iso(T), checkedAt: iso(T + CLOSED_PR_WATCH_MS - 1) })).toBe(false);
    expect(prWatchEnded({ state: "closed", closedAt: null, checkedAt: iso(T + CLOSED_PR_WATCH_MS) })).toBe(false);
  });
});

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
