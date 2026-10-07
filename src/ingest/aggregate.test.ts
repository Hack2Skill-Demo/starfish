import { describe, it, expect, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import type { MonitoringObservation, MonitoringReader } from "./monitoring.js";
import type { IncidentInput } from "./store.js";

const entries: unknown[] = [];
const logging = { projects: [] as unknown[], filters: [] as string[], orders: [] as string[] };
vi.mock("@google-cloud/logging", () => ({
  Logging: class {
    constructor(options: unknown) {
      logging.projects.push(options);
    }
    getEntries = async (request: { filter: string; orderBy: string }) => {
      logging.filters.push(request.filter);
      logging.orders.push(request.orderBy);
      return [entries];
    };
  },
}));

const { SEEDED_SECRETS } = await import("./testSecrets.js");
const { aggregateErrors, correlateMonitoring, MAX_ENTRIES_PER_RUN } = await import("./aggregate.js");
const { windowOf } = await import("./window.js");
const { testConfig } = await import("../testConfig.js");

const config = testConfig({ projectId: "p", location: "l" });
const window = windowOf(new Date("2026-09-20T23:00:00.000Z"), new Date("2026-09-21T01:00:00.000Z"));

/** Firestore with no existing incidents or keys that records the incidents created. */
function fakeDb(failOn?: string) {
  const created: Record<string, unknown>[] = [];
  const query = { where: () => query, limit: () => query };
  const tx = {
    get: async () => ({ docs: [], exists: false, data: () => undefined, get: () => undefined }),
    set: (ref: { collection: string }, data: Record<string, unknown>) => {
      if (failOn !== undefined && data.errorMessage === failOn) throw new Error("commit failed");
      if (ref.collection === "incidents") created.push(data);
    },
    update: () => undefined,
  };
  const db = {
    collection: (collection: string) => ({ ...query, doc: () => ({ collection, id: `doc${created.length}` }) }),
    runTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Firestore;
  return { db, created };
}

function entry(message: string) {
  return {
    metadata: { timestamp: "2026-09-21T00:00:00.000Z", resource: { labels: { function_name: "lookup" } } },
    data: message,
  };
}

describe("aggregateErrors", () => {
  it("groups on the redacted message, so PII variants are one incident", async () => {
    entries.splice(0, entries.length, entry("No user for alice@x.com"), entry("No user for bob@y.org"));
    const { db, created } = fakeDb();

    const result = await aggregateErrors(db, config, window);

    expect(result.incidentsCreated).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      errorMessage: "No user for [redacted-email]",
      occurrenceCount: 2,
    });
  });

  it("stores no seeded credential from the message, error, stack or name", async () => {
    const secrets = Object.values(SEEDED_SECRETS);
    const all = secrets.join(" ");
    entries.splice(0, entries.length, {
      metadata: { timestamp: "2026-09-21T00:00:00.000Z", resource: { labels: { function_name: "pay" } } },
      data: {
        message: `charge failed ${SEEDED_SECRETS.stripe}`,
        error: `upstream said ${all}`,
        stack: `Error: x\n    at call (https://u:${"p4ss"}@host/${SEEDED_SECRETS.github})`,
        errorName: `Err ${SEEDED_SECRETS.jwt}`,
      },
    });
    const { db, created } = fakeDb();

    await aggregateErrors(db, config, window);

    const stored = JSON.stringify(created);
    for (const secret of secrets) expect(stored).not.toContain(secret);
    expect(stored).not.toContain("p4ss");
  });

  it("never turns Starfish's own errors into incidents (#32)", async () => {
    entries.splice(
      0,
      entries.length,
      { metadata: { timestamp: "2026-09-21T00:00:00.000Z", resource: { labels: { service_name: "starfish" } } }, data: "the engine itself failed" },
      { metadata: { timestamp: "2026-09-21T00:00:00.000Z", resource: { labels: { function_name: "orders-create" } } }, data: "orders failed" }
    );
    logging.filters.length = 0;
    const { db, created } = fakeDb();

    const result = await aggregateErrors(db, { ...config, excludedServices: ["starfish"] }, window);

    expect(created.map((c) => c.errorMessage)).toEqual(["orders failed"]);
    expect(result.incidentsCreated).toBe(1);
    expect(logging.filters[0]).toContain('NOT resource.labels.service_name="starfish"');
  });

  it("settles every upsert before reporting a failed one", async () => {
    entries.splice(0, entries.length, entry("first failure"), entry("second failure"), entry("third failure"));
    const { db, created } = fakeDb("second failure");

    await expect(aggregateErrors(db, config, window)).rejects.toThrow("1 of 3 incident upserts failed");
    // The failure doesn't strand the others: they committed and the next run accrues onto them.
    expect(created.map((c) => c.errorMessage).sort()).toEqual(["first failure", "third failure"]);
  });

  it("reads the watched project's logs, not the project Starfish runs in, with the configured filter", async () => {
    entries.splice(0, entries.length);
    logging.projects.length = 0;
    logging.filters.length = 0;
    const { db } = fakeDb();

    await aggregateErrors(
      db,
      { ...config, watchedProjectId: "watched-app-1", logResourceTypes: ["gae_app"], ignoredMessages: ["probe"] },
      window
    );

    expect(logging.projects).toEqual([{ projectId: "watched-app-1" }]);
    expect(logging.filters[0]).toContain('resource.type="gae_app"');
    expect(logging.filters[0]).not.toContain("cloud_function");
    expect(logging.filters[0]).toContain('NOT textPayload:"probe"');
  });

  describe("a read that hits the cap (#127)", () => {
    const at = (ms: number, message: string) => ({
      metadata: { timestamp: new Date(ms), resource: { labels: { function_name: "lookup" } } },
      data: message,
    });

    it("reads oldest first, writes nothing, and hands back the part of the window it covered in full", async () => {
      const t0 = window.start.getTime() + 60_000;
      entries.splice(0, entries.length, ...Array.from({ length: MAX_ENTRIES_PER_RUN }, (_, i) => at(t0 + i * 1000, `e${i % 3}`)));
      logging.orders.length = 0;
      const { db, created } = fakeDb();

      const result = await aggregateErrors(db, config, window);

      expect(logging.orders).toEqual(["timestamp asc"]);
      expect(created).toHaveLength(0);
      expect(result).toMatchObject({ entriesProcessed: 0, incidentsCreated: 0, capped: false });
      const lastRead = t0 + (MAX_ENTRIES_PER_RUN - 1) * 1000;
      expect(result.narrowedTo?.start).toEqual(window.start);
      expect(result.narrowedTo?.end.getTime()).toBe(lastRead - 1);
    });

    it("processes the read and flags it capped when the window cannot be narrowed", async () => {
      // Every entry in the window's first millisecond: there is no shorter window to replay.
      entries.splice(0, entries.length, ...Array.from({ length: MAX_ENTRIES_PER_RUN }, () => at(window.start.getTime() + 1, "burst")));
      const { db, created } = fakeDb();

      const result = await aggregateErrors(db, config, window);

      expect(result).toMatchObject({ entriesProcessed: MAX_ENTRIES_PER_RUN, incidentsCreated: 1, capped: true });
      expect(result.narrowedTo).toBeUndefined();
      expect(created).toHaveLength(1);
    });

    it("processes the read under the window's own id, flagged capped, when an earlier attempt already wrote it (#199)", async () => {
      const t0 = window.start.getTime() + 60_000;
      entries.splice(0, entries.length, ...Array.from({ length: MAX_ENTRIES_PER_RUN }, (_, i) => at(t0 + i * 1000, "burst")));
      const { db, created } = fakeDb();
      let began = 0;

      const result = await aggregateErrors(db, config, window, { writes: { mayNarrow: false, beginWrites: async () => (began++, true) } });

      expect(result).toMatchObject({ entriesProcessed: MAX_ENTRIES_PER_RUN, incidentsCreated: 1, capped: true });
      expect(result.narrowedTo).toBeUndefined();
      expect(created[0]).toMatchObject({ occurrenceCount: MAX_ENTRIES_PER_RUN });
      expect(began).toBe(1);
    });
  });

  describe("coordinating its writes with the run (#199)", () => {
    it("records that writes begin before the first upsert", async () => {
      entries.splice(0, entries.length, entry("first failure"), entry("second failure"));
      const { db, created } = fakeDb();
      const createdWhenBegun: number[] = [];

      await aggregateErrors(db, config, window, { writes: { mayNarrow: true, beginWrites: async () => (createdWhenBegun.push(created.length), true) } });

      expect(createdWhenBegun).toEqual([0]);
      expect(created).toHaveLength(2);
    });

    it("writes nothing for a window that is no longer the pending one", async () => {
      entries.splice(0, entries.length, entry("first failure"));
      const { db, created } = fakeDb();

      const result = await aggregateErrors(db, config, window, { writes: { mayNarrow: true, beginWrites: async () => false } });

      expect(created).toHaveLength(0);
      expect(result).toMatchObject({ superseded: true, entriesProcessed: 0, incidentsCreated: 0 });
    });

    it("does not record a write for a window with nothing to write", async () => {
      entries.splice(0, entries.length);
      let began = false;
      await aggregateErrors(fakeDb().db, config, window, { writes: { mayNarrow: true, beginWrites: async () => (began = true) } });
      expect(began).toBe(false);
    });
  });
});

