import { describe, it, expect } from "vitest";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import type { Firestore, WriteBatch } from "firebase-admin/firestore";
import { upsertIncident, type IncidentInput } from "./store.js";
import { computeErrorFingerprint } from "./fingerprint.js";

type Where = [string, string, unknown];

/**
 * Just enough Firestore to observe what upsertIncident queries and writes. A
 * query honours only its `status` filter (so the open and resolved lookups see
 * different documents) and ignores the rest, which is why the store re-verifies
 * content itself. A document with no `status` counts as open.
 */
function fakeDb(docs: { id: string; data: Record<string, unknown> }[]) {
  const queries: Where[][] = [];
  const matchesStatus = (wheres: Where[], status: unknown) =>
    wheres.every(([field, op, value]) => {
      if (field !== "status") return true;
      if (op === "in") return status === undefined || (value as unknown[]).includes(status);
      return status === value;
    });
  const newQuery = () => {
    const wheres: Where[] = [];
    queries.push(wheres);
    const query = {
      where(field: string, op: string, value: unknown) {
        wheres.push([field, op, value]);
        return query;
      },
      limit: () => query,
      get: async () => ({
        docs: docs
          .filter((d) => matchesStatus(wheres, d.data.status))
          .map((d) => ({ id: d.id, ref: { id: d.id }, data: () => d.data })),
      }),
    };
    return query;
  };
  const db = {
    collection: () => ({
      where: (field: string, op: string, value: unknown) => newQuery().where(field, op, value),
      doc: () => ({ id: "new-doc" }),
    }),
  } as unknown as Firestore;

  const writes: { op: "set" | "update"; id: string; data: Record<string, unknown> }[] = [];
  const batch = {
    set: (ref: { id: string }, data: Record<string, unknown>) => writes.push({ op: "set", id: ref.id, data }),
    update: (ref: { id: string }, data: Record<string, unknown>) => writes.push({ op: "update", id: ref.id, data }),
  } as unknown as WriteBatch;

  return { db, batch, queries, wheres: () => queries.flat(), writes };
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

    // The bug: a function-keyed scan capped at 10 misses the match once a
    // busy function has more than 10 open incidents, forking one incident per run.
    const fp = computeErrorFingerprint(input.functionName, input.errorMessage);
    expect(wheres()).toContainEqual(["fingerprint", "==", fp]);
    expect(wheres().some(([field]) => field === "functionName")).toBe(false);
  });

  it("treats every open status as open, including logged and recurred", async () => {
    // An incident tracked in an external issue, or a regression, must keep
    // accruing onto the same document, not fork a fresh one on every recurrence.
    const { db, batch, queries } = fakeDb([]);
    await upsertIncident(db, "incidents", batch, input, Timestamp.now());
    expect(queries[0]).toContainEqual(["status", "in", ["new", "acknowledged", "logged", "recurred"]]);
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

const isSentinel = (value: unknown, expected: FieldValue) => (value as FieldValue).isEqual(expected);

describe("upsertIncident: regressions", () => {
  const resolvedAt = Timestamp.fromDate(new Date("2026-09-20T00:00:00.000Z"));
  const resolvedDoc = (overrides: Record<string, unknown> = {}) =>
    stored("2026-09-10T00:00:00.000Z", {
      status: "resolved",
      resolvedAt,
      statusChangedBy: "operator-uid",
      environment: "prod",
      ...overrides,
    });

  it("re-opens a resolved incident as recurred when its error fires after the resolution", async () => {
    const { db, batch, writes } = fakeDb([
      { id: "fixed", data: resolvedDoc({ githubIssueNumber: 42, githubIssueUrl: "https://example.test/issues/42" }) },
    ]);

    const outcome = await upsertIncident(db, "incidents", batch, input, Timestamp.now());

    expect(outcome).toBe("recurred");
    expect(writes).toHaveLength(1);
    const w = writes[0]!;
    expect(w).toMatchObject({ op: "update", id: "fixed" });
    expect(w.data.status).toBe("recurred");
    expect(isSentinel(w.data.recurrenceCount, FieldValue.increment(1))).toBe(true);
    expect(w.data.lastRecurredAt).toEqual(Timestamp.fromDate(at));
    // The fix that failed is kept, and the live fields no longer claim it.
    expect(w.data.lastResolution).toEqual({
      resolvedAt,
      resolvedBy: "operator-uid",
      githubIssueNumber: 42,
      githubIssueUrl: "https://example.test/issues/42",
    });
    expect(isSentinel(w.data.resolvedAt, FieldValue.delete())).toBe(true);
    expect(isSentinel(w.data.githubIssueNumber, FieldValue.delete())).toBe(true);
    // The earlier triage decision ended in a fix that didn't hold: decide again.
    expect(w.data.triageState).toBe("pending");
    expect(isSentinel(w.data.occurrenceCount, FieldValue.increment(4))).toBe(true);
  });

  it("omits absent resolution fields rather than writing undefined", async () => {
    const { db, batch, writes } = fakeDb([
      { id: "fixed", data: resolvedDoc({ statusChangedBy: undefined }) },
    ]);
    await upsertIncident(db, "incidents", batch, input, Timestamp.now());
    const snap = writes[0]?.data.lastResolution as Record<string, unknown>;
    expect(Object.values(snap)).not.toContain(undefined);
    expect(snap).toEqual({ resolvedAt });
  });

  it("counts occurrences from before the resolution on the resolved incident without re-opening it", async () => {
    // Logs arrive with a lag, so a run can still carry the old failure.
    const { db, batch, writes } = fakeDb([
      { id: "fixed", data: resolvedDoc({ resolvedAt: Timestamp.fromDate(new Date("2026-09-22T00:00:00.000Z")) }) },
    ]);

    const outcome = await upsertIncident(db, "incidents", batch, input, Timestamp.now());

    expect(outcome).toBe("updated");
    expect(writes[0]?.id).toBe("fixed");
    expect(writes[0]?.data.status).toBeUndefined();
    expect(writes[0]?.data.recurrenceCount).toBeUndefined();
  });

  it("re-opens the most recently resolved copy when several share the fingerprint", async () => {
    const { db, batch, writes } = fakeDb([
      { id: "older", data: resolvedDoc({ resolvedAt: Timestamp.fromDate(new Date("2026-09-01T00:00:00.000Z")) }) },
      { id: "latest", data: resolvedDoc({ resolvedAt: Timestamp.fromDate(new Date("2026-09-15T00:00:00.000Z")) }) },
    ]);
    await upsertIncident(db, "incidents", batch, input, Timestamp.now());
    expect(writes[0]?.id).toBe("latest");
  });

  it("prefers an open incident over a resolved one", async () => {
    const { db, batch, writes } = fakeDb([
      { id: "fixed", data: resolvedDoc() },
      { id: "open", data: stored("2026-09-19T00:00:00.000Z", { status: "new" }) },
    ]);
    const outcome = await upsertIncident(db, "incidents", batch, input, Timestamp.now());
    expect(outcome).toBe("updated");
    expect(writes[0]?.id).toBe("open");
  });

  it("never re-opens an ignored incident: the recurrence opens a fresh one", async () => {
    const { db, batch, writes } = fakeDb([
      { id: "ignored", data: stored("2026-09-19T00:00:00.000Z", { status: "ignored" }) },
    ]);
    const outcome = await upsertIncident(db, "incidents", batch, input, Timestamp.now());
    expect(outcome).toBe("new");
    expect(writes[0]).toMatchObject({ op: "set", id: "new-doc" });
  });

  it("looks for the resolved incident in the same environment, by fingerprint", async () => {
    const { db, batch, queries } = fakeDb([]);
    await upsertIncident(db, "incidents", batch, input, Timestamp.now());
    const fp = computeErrorFingerprint(input.functionName, input.errorMessage);
    expect(queries[1]).toEqual([
      ["fingerprint", "==", fp],
      ["environment", "==", "prod"],
      ["status", "==", "resolved"],
    ]);
  });
});
