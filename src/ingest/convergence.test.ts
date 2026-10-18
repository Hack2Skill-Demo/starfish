import { describe, it, expect } from "vitest";
import { candidateOf, convergeOn, mergeAppliedWindows, type ConvergenceCandidate } from "./convergence.js";

const c = (id: string, overrides: Partial<ConvergenceCandidate> = {}): ConvergenceCandidate => ({ id, status: "new", ...overrides });

describe("convergeOn: the one rule the store, rekey and scrub share (#432)", () => {
  it("keeps the incident the key names when it is live, whatever the others are", () => {
    const records = [c("early", { firstOccurredAtMs: 1 }), c("keyed", { firstOccurredAtMs: 9 })];
    expect(convergeOn(records, "keyed")).toEqual({ id: "keyed", as: "live" });
    expect(convergeOn([c("open", { firstOccurredAtMs: 1 }), c("keyed", { status: "resolved" })], "keyed")).toEqual({ id: "keyed", as: "live" });
  });

  it("reads a retired incident the key names as its tombstone", () => {
    expect(convergeOn([c("open"), c("gone", { retired: true, status: "resolved" })], "gone")).toEqual({ id: "gone", as: "tombstone" });
  });

  it("passes over an ignored incident the key names: it is never reopened", () => {
    expect(convergeOn([c("ignored", { status: "ignored" }), c("open")], "ignored")).toEqual({ id: "open", as: "live" });
    expect(convergeOn([c("ignored", { status: "ignored" })], "ignored")).toBeUndefined();
  });

  it("with no key: the earliest open one, else the latest resolved, else the latest retired as a tombstone", () => {
    expect(convergeOn([c("b", { firstOccurredAtMs: 5 }), c("a", { firstOccurredAtMs: 2 }), c("r", { status: "resolved" })])).toEqual({ id: "a", as: "live" });
    expect(
      convergeOn([c("old", { status: "resolved", resolvedAtMs: 1 }), c("new", { status: "resolved", resolvedAtMs: 7 }), c("t", { retired: true })])
    ).toEqual({ id: "new", as: "live" });
    // A live incident beats a tombstone an old key named.
    expect(convergeOn([c("t", { retired: true }), c("open")])).toEqual({ id: "open", as: "live" });
    expect(convergeOn([c("t1", { retired: true, retiredAtMs: 1 }), c("t2", { retired: true, retiredAtMs: 3 })])).toEqual({ id: "t2", as: "tombstone" });
    expect(convergeOn([])).toBeUndefined();
  });

  it("breaks ties by id, so the read order never decides", () => {
    expect(convergeOn([c("b", { firstOccurredAtMs: 1 }), c("a", { firstOccurredAtMs: 1 })])?.id).toBe("a");
    expect(convergeOn([c("b"), c("a")])?.id).toBe("a");
  });

  it("reads a stored record's fields, tolerating what a legacy one lacks", () => {
    const ts = (ms: number) => ({ toMillis: () => ms });
    expect(candidateOf("x", { status: "resolved", retired: true, firstOccurredAt: ts(1), resolvedAt: ts(2), lastOccurredAt: ts(3), retiredAt: ts(4) })).toEqual({
      id: "x", status: "resolved", retired: true, firstOccurredAtMs: 1, resolvedAtMs: 2, lastOccurredAtMs: 3, retiredAtMs: 4,
    });
    expect(candidateOf("y", { status: "new", firstOccurredAt: "not a time" })).toEqual({ id: "y", status: "new" });
    expect(candidateOf("z", undefined)).toEqual({ id: "z", status: undefined });
  });

  it("merges window lists once each, oldest first", () => {
    expect(mergeAppliedWindows([["2026-01-02", "2026-01-01"], ["2026-01-01", "2026-01-03"]])).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });
});
