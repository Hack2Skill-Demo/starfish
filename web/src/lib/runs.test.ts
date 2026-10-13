import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The guest data path of the Runs page and the Overview's feed (#18): a guest subscribes to the trimmed copies, an
 * operator to the stored cycles and their events, and the switch is in the data layer (dataSource.ts), not the pages.
 */
const fs = vi.hoisted(() => ({
  collection: vi.fn((_db: unknown, ...path: string[]) => ({ kind: "collection", path: path.join("/") })),
  collectionGroup: vi.fn((_db: unknown, id: string) => ({ kind: "group", path: id })),
  doc: vi.fn((_db: unknown, ...path: string[]) => ({ kind: "doc", path: path.join("/") })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ where: [field, op, value] })),
  orderBy: vi.fn((field: string, dir: string) => ({ orderBy: [field, dir] })),
  limit: vi.fn((n: number) => ({ limit: n })),
  query: vi.fn((source: { path: string; kind: string }, ...parts: unknown[]) => ({ source, parts })),
  onSnapshot: vi.fn(),
  getDoc: vi.fn(),
}));
const auth = vi.hoisted(() => ({ currentUser: null as null | { isAnonymous: boolean } }));
vi.mock("firebase/firestore", async (orig) => ({ ...(await orig<typeof import("firebase/firestore")>()), ...fs }));
vi.mock("./firebase", () => ({ firestore: vi.fn(), firebaseAuth: () => auth }));
vi.mock("./config", () => ({
  webConfig: () => ({
    cycleCollection: "starfish_cycles",
    publicCycleCollection: "starfish_public_cycles",
    publicEventCollection: "starfish_public_events",
  }),
}));

import { Timestamp } from "firebase/firestore";
import { ACTIVITY_LIMIT, CYCLE_LIMIT_MAX, EVENT_LIMIT, readCycle, subscribeCycles, subscribeEvents, subscribeLatestEvents } from "./runs";
import { SCAN_LIMIT } from "./incidents";
import type { ActivityRow } from "./overviewModel";
import type { EventRow } from "./runsModel";

type Q = { source: { path: string; kind: string }; parts: unknown[] };
const lastQuery = (): Q => fs.onSnapshot.mock.calls.at(-1)![0] as Q;
/** Feed the subscription a snapshot of `docs`. */
const deliver = (docs: { id: string; path?: string; data: Record<string, unknown> }[]) => {
  const onNext = fs.onSnapshot.mock.calls.at(-1)![1] as (snap: unknown) => void;
  onNext({ size: docs.length, docs: docs.map((d) => ({ id: d.id, ref: { path: d.path ?? d.id }, data: () => d.data })) });
};
const at = (ms: number) => Timestamp.fromMillis(ms);

beforeEach(() => {
  vi.clearAllMocks();
  auth.currentUser = null;
});

describe("the read limits", () => {
  it("stay within the 500 documents firestore.rules allows a guest's query (guestList)", () => {
    for (const n of [CYCLE_LIMIT_MAX, EVENT_LIMIT, ACTIVITY_LIMIT, SCAN_LIMIT]) expect(n).toBeLessThanOrEqual(500);
  });
});

describe("operators read the stored documents", () => {
  beforeEach(() => {
    auth.currentUser = { isAnonymous: false };
  });

  it("cycles, one cycle, a run's events and the feed", async () => {
    subscribeCycles("demo", vi.fn(), vi.fn());
    expect(lastQuery().source.path).toBe("starfish_cycles");
    subscribeEvents("inc1_r0", "demo", vi.fn(), vi.fn());
    expect(lastQuery().source.path).toBe("starfish_cycles/inc1_r0/events");
    expect(lastQuery().parts).toContainEqual({ where: ["environment", "==", "demo"] });
    subscribeLatestEvents("demo", vi.fn(), vi.fn());
    expect(lastQuery().source).toEqual({ kind: "group", path: "events" });
    fs.getDoc.mockResolvedValue({ exists: () => false });
    await readCycle("inc1_r0", "demo");
    expect(fs.doc.mock.calls.at(-1)!.slice(1)).toEqual(["starfish_cycles", "inc1_r0"]);
  });
});

/** `n` stored events of one run, newest first, the way the query returns them (doc id = zero-padded seq). */
const storedNewestFirst = (n: number, top: number) =>
  Array.from({ length: n }, (_, i) => {
    const seq = top - i;
    return { id: String(seq).padStart(6, "0"), data: { seq, environment: "demo", stage: "escalation", type: "called", at: at(seq * 1000) } };
  });

