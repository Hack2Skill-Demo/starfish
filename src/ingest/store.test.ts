import { describe, it, expect } from "vitest";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { APPLIED_WINDOWS_RETAINED, incidentKeyId, upsertIncident, UPSERT_MAX_ATTEMPTS, type IncidentInput } from "./store.js";
import { computeErrorFingerprint } from "./fingerprint.js";
import { SEEDED_SECRETS } from "./testSecrets.js";

type Where = [string, string, unknown];
type Write = { op: "set" | "update"; collection: string; id: string; data: Record<string, unknown> };

const STORE = { incidentCollection: "incidents", incidentKeyCollection: "incident_keys" };

/**
 * Just enough Firestore to observe what upsertIncident reads and writes inside
 * its transaction. A query honours only its `status` filter (so the open and
 * resolved lookups see different documents) and ignores the rest, which is why
 * the store re-verifies content itself. `keys` seeds the incident-key collection: key id → incident id.
 */
function fakeDb(
  docs: { id: string; data: Record<string, unknown> }[],
  keys: Record<string, string | { incidentId: string; appliedWindows?: unknown }> = {}
) {
  const queries: Where[][] = [];
  const reads: string[] = [];
  const txOptions: unknown[] = [];
  const matchesStatus = (wheres: Where[], status: unknown) =>
    wheres.every(([field, op, value]) => {
      if (field !== "status") return true;
      if (op === "in") return (value as unknown[]).includes(status);
      return status === value;
    });
  const ref = (collection: string, id: string) => ({ kind: "doc" as const, collection, id });
  const snap = (r: { collection: string; id: string }, data: Record<string, unknown> | undefined) => ({
    id: r.id,
    ref: r,
    exists: data !== undefined,
    data: () => data,
    get: (field: string) => data?.[field],
  });
  const newQuery = () => {
    const wheres: Where[] = [];
    queries.push(wheres);
    const query = {
      kind: "query" as const,
      wheres,
      where(field: string, op: string, value: unknown) {
        wheres.push([field, op, value]);
        return query;
      },
      limit: () => query,
    };
    return query;
  };
  const lookup = (collection: string, id: string) =>
    collection === STORE.incidentKeyCollection
      ? keys[id] === undefined
        ? undefined
        : typeof keys[id] === "string"
          ? { incidentId: keys[id] }
          : keys[id]
      : docs.find((d) => d.id === id)?.data;

  // Incident writes and key writes are kept apart, so a test about the incident
  // reads `writes` exactly as it did before keys existed.
  const writes: Write[] = [];
  const keyWrites: Write[] = [];
  const record = (op: Write["op"], r: ReturnType<typeof ref>, data: Record<string, unknown>) =>
    (r.collection === STORE.incidentKeyCollection ? keyWrites : writes).push({
      op,
      collection: r.collection,
      id: r.id,
      data,
    });
  const tx = {
    get: async (target: ReturnType<typeof ref> | ReturnType<typeof newQuery>) => {
      if (target.kind === "query") {
        return {
          docs: docs
            .filter((d) => matchesStatus(target.wheres, d.data.status))
            .map((d) => snap(ref(STORE.incidentCollection, d.id), d.data)),
        };
      }
      reads.push(`${target.collection}/${target.id}`);
      return snap(target, lookup(target.collection, target.id));
    },
    set: (r: ReturnType<typeof ref>, data: Record<string, unknown>) => record("set", r, data),
    update: (r: ReturnType<typeof ref>, data: Record<string, unknown>) => record("update", r, data),
  };
  const db = {
    collection: (name: string) => ({
      where: (field: string, op: string, value: unknown) => newQuery().where(field, op, value),
      doc: (id?: string) => ref(name, id ?? "new-doc"),
    }),
    runTransaction: async (fn: (t: typeof tx) => Promise<unknown>, options: unknown) => {
      txOptions.push(options);
      return fn(tx);
    },
  } as unknown as Firestore;

  return {
    db,
    queries,
    reads,
    txOptions,
    wheres: () => queries.flat(),
    writes,
    keyWrites,
  };
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
    status: "new",
    triageState: "declined",
    ...overrides,
  };
}

