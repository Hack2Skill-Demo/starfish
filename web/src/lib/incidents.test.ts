import { beforeEach, describe, expect, it, vi } from "vitest";

const getDoc = vi.hoisted(() => vi.fn());
const getDocs = vi.hoisted(() => vi.fn());
const fsDoc = vi.hoisted(() => vi.fn((...path: unknown[]) => ({ path })));
const fsCollection = vi.hoisted(() => vi.fn((...path: unknown[]) => ({ path })));
/** The signed-in user the data layer asks (dataSource.ts): null, an operator, or an anonymous guest. */
const auth = vi.hoisted(() => ({ currentUser: null as null | { isAnonymous: boolean } }));
vi.mock("firebase/firestore", async (orig) => ({ ...(await orig<typeof import("firebase/firestore")>()), getDoc, getDocs, doc: fsDoc, collection: fsCollection, query: vi.fn(() => ({})), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), startAfter: vi.fn((c: unknown) => ({ startAfter: c })) }));
vi.mock("./firebase", () => ({ firestore: vi.fn(), firebaseAuth: () => auth }));
vi.mock("./config", () => ({ webConfig: () => ({ incidentCollection: "incidents", publicIncidentCollection: "starfish_public_incidents" }) }));

import { Timestamp, query as fsQuery, startAfter as fsStartAfter } from "firebase/firestore";
import { countInWindow, getIncident, listIncidents, listIncidentsPage, nextStatus, toRow, type IncidentRow } from "./incidents";
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

  it("marks an incident synthetic only when the document says exactly true", () => {
    expect(toRow("s", { synthetic: true }, 24, now).synthetic).toBe(true);
    expect(toRow("s", { synthetic: 1 }, 24, now).synthetic).toBeUndefined();
    expect(toRow("s", {}, 24, now)).not.toHaveProperty("synthetic");
  });

  describe("the Cloud Monitoring signal (#19)", () => {
    const reading = {
      source: "cloud-monitoring",
      metricType: "run.googleapis.com/request_count",
      resourceType: "cloud_run_revision",
      projectId: "app-proj",
      windowStart: Timestamp.fromMillis(Date.UTC(2026, 9, 5, 10)),
      windowEnd: Timestamp.fromMillis(Date.UTC(2026, 9, 5, 11)),
      failureCount: 7,
    };

    it("marks a Monitoring-only incident by its signal source or its mon- fingerprint, and nothing else", () => {
      expect(toRow("m", { signalSource: "monitoring" }, 24, now).monitoringOnly).toBe(true);
      expect(toRow("m", { fingerprint: "mon-abc123" }, 24, now).monitoringOnly).toBe(true);
      expect(toRow("l", { fingerprint: "abc123", signalSource: "log" }, 24, now)).not.toHaveProperty("monitoringOnly");
      expect(toRow("l", {}, 24, now)).not.toHaveProperty("monitoringOnly");
    });

    it("reads the Monitoring count and the latest readings, as stored", () => {
      const row = toRow("a", { monitoringCount: 12, lastMonitoring: [reading, { ...reading, failureCount: 5, capped: true }] }, 24, now);
      expect(row.monitoringCount).toBe(12);
      expect(row.lastMonitoring).toEqual([
        {
          metricType: "run.googleapis.com/request_count",
          resourceType: "cloud_run_revision",
          projectId: "app-proj",
          windowStart: "2026-10-05T10:00:00.000Z",
          windowEnd: "2026-10-05T11:00:00.000Z",
          failureCount: 7,
          capped: false,
        },
        expect.objectContaining({ failureCount: 5, capped: true }),
      ]);
    });

    it("leaves out a malformed count or reading rather than showing it half-filled; absent is not zero", () => {
      const row = toRow(
        "b",
        { monitoringCount: "7", lastMonitoring: [{ ...reading, failureCount: "7" }, { ...reading, projectId: 3 }, null, reading] },
        24,
        now
      );
      expect(row).not.toHaveProperty("monitoringCount");
      expect(row.lastMonitoring).toHaveLength(1);
      expect(toRow("c", { monitoringCount: -1, lastMonitoring: "x" }, 24, now)).not.toHaveProperty("monitoringCount");
      expect(toRow("c", { lastMonitoring: [] }, 24, now)).not.toHaveProperty("lastMonitoring");
      expect(toRow("c", { lastMonitoring: Array(20).fill(reading) }, 24, now).lastMonitoring).toHaveLength(8);
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
    ["logged", "acknowledge", "acknowledged"],
    ["logged", "reopen", null],
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

describe("the guest data path (#18)", () => {
  const snap = (data: Record<string, unknown> | null) => ({ exists: () => data !== null, id: "abc", data: () => data });
  const copy = { publicView: 1, functionName: "fn", environment: "demo", status: "new", occurrenceCount: 1, errorMessage: "send failed" };

  it("an operator reads the stored incidents; a guest reads the trimmed copies, from one switch", async () => {
    getDoc.mockResolvedValue(snap(copy));
    getDocs.mockResolvedValue({ docs: [], size: 0 });

    auth.currentUser = { isAnonymous: false };
    fsDoc.mockClear();
    fsCollection.mockClear();
    await getIncident("abc", "demo");
    await listIncidents(24, "demo");
    expect(fsDoc.mock.calls[0]?.[1]).toBe("incidents");
    expect(fsCollection.mock.calls[0]?.[1]).toBe("incidents");

    auth.currentUser = { isAnonymous: true };
    fsDoc.mockClear();
    fsCollection.mockClear();
    await getIncident("abc", "demo");
    await listIncidents(24, "demo");
    expect(fsDoc.mock.calls[0]?.[1]).toBe("starfish_public_incidents");
    expect(fsCollection.mock.calls[0]?.[1]).toBe("starfish_public_incidents");
    auth.currentUser = null;
  });

  it("a copy reads as a row marked trimmed, with nothing in the fields it leaves out", async () => {
    auth.currentUser = { isAnonymous: true };
    getDoc.mockResolvedValue(snap(copy));
    const row = await getIncident("abc", "demo");
    expect(row).toMatchObject({ id: "abc", functionName: "fn", errorMessage: "send failed", trimmed: true });
    expect(row?.errorDetail).toBeUndefined();
    expect(row?.stackTrace).toBeUndefined();
    expect(row?.tenantId).toBeUndefined();
    auth.currentUser = null;
    // A stored document is never marked trimmed.
    expect(toRow("abc", { functionName: "fn", status: "new" }, 24)).not.toHaveProperty("trimmed");
  });
});

describe("listIncidents", () => {
  beforeEach(() => vi.mocked(fsStartAfter).mockClear());
  it("leaves a retired incident out of the list, as it is to the store and to the evidence page", async () => {
    const d = (id: string, data: Record<string, unknown>) => ({ id, data: () => ({ functionName: id, environment: "demo", status: "resolved", ...data }) });
    getDocs.mockResolvedValue({ docs: [d("live", {}), d("gone", { retired: true })], size: 2 });
    const { rows, capped } = await listIncidents(24, "demo");
    expect(rows.map((r) => r.id)).toEqual(["live"]);
    expect(capped).toBe(false);
  });

  it("pages by cursor: a full page says more may follow, and the next read starts after its last document (#388)", async () => {
    const d = (id: string, data: Record<string, unknown> = {}) => ({ id, data: () => ({ functionName: id, environment: "demo", status: "new", ...data }) });
    const full = Array.from({ length: 200 }, (_, i) => d(`i${i}`, { retired: i === 3 }));
    getDocs.mockResolvedValueOnce({ docs: full, size: 200 });
    const first = await listIncidentsPage(24, "demo");
    expect(first.capped).toBe(true);
    expect(first.rows).toHaveLength(199);
    expect(first.cursor).toBe(full[199]);
    expect(fsStartAfter).not.toHaveBeenCalled();

    // The unresolved incident outside the first 200 is on the second page.
    getDocs.mockResolvedValueOnce({ docs: [d("deep")], size: 1 });
    const second = await listIncidentsPage(24, "demo", first.cursor);
    expect(fsStartAfter).toHaveBeenCalledWith(full[199]);
    expect(vi.mocked(fsQuery).mock.calls.at(-1)).toContainEqual({ startAfter: full[199] });
    expect(second.rows.map((r) => r.id)).toEqual(["deep"]);
    expect(second.capped).toBe(false);
  });

  it("has no cursor for an empty page", async () => {
    getDocs.mockResolvedValueOnce({ docs: [], size: 0 });
    expect(await listIncidentsPage(24, "demo")).toEqual({ rows: [], capped: false });
  });
});
