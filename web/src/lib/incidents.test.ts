import { describe, expect, it, vi } from "vitest";

const getDoc = vi.hoisted(() => vi.fn());
const getDocs = vi.hoisted(() => vi.fn());
vi.mock("firebase/firestore", async (orig) => ({ ...(await orig<typeof import("firebase/firestore")>()), getDoc, getDocs, doc: vi.fn(() => ({})), collection: vi.fn(() => ({})), query: vi.fn(() => ({})), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn() }));
vi.mock("./firebase", () => ({ firestore: vi.fn() }));
vi.mock("./config", () => ({ webConfig: () => ({ incidentCollection: "incidents" }) }));

import { Timestamp } from "firebase/firestore";
import { countInWindow, getIncident, listIncidents, nextStatus, toRow, type IncidentRow } from "./incidents";
import { hourlySeries } from "./overviewModel";

const HOUR = 3600_000;
const now = Date.parse("2026-09-24T12:00:00.000Z");
const hour = (ms: number) => String(Math.floor(ms / HOUR));

describe("countInWindow", () => {
  it("sums only buckets inside the window", () => {
    const buckets = { [hour(now)]: 3, [hour(now - 5 * HOUR)]: 2, [hour(now - 48 * HOUR)]: 9 };
    expect(countInWindow(buckets, 24, now)).toBe(5);
    expect(countInWindow(buckets, 72, now)).toBe(14);
  });

  it("counts exactly 24 hourly buckets for 24h, the same total as the Overview's hourly series (#144)", () => {
    const at = now + 17 * 60_000; // mid-hour
    const buckets: Record<string, number> = {};
    for (let i = 0; i <= 30; i++) buckets[hour(at - i * HOUR)] = 1;
    expect(countInWindow(buckets, 24, at)).toBe(24);
    const row = { occurrencesByHour: buckets } as unknown as IncidentRow;
    const series = hourlySeries([row], at, 24);
    expect(series.reduce((sum, b) => sum + b.count, 0)).toBe(countInWindow(buckets, 24, at));
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

describe("toRow: hourly buckets", () => {
  const base = { functionName: "f", environment: "demo", status: "new" };
  it("carries only the usable buckets, and none when there are none", () => {
    expect(toRow("a", { ...base, occurrencesByHour: { "100": 2, junk: 5, "101": -1, "102": "3" } }, 24).occurrencesByHour).toEqual({ "100": 2 });
    expect(toRow("a", { ...base, occurrencesByHour: { junk: 5 } }, 24)).not.toHaveProperty("occurrencesByHour");
    expect(toRow("a", base, 24)).not.toHaveProperty("occurrencesByHour");
    expect(toRow("a", { ...base, occurrencesByHour: [1, 2] }, 24)).not.toHaveProperty("occurrencesByHour");
  });
});

describe("getIncident", () => {
  const snap = (data: Record<string, unknown> | null) => ({ exists: () => data !== null, id: "abc", data: () => data });
  const stored = { functionName: "fn", environment: "demo", status: "new", occurrenceCount: 1 };

  it("returns the incident for its own environment", async () => {
    getDoc.mockResolvedValue(snap(stored));
    expect(await getIncident("abc", "demo")).toMatchObject({ id: "abc", functionName: "fn" });
  });

  it("returns null for a missing incident, another environment's, and a retired one", async () => {
    getDoc.mockResolvedValue(snap(null));
    expect(await getIncident("abc", "demo")).toBeNull();
    getDoc.mockResolvedValue(snap({ ...stored, environment: "prod" }));
    expect(await getIncident("abc", "demo")).toBeNull();
    getDoc.mockResolvedValue(snap({ ...stored, retired: true }));
    expect(await getIncident("abc", "demo")).toBeNull();
  });
});

describe("listIncidents", () => {
  it("leaves a retired incident out of the list, as it is to the store and to the evidence page", async () => {
    const d = (id: string, data: Record<string, unknown>) => ({ id, data: () => ({ functionName: id, environment: "demo", status: "resolved", ...data }) });
    getDocs.mockResolvedValue({ docs: [d("live", {}), d("gone", { retired: true })], size: 2 });
    const { rows, capped } = await listIncidents(24, "demo");
    expect(rows.map((r) => r.id)).toEqual(["live"]);
    expect(capped).toBe(false);
  });
});
