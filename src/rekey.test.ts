import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { computeErrorFingerprint, fingerprintOf } from "./ingest/fingerprint.js";
import { APPLIED_WINDOWS_RETAINED } from "./ingest/store.js";
import { keyTarget, mergeAppliedWindows, needsRekey, planRekey, rekeyRecord, type RekeyRecord } from "./rekey.js";

// #361's demo bug, stored before ingest split the stack off the message: two records, two fingerprints.
const CORE = "Cannot read properties of undefined (reading 'toString')";
const UNHANDLED = `Unhandled error TypeError: ${CORE}\n    at getOrder (/workspace/lib/orders/getOrder.js:22:31)`;
const RETHROW = `Error: orders-getOrder failed: ${CORE}\n    at entryFromArgs (/workspace/node_modules/firebase-functions/lib/logger/index.js:133:19)`;
const FN = "orders-getorder";
const NEW_FP = computeErrorFingerprint(FN, CORE);
const t = (iso: string) => Timestamp.fromDate(new Date(iso));

const stored = (overrides: Record<string, unknown> = {}) => ({
  functionName: FN,
  errorMessage: UNHANDLED,
  environment: "demo",
  status: "new",
  fingerprint: "0123456789abcdef",
  firstOccurredAt: t("2026-10-01T00:00:00Z"),
  lastOccurredAt: t("2026-10-02T00:00:00Z"),
  ...overrides,
});

const rec = (id: string, over: Partial<RekeyRecord> = {}): RekeyRecord => ({ id, stored: "old", current: NEW_FP, status: "new", ...over });

describe("rekeyRecord", () => {
  it("recomputes the fingerprint with the current code: a stored message's frames no longer count (#361)", () => {
    const a = rekeyRecord("a", stored(), "demo")!;
    const b = rekeyRecord("b", stored({ errorMessage: RETHROW }), "demo")!;
    expect(a.current).toBe(NEW_FP);
    expect(b.current).toBe(NEW_FP);
    expect(a).toMatchObject({ id: "a", stored: "0123456789abcdef", status: "new", firstOccurredAtMs: Date.parse("2026-10-01T00:00:00Z") });
    expect(needsRekey(a)).toBe(true);
  });

  it("recomputes a namespaced record in its own namespace", () => {
    const mon = rekeyRecord("m", stored({ errorMessage: "fn: 3 failures", signalSource: "monitoring" }), "demo")!;
    expect(mon.current).toBe(fingerprintOf(FN, "fn: 3 failures", "monitoring"));
    expect(mon.current.startsWith("mon-")).toBe(true);
  });

  it("is null for another environment, a retired record, or one missing what the fingerprint hashes", () => {
    expect(rekeyRecord("x", stored(), "prod")).toBeNull();
    expect(rekeyRecord("x", stored({ retired: true }), "demo")).toBeNull();
    expect(rekeyRecord("x", stored({ functionName: null }), "demo")).toBeNull();
    expect(rekeyRecord("x", stored({ errorMessage: undefined }), "demo")).toBeNull();
    expect(rekeyRecord("x", undefined, "demo")).toBeNull();
  });

  it("does not need a re-key when the stored fingerprint is the current one", () => {
    expect(needsRekey(rekeyRecord("a", stored({ fingerprint: NEW_FP }), "demo")!)).toBe(false);
  });
});

describe("planRekey", () => {
  it("groups by the current fingerprint, keeps only groups with a record to re-key, and lists every member", () => {
    const groups = planRekey([
      rec("a"),
      rec("b", { stored: NEW_FP }),
      rec("c", { stored: "x", current: "x" }),
      rec("d", { stored: "y", current: "z" }),
    ]);
    expect(groups.map((g) => g.fingerprint)).toEqual([NEW_FP, "z"].sort());
    const main = groups.find((g) => g.fingerprint === NEW_FP)!;
    expect(main.members.map((m) => m.id)).toEqual(["a", "b"]);
    expect(main.changed.map((m) => m.id)).toEqual(["a"]);
  });

  it("is empty when every record already holds its fingerprint: running it again does nothing", () => {
    expect(planRekey([rec("a", { stored: NEW_FP }), rec("b", { stored: "x", current: "x" })])).toEqual([]);
  });
});

describe("keyTarget: the incident the store converges on", () => {
  it("is the earliest open one by first occurrence, over any resolved or ignored one", () => {
    expect(
      keyTarget([
        rec("resolved", { status: "resolved", firstOccurredAtMs: 1, resolvedAtMs: 9 }),
        rec("late", { status: "acknowledged", firstOccurredAtMs: 20 }),
        rec("early", { status: "recurred", firstOccurredAtMs: 10 }),
        rec("ignored", { status: "ignored", firstOccurredAtMs: 0 }),
      ])
    ).toBe("early");
  });

  it("is the most recently resolved when none is open, by resolution, else last occurrence", () => {
    expect(
      keyTarget([
        rec("older", { status: "resolved", resolvedAtMs: 5 }),
        rec("newer", { status: "resolved", resolvedAtMs: 7 }),
        rec("unstamped", { status: "resolved", lastOccurredAtMs: 6 }),
      ])
    ).toBe("newer");
  });

  it("is none when every one is ignored, and breaks ties by id", () => {
    expect(keyTarget([rec("a", { status: "ignored" })])).toBeUndefined();
    expect(keyTarget([rec("b", { firstOccurredAtMs: 1 }), rec("a", { firstOccurredAtMs: 1 })])).toBe("a");
    expect(keyTarget([rec("b"), rec("a")])).toBe("a");
    // The key's own incident, when live, keeps it (the store follows the key, #432); an ignored one does not.
    expect(keyTarget([rec("a", { firstOccurredAtMs: 1 }), rec("b", { firstOccurredAtMs: 9 })], "b")).toBe("b");
    expect(keyTarget([rec("a", { firstOccurredAtMs: 1 }), rec("b", { status: "ignored" })], "b")).toBe("a");
  });
});

describe("mergeAppliedWindows", () => {
  // Window ids as ingest/window.ts makes them: the boundaries in ISO form, so text order is time order.
  const win = (h: number) => {
    const at = (x: number) => new Date(Date.UTC(2026, 9, 1) + x * 3_600_000).toISOString();
    return `${at(h)}..${at(h + 1)}`;
  };
  it("keeps each window once, oldest first, bounded like a key", () => {
    expect(mergeAppliedWindows([[win(1), win(2)], [win(2), win(3)], []])).toEqual([win(1), win(2), win(3)]);
    const many = Array.from({ length: APPLIED_WINDOWS_RETAINED + 5 }, (_, i) => win(i));
    expect(mergeAppliedWindows([many])).toEqual(many.slice(-APPLIED_WINDOWS_RETAINED));
  });

  it("keeps the newest windows whatever order the keys were read in", () => {
    const many = Array.from({ length: APPLIED_WINDOWS_RETAINED + 5 }, (_, i) => win(i));
    const half = Math.floor(many.length / 2);
    expect(mergeAppliedWindows([many.slice(half), many.slice(0, half)])).toEqual(many.slice(-APPLIED_WINDOWS_RETAINED));
  });
});
