import { describe, expect, it, vi } from "vitest";

vi.mock("./firebase", () => ({ firestore: vi.fn() }));
vi.mock("./config", () => ({ webConfig: () => ({ incidentCollection: "incidents" }) }));

import { Timestamp } from "firebase/firestore";
import { countInWindow, nextStatus, toRow } from "./incidents";

const HOUR = 3600_000;
const now = Date.parse("2026-09-24T12:00:00.000Z");
const hour = (ms: number) => String(Math.floor(ms / HOUR));

describe("countInWindow (mirrors the engine's buckets.ts)", () => {
  it("sums only buckets inside the window", () => {
    const buckets = { [hour(now)]: 3, [hour(now - 5 * HOUR)]: 2, [hour(now - 48 * HOUR)]: 9 };
    expect(countInWindow(buckets, 24, now)).toBe(5);
    expect(countInWindow(buckets, 72, now)).toBe(14);
  });

  it("ignores malformed keys and values", () => {
    expect(countInWindow({ junk: 5, [hour(now)]: "7" as unknown as number }, 24, now)).toBe(0);
    expect(countInWindow(undefined, 24, now)).toBe(0);
  });
});

describe("toRow", () => {
  it("maps a stored incident, converting Timestamps to ISO strings", () => {
    const row = toRow(
      "abc",
      {
        functionName: "mailDrainer",
        service: "mail",
        errorType: "UnknownError",
        errorMessage: "send failed",
        errorDetail: "421 too many connections",
        occurrenceCount: 12,
        occurrencesByHour: { [hour(now)]: 4 },
        firstOccurredAt: Timestamp.fromMillis(now - 2 * HOUR),
        lastOccurredAt: Timestamp.fromMillis(now),
        status: "acknowledged",
        triageState: "pending",
      },
      24,
      now
    );
    expect(row).toMatchObject({
      id: "abc",
      service: "mail",
      errorDetail: "421 too many connections",
      windowedCount: 4,
      occurrenceCount: 12,
      status: "acknowledged",
      lastOccurredAt: new Date(now).toISOString(),
    });
  });

  it("degrades a malformed document instead of throwing", () => {
    const row = toRow("x", { status: "bogus", occurrenceCount: "lots", githubPrState: "weird" }, 24, now);
    expect(row).toMatchObject({
      functionName: "(unknown)",
      service: "platform",
      status: "new",
      occurrenceCount: 0,
      lastOccurredAt: "",
    });
    expect(row.githubPrState).toBeUndefined();
  });

  it("carries a regression's count and the issue whose fix didn't hold", () => {
    const row = toRow(
      "r",
      {
        status: "recurred",
        recurrenceCount: 2,
        lastRecurredAt: Timestamp.fromMillis(now),
        lastResolution: { githubIssueNumber: 42, githubIssueUrl: "https://example.test/issues/42" },
      },
      24,
      now
    );
    expect(row).toMatchObject({
      status: "recurred",
      recurrenceCount: 2,
      lastRecurredAt: new Date(now).toISOString(),
      previousIssueNumber: 42,
      previousIssueUrl: "https://example.test/issues/42",
    });
  });

  it("reads a malformed regression record as no regression", () => {
    const row = toRow("r", { recurrenceCount: "twice", lastResolution: "lol", lastRecurredAt: 5 }, 24, now);
    expect(row.recurrenceCount).toBe(0);
    expect(row.previousIssueNumber).toBeUndefined();
    expect(row.previousIssueUrl).toBeUndefined();
    expect(row.lastRecurredAt).toBeUndefined();
  });
});

describe("nextStatus — the transitions operators may make", () => {
  it.each([
    ["new", "acknowledge", "acknowledged"],
    ["acknowledged", "acknowledge", null],
    ["logged", "resolve", "resolved"],
    ["new", "ignore", "ignored"],
    ["resolved", "reopen", null],
    ["ignored", "reopen", "new"],
    ["resolved", "resolve", null],
    ["new", "reopen", null],
    ["recurred", "resolve", "resolved"],
    ["recurred", "ignore", "ignored"],
    ["recurred", "acknowledge", null],
    ["recurred", "reopen", null],
  ] as const)("%s + %s -> %s", (from, action, to) => {
    expect(nextStatus(from, action)).toBe(to);
  });
});