describe("upsertIncident", () => {
  it("looks the incident up by fingerprint, not by scanning the function's open incidents", async () => {
    const { db, wheres } = fakeDb([]);
    await upsertIncident(db, STORE, input, Timestamp.now());

    // The bug: a function-keyed scan capped at 10 misses the match once a
    // busy function has more than 10 open incidents, forking one incident per run.
    const fp = computeErrorFingerprint(input.functionName, input.errorMessage);
    expect(wheres()).toContainEqual(["fingerprint", "==", fp]);
    expect(wheres().some(([field]) => field === "functionName")).toBe(false);
  });

  it("treats every open status as open, including logged and recurred", async () => {
    // An incident tracked in an external issue, or a regression, must keep
    // accruing onto the same document, not fork a fresh one on every recurrence.
    const { db, queries } = fakeDb([]);
    await upsertIncident(db, STORE, input, Timestamp.now());
    expect(queries[0]).toContainEqual(["status", "in", ["new", "acknowledged", "logged", "recurred"]]);
  });

  it("converges on the earliest copy when a past burst already forked the incident", async () => {
    const { db, writes } = fakeDb([
      { id: "later", data: stored("2026-09-20T12:00:00.000Z") },
      { id: "earliest", data: stored("2026-09-19T12:00:00.000Z") },
      { id: "middle", data: stored("2026-09-20T00:00:00.000Z") },
    ]);

    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());

    expect(outcome).toBe("updated");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.id).toBe("earliest");
  });

  it("never merges into a document whose content hashes differently", async () => {
    const { db, writes } = fakeDb([
      { id: "stale", data: stored("2026-09-19T00:00:00.000Z", { errorMessage: "something else" }) },
    ]);

    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());

    expect(outcome).toBe("new");
    expect(writes[0]).toMatchObject({ op: "set", id: "new-doc" });
  });

  it("does not undo a triage decision on recurrence", async () => {
    const { db, writes } = fakeDb([{ id: "a", data: stored("2026-09-19T00:00:00.000Z") }]);
    await upsertIncident(db, STORE, input, Timestamp.now());
    expect(writes[0]?.data.triageState).toBeUndefined();
    expect(writes[0]?.data.errorDetail).toBe("421 too many connections");
  });

  it("stores an unattributable incident as platform", async () => {
    const { db, writes } = fakeDb([]);
    await upsertIncident(db, STORE, input, Timestamp.now());
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

  it("never re-opens a retired incident: the occurrence opens a new one (#63)", async () => {
    const { db, writes } = fakeDb([{ id: "retired", data: resolvedDoc({ retired: true }) }]);
    expect(await upsertIncident(db, STORE, input, Timestamp.now())).toBe("new");
    expect(writes.map((w) => w.op)).toEqual(["set"]);
    expect(writes[0]!.id).not.toBe("retired");
  });

  it("does not accrue onto a retired incident an operator reopened from ignored", async () => {
    // Retiring an ignored incident leaves it ignored, and an operator may move ignored back to new.
    const { db, writes } = fakeDb([{ id: "reopened", data: stored("2026-09-10T00:00:00.000Z", { status: "new", environment: "prod", retired: true }) }]);
    expect(await upsertIncident(db, STORE, input, Timestamp.now())).toBe("new");
    expect(writes[0]!.op).toBe("set");
  });

  it("skips a retired incident for an earlier resolved one that is not retired", async () => {
    const { db, writes } = fakeDb([
      { id: "retired", data: resolvedDoc({ retired: true }) },
      { id: "fixed", data: resolvedDoc() },
    ]);
    expect(await upsertIncident(db, STORE, input, Timestamp.now())).toBe("recurred");
    expect(writes[0]).toMatchObject({ op: "update", id: "fixed" });
  });

  it("ignores a key that still points at a retired incident, and moves it to the new one", async () => {
    const fp = computeErrorFingerprint(input.functionName, input.errorMessage);
    const { db, writes, keyWrites } = fakeDb([{ id: "retired", data: resolvedDoc({ retired: true }) }], {
      [incidentKeyId("prod", fp)]: "retired",
    });
    expect(await upsertIncident(db, STORE, input, Timestamp.now())).toBe("new");
    expect(writes[0]!.op).toBe("set");
    expect(keyWrites[0]?.data.incidentId).toBe("new-doc");
  });

  it("re-opens a resolved incident as recurred when its error fires after the resolution", async () => {
    const { db, writes } = fakeDb([
      { id: "fixed", data: resolvedDoc({ githubIssueNumber: 42, githubIssueUrl: "https://example.test/issues/42" }) },
    ]);

    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());

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
    const { db, writes } = fakeDb([
      { id: "fixed", data: resolvedDoc({ statusChangedBy: undefined }) },
    ]);
    await upsertIncident(db, STORE, input, Timestamp.now());
    const snap = writes[0]?.data.lastResolution as Record<string, unknown>;
    expect(Object.values(snap)).not.toContain(undefined);
    expect(snap).toEqual({ resolvedAt });
  });

  it("counts occurrences from before the resolution on the resolved incident without re-opening it", async () => {
    // Logs arrive with a lag, so a run can still carry the old failure.
    const { db, writes } = fakeDb([
      { id: "fixed", data: resolvedDoc({ resolvedAt: Timestamp.fromDate(new Date("2026-09-22T00:00:00.000Z")) }) },
    ]);

    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());

    expect(outcome).toBe("updated");
    expect(writes[0]?.id).toBe("fixed");
    expect(writes[0]?.data.status).toBeUndefined();
    expect(writes[0]?.data.recurrenceCount).toBeUndefined();
  });

  it("re-opens the most recently resolved copy when several share the fingerprint", async () => {
    const { db, writes } = fakeDb([
      { id: "older", data: resolvedDoc({ resolvedAt: Timestamp.fromDate(new Date("2026-09-01T00:00:00.000Z")) }) },
      { id: "latest", data: resolvedDoc({ resolvedAt: Timestamp.fromDate(new Date("2026-09-15T00:00:00.000Z")) }) },
    ]);
    await upsertIncident(db, STORE, input, Timestamp.now());
    expect(writes[0]?.id).toBe("latest");
  });

  it("prefers an open incident over a resolved one", async () => {
    const { db, writes } = fakeDb([
      { id: "fixed", data: resolvedDoc() },
      { id: "open", data: stored("2026-09-19T00:00:00.000Z", { status: "new" }) },
    ]);
    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());
    expect(outcome).toBe("updated");
    expect(writes[0]?.id).toBe("open");
  });

  it("never re-opens an ignored incident: the recurrence opens a fresh one", async () => {
    const { db, writes } = fakeDb([
      { id: "ignored", data: stored("2026-09-19T00:00:00.000Z", { status: "ignored" }) },
    ]);
    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());
    expect(outcome).toBe("new");
    expect(writes[0]).toMatchObject({ op: "set", id: "new-doc" });
  });

  it("looks for the resolved incident in the same environment, by fingerprint", async () => {
    const { db, queries } = fakeDb([]);
    await upsertIncident(db, STORE, input, Timestamp.now());
    const fp = computeErrorFingerprint(input.functionName, input.errorMessage);
    expect(queries[1]).toEqual([
      ["fingerprint", "==", fp],
      ["environment", "==", "prod"],
      ["status", "==", "resolved"],
    ]);
  });
});