describe("a run's events: its newest ones, and whether there are older (#326)", () => {
  beforeEach(() => {
    auth.currentUser = { isAnonymous: false };
  });

  it("orders by seq newest first and asks for one more than it keeps, for both operators and guests", () => {
    for (const anonymous of [false, true]) {
      auth.currentUser = { isAnonymous: anonymous };
      subscribeEvents("inc1_r0", "demo", vi.fn(), vi.fn());
      const parts = lastQuery().parts;
      expect(parts).toContainEqual({ orderBy: ["seq", "desc"] });
      expect(parts).toContainEqual({ limit: EVENT_LIMIT + 1 });
      // Still within what firestore.rules serves a guest (guestList).
      expect(EVENT_LIMIT + 1).toBeLessThanOrEqual(500);
    }
  });

  it("a run with more events than the limit is drawn with its LATEST ones, in sequence order, and says it is capped", () => {
    const onData = vi.fn<(rows: EventRow[], capped: boolean) => void>();
    subscribeEvents("inc1_r0", "demo", onData, vi.fn());
    // 250 events: the query returns seq 250..50 (the limit plus one), newest first.
    deliver(storedNewestFirst(EVENT_LIMIT + 1, 250));
    const [rows, capped] = onData.mock.calls[0]!;
    expect(capped).toBe(true);
    expect(rows).toHaveLength(EVENT_LIMIT);
    expect(rows[0]!.seq).toBe(51);
    expect(rows.at(-1)!.seq).toBe(250);
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((a, b) => a - b));
  });

  it("a run holding exactly the limit, or fewer, is not capped", () => {
    for (const n of [EVENT_LIMIT, 3]) {
      const onData = vi.fn<(rows: EventRow[], capped: boolean) => void>();
      subscribeEvents("inc1_r0", "demo", onData, vi.fn());
      deliver(storedNewestFirst(n, n));
      const [rows, capped] = onData.mock.calls[0]!;
      expect(capped).toBe(false);
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    }
  });

  it("a guest's capped read keeps the newest copies too", () => {
    auth.currentUser = { isAnonymous: true };
    const onData = vi.fn<(rows: EventRow[], capped: boolean) => void>();
    subscribeEvents("inc1_r0", "demo", onData, vi.fn());
    deliver(storedNewestFirst(EVENT_LIMIT + 1, 300).map((d) => ({ id: `inc1_r0_${d.id}`, data: { ...d.data, cycleId: "inc1_r0" } })));
    const [rows, capped] = onData.mock.calls[0]!;
    expect(capped).toBe(true);
    expect(rows).toHaveLength(EVENT_LIMIT);
    expect([rows[0]!.id, rows.at(-1)!.id]).toEqual(["000101", "000300"]);
  });
});

describe("a guest reads the trimmed copies", () => {
  beforeEach(() => {
    auth.currentUser = { isAnonymous: true };
  });

  it("cycles and one cycle from the cycle copies, with the same environment filter", async () => {
    subscribeCycles("demo", vi.fn(), vi.fn());
    expect(lastQuery().source.path).toBe("starfish_public_cycles");
    expect(lastQuery().parts).toContainEqual({ where: ["environment", "==", "demo"] });
    fs.getDoc.mockResolvedValue({ exists: () => true, id: "inc1_r0", data: () => ({ publicView: 1, incidentId: "inc1", environment: "demo", state: "done", createdAt: at(1), updatedAt: at(2), summary: { triage: { decision: "decline" } } }) });
    const cycle = await readCycle("inc1_r0", "demo");
    expect(fs.doc.mock.calls.at(-1)!.slice(1)).toEqual(["starfish_public_cycles", "inc1_r0"]);
    expect(cycle).toMatchObject({ id: "inc1_r0", trimmed: true, summary: { triage: { decision: "decline" } } });
  });

  it("a run's events from the flat event copies, by cycle and environment, keyed by their own sequence", () => {
    const onData = vi.fn<(rows: EventRow[]) => void>();
    subscribeEvents("inc1_r0", "demo", onData, vi.fn());
    const q = lastQuery();
    expect(q.source.path).toBe("starfish_public_events");
    expect(q.parts).toContainEqual({ where: ["cycleId", "==", "inc1_r0"] });
    expect(q.parts).toContainEqual({ where: ["environment", "==", "demo"] });
    deliver([
      { id: "inc1_r0_000002", data: { cycleId: "inc1_r0", environment: "demo", seq: 2, stage: "pr", type: "dry-run", summary: "nothing opened", at: at(2000) } },
      { id: "inc1_r0_000001", data: { cycleId: "inc1_r0", environment: "demo", seq: 1, stage: "triage", type: "decision", at: at(1000) } },
      // Not this run's: never shown under it.
      { id: "inc9_r0_000001", data: { cycleId: "inc9_r0", environment: "demo", seq: 1, stage: "triage", at: at(500) } },
    ]);
    const rows = onData.mock.calls[0]![0];
    expect(rows.map((r) => [r.id, r.seq, r.stage])).toEqual([
      ["000001", 1, "triage"],
      ["000002", 2, "pr"],
    ]);
    // A triage event's copy has no summary (the model's words): the row shows none, rather than a placeholder.
    expect(rows[0]!.summary).toBe("");
    expect(rows[0]!.data).toEqual({});
  });

  it("the feed from the event copies, newest first, each under the run its copy names", () => {
    const onData = vi.fn<(rows: ActivityRow[]) => void>();
    subscribeLatestEvents("demo", onData, vi.fn());
    const q = lastQuery();
    expect(q.source).toEqual({ kind: "collection", path: "starfish_public_events" });
    expect(q.parts).toContainEqual({ where: ["environment", "==", "demo"] });
    expect(q.parts).toContainEqual({ orderBy: ["at", "desc"] });
    expect(fs.collectionGroup).not.toHaveBeenCalled();
    deliver([
      { id: "a_r0_000001", data: { cycleId: "a_r0", environment: "demo", seq: 1, stage: "cycle", type: "started", summary: "Attempt 1", at: at(1000) } },
      { id: "b_r0_000003", data: { cycleId: "b_r0", environment: "demo", seq: 3, stage: "pr", type: "opened", summary: "Pull request opened", at: at(3000) } },
      // A copy whose id is not its cycle's, or of another environment: left out.
      { id: "zzz", data: { cycleId: "a_r0", environment: "demo", seq: 2, stage: "fix", at: at(5000) } },
      { id: "c_r0_000001", data: { cycleId: "c_r0", environment: "prod", seq: 1, stage: "fix", at: at(6000) } },
    ]);
    expect(onData.mock.calls[0]![0].map((r) => [r.cycleId, r.id])).toEqual([
      ["b_r0", "000003"],
      ["a_r0", "000001"],
    ]);
  });
});