describe("aggregateErrors: the Cloud Monitoring signal (#19)", () => {
  const monitored = testConfig({ projectId: "p", watchedProjectId: "watched-app-1", monitoringEnabled: true });
  const failures = (name: string, count: number) => ({
    resource: { labels: { service_name: name } },
    points: [{ interval: { startTime: window.start.toISOString(), endTime: window.end.toISOString() }, value: { int64Value: String(count) } }],
  });
  /** Answers the Cloud Run signal with `series` and the gen1 one with nothing. */
  function reader(series: unknown[]) {
    const calls: string[] = [];
    const r: MonitoringReader = {
      listTimeSeries: async (req) => {
        calls.push(req.filter);
        return { series: req.filter.includes("run.googleapis.com") ? (series as never[]) : [] };
      },
    };
    return { reader: r, calls };
  }

  it("is off by default: Monitoring is never read", async () => {
    entries.splice(0, entries.length);
    const { reader: r, calls } = reader([failures("checkout", 9)]);
    const { db, created } = fakeDb();
    const result = await aggregateErrors(db, config, window, { monitoring: r });
    expect(calls).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(result.monitoring).toBeUndefined();
  });

  it("opens a Monitoring-only incident for a failed invocation that wrote no ERROR log", async () => {
    entries.splice(0, entries.length);
    const { reader: r } = reader([failures("checkout", 9)]);
    const { db, created } = fakeDb();

    const result = await aggregateErrors(db, monitored, window, { monitoring: r });

    expect(result).toMatchObject({
      entriesProcessed: 0,
      incidentsCreated: 1,
      monitoring: { observations: 1, annotated: 0, monitoringOnly: 1, unavailable: false },
    });
    expect(created).toHaveLength(1);
    const doc = created[0]!;
    expect(doc).toMatchObject({
      functionName: "checkout",
      service: "platform",
      errorType: "UnloggedFailure",
      signalSource: "monitoring",
      occurrenceCount: 9,
      monitoringCount: 9,
      sourceProjectId: "watched-app-1",
      status: "new",
    });
    expect(String(doc.fingerprint)).toMatch(/^mon-[0-9a-f]{16}$/);
    expect(doc.lastMonitoring).toEqual([
      expect.objectContaining({
        source: "cloud-monitoring",
        metricType: "run.googleapis.com/request_count",
        resourceType: "cloud_run_revision",
        projectId: "watched-app-1",
        failureCount: 9,
      }),
    ]);
    const obs = (doc.lastMonitoring as { windowStart: { toDate(): Date }; windowEnd: { toDate(): Date } }[])[0]!;
    expect(obs.windowStart.toDate()).toEqual(window.start);
    expect(obs.windowEnd.toDate()).toEqual(window.end);
  });

  it("annotates the log incident when the same function also logged in the window: one incident, not two", async () => {
    entries.splice(0, entries.length, entry("lookup failed"), entry("lookup failed"));
    const { reader: r } = reader([failures("lookup", 5)]);
    const { db, created } = fakeDb();

    const result = await aggregateErrors(db, monitored, window, { monitoring: r });

    expect(result.incidentsCreated).toBe(1);
    expect(result.monitoring).toMatchObject({ observations: 1, annotated: 1, monitoringOnly: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ errorMessage: "lookup failed", occurrenceCount: 2, monitoringCount: 5 });
    expect(created[0]!.signalSource).toBeUndefined();
    expect(String(created[0]!.fingerprint)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keeps a log incident and another function's Monitoring-only failures apart", async () => {
    entries.splice(0, entries.length, entry("lookup failed"));
    const { reader: r } = reader([failures("lookup", 1), failures("checkout", 4)]);
    const { db, created } = fakeDb();

    await aggregateErrors(db, monitored, window, { monitoring: r });

    expect(created.map((c) => [c.functionName, c.signalSource ?? "log", c.monitoringCount])).toEqual([
      ["lookup", "log", 1],
      ["checkout", "monitoring", 4],
    ]);
  });

  it("an unavailable Monitoring API is recorded as unavailable: log incidents are still written, nothing reads as zero", async () => {
    entries.splice(0, entries.length, entry("lookup failed"));
    const failing: MonitoringReader = { listTimeSeries: () => Promise.reject(new Error("PERMISSION_DENIED")) };
    const { db, created } = fakeDb();

    const result = await aggregateErrors(db, monitored, window, { monitoring: failing });

    expect(result.monitoring).toEqual({ observations: 0, annotated: 0, monitoringOnly: 0, unavailable: true });
    expect(created).toHaveLength(1);
    expect(created[0]!.monitoringCount).toBeUndefined();
    expect(created[0]!.lastMonitoring).toBeUndefined();
  });

  it("does not read Monitoring for a capped read it narrows: the narrowed window reads it once", async () => {
    const t0 = window.start.getTime() + 60_000;
    entries.splice(
      0,
      entries.length,
      ...Array.from({ length: MAX_ENTRIES_PER_RUN }, (_, i) => ({
        metadata: { timestamp: new Date(t0 + i * 1000), resource: { labels: { function_name: "lookup" } } },
        data: "x",
      }))
    );
    const { reader: r, calls } = reader([failures("checkout", 9)]);
    const { db, created } = fakeDb();
    const result = await aggregateErrors(db, monitored, window, { monitoring: r });
    expect(result.narrowedTo).toBeDefined();
    expect(calls).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});

describe("correlateMonitoring", () => {
  const obs = (functionName: string, failureCount: number): MonitoringObservation => ({
    source: "cloud-monitoring",
    metricType: "run.googleapis.com/request_count",
    resourceType: "cloud_run_revision",
    projectId: "watched-app-1",
    functionName,
    windowStart: window.start,
    windowEnd: window.end,
    failureCount,
    capped: false,
    firstAt: window.start,
    lastAt: window.end,
    description: "Cloud Monitoring counted 5xx responses",
  });
  const logInput = (functionName: string, errorMessage: string): IncidentInput => ({
    functionName,
    service: null,
    environment: "prod",
    errorType: "UnknownError",
    errorMessage,
    occurrenceCount: 1,
    firstOccurredAt: window.start,
    lastOccurredAt: window.end,
    windowId: window.id,
  });

  it("matches on the canonical spelling and annotates every log input of the function", () => {
    const inputs = [logInput("sync_orders", "a"), logInput("sync_orders", "b"), logInput("other", "c")];
    const { monitoringOnly, annotated } = correlateMonitoring(inputs, [obs("sync-orders", 3)], config, window.id);
    expect(monitoringOnly).toEqual([]);
    expect(annotated).toBe(2);
    expect(inputs.map((i) => i.monitoring?.length ?? 0)).toEqual([1, 1, 0]);
  });

  it("gives a Monitoring-only input a fixed message, the window id and the monitoring namespace", () => {
    const { monitoringOnly } = correlateMonitoring([], [obs("checkout", 2)], config, window.id);
    expect(monitoringOnly).toEqual([
      expect.objectContaining({
        functionName: "checkout",
        errorMessage: "Cloud Monitoring counted 5xx responses",
        occurrenceCount: 2,
        signalSource: "monitoring",
        windowId: window.id,
      }),
    ]);
  });
});