describe("upsertIncident: incident keys", () => {
  const fp = computeErrorFingerprint(input.functionName, input.errorMessage);
  const keyId = incidentKeyId("prod", fp);

  it("runs as one transaction with a bounded number of attempts", async () => {
    const { db, txOptions } = fakeDb([]);
    await upsertIncident(db, STORE, input, Timestamp.now());
    expect(txOptions).toEqual([{ maxAttempts: UPSERT_MAX_ATTEMPTS }]);
  });

  it("reads the key before anything else, and points it at a new incident", async () => {
    const { db, reads, keyWrites } = fakeDb([]);
    await upsertIncident(db, STORE, input, Timestamp.now());
    expect(reads[0]).toBe(`incident_keys/${keyId}`);
    expect(keyWrites).toHaveLength(1);
    expect(keyWrites[0]).toMatchObject({
      op: "set",
      id: keyId,
      data: { incidentId: "new-doc", environment: "prod", fingerprint: fp },
    });
  });

  it("keys on the environment too, so environments never share an incident", () => {
    expect(incidentKeyId("prod", fp)).not.toBe(incidentKeyId("dev", fp));
    // An environment label is free text; the id must still be a valid document id.
    expect(incidentKeyId("a/b", fp)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accrues onto the keyed incident without querying, and leaves an unchanged key alone", async () => {
    const { db, writes, keyWrites, queries } = fakeDb(
      [
        { id: "keyed", data: stored("2026-09-20T00:00:00.000Z", { status: "acknowledged" }) },
        { id: "earlier-fork", data: stored("2026-09-01T00:00:00.000Z", { status: "new" }) },
      ],
      { [keyId]: "keyed" }
    );

    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());

    expect(outcome).toBe("updated");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.id).toBe("keyed");
    expect(queries).toHaveLength(0);
    expect(keyWrites).toHaveLength(0);
  });

  it("re-opens the keyed incident when it was resolved", async () => {
    const { db, writes } = fakeDb(
      [
        {
          id: "keyed",
          data: stored("2026-09-10T00:00:00.000Z", {
            status: "resolved",
            resolvedAt: Timestamp.fromDate(new Date("2026-09-20T00:00:00.000Z")),
          }),
        },
      ],
      { [keyId]: "keyed" }
    );
    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());
    expect(outcome).toBe("recurred");
    expect(writes[0]).toMatchObject({ op: "update", id: "keyed", data: { status: "recurred" } });
  });

  it("opens a fresh incident when the keyed one was ignored, and moves the key to it", async () => {
    const { db, writes, keyWrites } = fakeDb(
      [{ id: "ignored", data: stored("2026-09-19T00:00:00.000Z", { status: "ignored" }) }],
      { [keyId]: "ignored" }
    );

    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());

    expect(outcome).toBe("new");
    expect(writes).toEqual([expect.objectContaining({ op: "set", id: "new-doc" })]);
    expect(keyWrites[0]?.data.incidentId).toBe("new-doc");
  });

  it("adopts an incident stored before keys existed, and keys it", async () => {
    const { db, writes, keyWrites } = fakeDb([{ id: "legacy", data: stored("2026-09-19T00:00:00.000Z") }]);

    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());

    expect(outcome).toBe("updated");
    expect(writes[0]?.id).toBe("legacy");
    expect(keyWrites[0]?.data.incidentId).toBe("legacy");
  });

  it("ignores a key whose incident no longer holds the fingerprint", async () => {
    const { db, writes, keyWrites } = fakeDb(
      [
        { id: "rewritten", data: stored("2026-09-19T00:00:00.000Z", { errorMessage: "something else" }) },
        { id: "real", data: stored("2026-09-20T00:00:00.000Z") },
      ],
      { [keyId]: "rewritten" }
    );

    await upsertIncident(db, STORE, input, Timestamp.now());

    expect(writes[0]?.id).toBe("real");
    expect(keyWrites[0]?.data.incidentId).toBe("real");
  });

  it("ignores a key whose incident is gone", async () => {
    const { db, writes } = fakeDb([], { [keyId]: "deleted" });
    const outcome = await upsertIncident(db, STORE, input, Timestamp.now());
    expect(outcome).toBe("new");
    expect(writes[0]).toMatchObject({ op: "set", id: "new-doc" });
  });
});

