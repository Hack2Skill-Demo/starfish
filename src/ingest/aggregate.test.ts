import { describe, it, expect, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

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
const { aggregateErrors, MAX_ENTRIES_PER_RUN } = await import("./aggregate.js");
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
  });
});
