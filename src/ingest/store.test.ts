import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import type { Firestore, WriteBatch } from "firebase-admin/firestore";
import { upsertIncident, type IncidentInput } from "./store.js";
import { computeErrorFingerprint } from "./fingerprint.js";

type Where = [string, string, unknown];

/**
 * Just enough Firestore to observe what upsertIncident queries and writes. The
 * query ignores its filters and returns `docs` — the same shortcut as the
 * original suite, which is why the store re-verifies content itself.
 */
function fakeDb(docs: { id: string; data: Record<string, unknown> }[]) {
  const wheres: Where[] = [];
  const query = {
    where(field: string, op: string, value: unknown) {
      wheres.push([field, op, value]);
      return query;
    },
    limit: () => query,
    get: async () => ({
      docs: docs.map((d) => ({ id: d.id, ref: { id: d.id }, data: () => d.data })),
    }),
  };
  const db = {
    collection: () => ({ ...query, doc: () => ({ id: "new-doc" }) }),
  } as unknown as Firestore;

  const writes: { op: "set" | "update"; id: string; data: Record<string, unknown> }[] = [];
  const batch = {
    set: (ref: { id: string }, data: Record<string, unknown>) => writes.push({ op: "set", id: ref.id, data }),
    update: (ref: { id: string }, data: Record<string, unknown>) => writes.push({ op: "update", id: ref.id, data }),
  } as unknown as WriteBatch;

  return { db, batch, wheres, writes };
}

const at = new Date("2026-09-21T00:00:00.000Z");
const input: IncidentInput = {
  functionName: "mailDrainer",
  service: null,
  environment: "prod",
  errorType: "UnknownError",
  errorMessage: "email send failed",
  occurrenceCount: 4,
  firstOccurredAt: at,
  lastOccurredAt: at,
  errorDetail: "421 too many connections",
};

function stored(firstOccurredAt: string, overrides: Record<string, unknown> = {}) {
  return {
    functionName: input.functionName,
    errorMessage: input.errorMessage,
    firstOccurredAt: Timestamp.fromDate(new Date(firstOccurredAt)),
    occurrencesByHour: {},
    triageState: "declined",
    ...overrides,
  };
}

describe("upsertIncident", () => {
  it("looks the incident up by fingerprint, not by scanning the function's open incidents", async () => {
    const { db, batch, wheres } = fakeDb([]);
    await upsertIncident(db, "incidents", batch, input, Timestamp.now());

    // The regression: a function-keyed scan capped at 10 misses the match once a
    // busy function has more than 10 open incidents, forking one incident per run.
    const fp = computeErrorFingerprint(input.functionName, input.errorMessage);
    expect(wheres).toContainEqual(["fingerprint", "==", fp]);
    expect(wheres.some(([field]) => field === "functionName")).toBe(false);
  });

  it("treats every open status as open, including logged", async () => {
    // An incident tracked in an external issue must keep accruing onto the same
    // document, not fork a fresh one on every recurrence.
    const { db, batch, wheres } = fakeDb([]);
    await upsertIncident(db, "incidents", batch, input, Timestamp.now());
    expect(wheres).toContainEqual(["status", "in", ["new", "acknowledged", "logged"]]);
  });

  it("converges on the earliest copy when a past burst already forked the incident", async () => {
    const { db, batch, writes } = fakeDb([
      { id: "later", data: stored("2026-09-20T12:00:00.000Z") },
      { id: "earliest", data: stored("2026-09-19T12:00:00.000Z") },
      { id: "middle", data: stored("2026-09-20T00:00:00.000Z") },
    ]);

    const outcome = await upsertIncident(db, "incidents", batch, input, Timestamp.now());

    expect(outcome).toBe("updated");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.id).toBe("earliest");
  });

  it("never merges into a document whose content hashes differently", async () => {
    const { db, batch, writes } = fakeDb([
      { id: "stale", data: stored("2026-09-19T00:00:00.000Z", { errorMessage: "something else" }) },
    ]);

    const outcome = await upsertIncident(db, "incidents", batch, input, Timestamp.now());

    expect(outcome).toBe("new");
    expect(writes[0]).toMatchObject({ op: "set", id: "new-doc" });
  });

  it("does not undo a triage decision on recurrence", async () => {
    const { db, batch, writes } = fakeDb([{ id: "a", data: stored("2026-09-19T00:00:00.000Z") }]);
    await upsertIncident(db, "incidents", batch, input, Timestamp.now());
    expect(writes[0]?.data.triageState).toBeUndefined();
    expect(writes[0]?.data.errorDetail).toBe("421 too many connections");
  });

  it("stores an unattributable incident as platform", async () => {
    const { db, batch, writes } = fakeDb([]);
    await upsertIncident(db, "incidents", batch, input, Timestamp.now());
    expect(writes[0]?.data.service).toBe("platform");
    expect(writes[0]?.data.triageState).toBe("pending");
  });
});