describe("upsertIncident: replayed windows", () => {
  const fp = computeErrorFingerprint(input.functionName, input.errorMessage);
  const keyId = incidentKeyId("prod", fp);
  const open = () => ({ id: "keyed", data: stored("2026-09-20T00:00:00.000Z", { status: "acknowledged" }) });
  const ignoredDoc = () => ({ id: "keyed", data: stored("2026-09-20T00:00:00.000Z", { status: "ignored" }) });

  it("changes nothing for a window the key has already applied", async () => {
    const { db, writes, keyWrites } = fakeDb([open()], { [keyId]: { incidentId: "keyed", appliedWindows: ["w1"] } });
    const outcome = await upsertIncident(db, STORE, { ...input, windowId: "w1" }, Timestamp.now());
    expect(outcome).toBe("duplicate");
    expect(writes).toHaveLength(0);
    expect(keyWrites).toHaveLength(0);
  });

  it("accrues a new window and records it on the key, keeping the earlier ones", async () => {
    const { db, writes, keyWrites } = fakeDb([open()], { [keyId]: { incidentId: "keyed", appliedWindows: ["w1"] } });
    const outcome = await upsertIncident(db, STORE, { ...input, windowId: "w2" }, Timestamp.now());
    expect(outcome).toBe("updated");
    expect(writes).toHaveLength(1);
    // The pointer did not move, but the window still has to be recorded.
    expect(keyWrites).toHaveLength(1);
    expect(keyWrites[0]?.data).toMatchObject({ incidentId: "keyed", appliedWindows: ["w1", "w2"] });
  });

  it("records the window on a brand-new incident's key", async () => {
    const { db, keyWrites } = fakeDb([]);
    expect(await upsertIncident(db, STORE, { ...input, windowId: "w1" }, Timestamp.now())).toBe("new");
    expect(keyWrites[0]?.data).toMatchObject({ incidentId: "new-doc", appliedWindows: ["w1"] });
  });

  it("keeps only the most recent windows", async () => {
    const many = Array.from({ length: APPLIED_WINDOWS_RETAINED }, (_, i) => `old${i}`);
    const { db, keyWrites } = fakeDb([open()], { [keyId]: { incidentId: "keyed", appliedWindows: many } });
    await upsertIncident(db, STORE, { ...input, windowId: "latest" }, Timestamp.now());
    const kept = keyWrites[0]?.data.appliedWindows as string[];
    expect(kept).toHaveLength(APPLIED_WINDOWS_RETAINED);
    expect(kept.at(-1)).toBe("latest");
    expect(kept).not.toContain("old0");
  });

  it("carries the recorded windows over when the key moves to a fresh incident", async () => {
    const { db, keyWrites } = fakeDb([ignoredDoc()], { [keyId]: { incidentId: "keyed", appliedWindows: ["w1"] } });
    await upsertIncident(db, STORE, { ...input, windowId: "w2" }, Timestamp.now());
    expect(keyWrites[0]?.data).toMatchObject({ incidentId: "new-doc", appliedWindows: ["w1", "w2"] });
  });

  it("does not forget recorded windows when a call carries no windowId", async () => {
    const { db, keyWrites } = fakeDb([ignoredDoc()], { [keyId]: { incidentId: "keyed", appliedWindows: ["w1"] } });
    await upsertIncident(db, STORE, input, Timestamp.now());
    expect(keyWrites[0]?.data.appliedWindows).toEqual(["w1"]);
  });

  it("treats a malformed record as nothing applied rather than failing the write", async () => {
    const { db } = fakeDb([open()], { [keyId]: { incidentId: "keyed", appliedWindows: "not-a-list" } });
    expect(await upsertIncident(db, STORE, { ...input, windowId: "w1" }, Timestamp.now())).toBe("updated");
  });

  it("without a windowId every call counts (nothing to dedupe on)", async () => {
    const { db, writes } = fakeDb([open()], { [keyId]: "keyed" });
    await upsertIncident(db, STORE, input, Timestamp.now());
    await upsertIncident(db, STORE, input, Timestamp.now());
    expect(writes).toHaveLength(2);
  });
});

describe("upsertIncident: delayed logs", () => {
  it("never moves lastOccurredAt backwards", async () => {
    const later = Timestamp.fromDate(new Date("2026-09-25T00:00:00.000Z"));
    const { db, writes } = fakeDb([
      { id: "open", data: stored("2026-09-19T00:00:00.000Z", { lastOccurredAt: later }) },
    ]);
    await upsertIncident(db, STORE, input, Timestamp.now());
    expect(writes[0]?.data).not.toHaveProperty("lastOccurredAt");
  });

  it("moves lastOccurredAt forwards", async () => {
    const earlier = Timestamp.fromDate(new Date("2026-09-20T00:00:00.000Z"));
    const { db, writes } = fakeDb([
      { id: "open", data: stored("2026-09-19T00:00:00.000Z", { lastOccurredAt: earlier }) },
    ]);
    await upsertIncident(db, STORE, input, Timestamp.now());
    expect(writes[0]?.data.lastOccurredAt).toEqual(Timestamp.fromDate(at));
  });

  it("moves firstOccurredAt earlier when a delayed batch predates it", async () => {
    const { db, writes } = fakeDb([{ id: "open", data: stored("2026-09-22T00:00:00.000Z") }]);
    await upsertIncident(db, STORE, input, Timestamp.now());
    expect(writes[0]?.data.firstOccurredAt).toEqual(Timestamp.fromDate(at));
  });
});

describe("upsertIncident redaction", () => {
  const dirty: IncidentInput = {
    ...input,
    errorMessage: `auth failed for bob@y.org ${SEEDED_SECRETS.google}`,
    errorDetail: `password=hunter2 ${SEEDED_SECRETS.bearerHeader}`,
    stackTrace: `at x ${SEEDED_SECRETS.awsId}`,
    errorName: `E ${SEEDED_SECRETS.slack}`,
  };

  it("never writes a credential or email even when the caller didn't redact (new incident)", async () => {
    const { db, writes } = fakeDb([]);
    await upsertIncident(db, STORE, dirty, Timestamp.now());

    const written = JSON.stringify(writes);
    for (const needle of ["bob@y.org", "hunter2", ...Object.values(SEEDED_SECRETS)]) {
      expect(written).not.toContain(needle);
    }
    // Redaction happens before the fingerprint, so it keys on the redacted text.
    const data = writes[0]?.data;
    expect(data?.fingerprint).toBe(computeErrorFingerprint(dirty.functionName, data?.errorMessage as string));
  });

  it("never writes a credential when accruing onto an existing incident", async () => {
    const message = "auth failed for [redacted-email] [redacted-secret]";
    const { db, writes } = fakeDb([
      { id: "open", data: stored("2026-09-20T00:00:00.000Z", { errorMessage: message, triageState: "pending" }) },
    ]);
    await upsertIncident(db, STORE, dirty, Timestamp.now());

    const written = JSON.stringify(writes);
    for (const needle of ["bob@y.org", "hunter2", ...Object.values(SEEDED_SECRETS)]) {
      expect(written).not.toContain(needle);
    }
  });
});

