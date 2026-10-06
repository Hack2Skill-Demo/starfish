import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase/firestore";

const mocks = vi.hoisted(() => ({ data: undefined as Record<string, unknown> | undefined, path: [] as string[] }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...segments: string[]) => ({ segments }),
  getDoc: async (ref: { segments: string[] }) => {
    mocks.path = ref.segments;
    return { exists: () => mocks.data !== undefined, data: () => mocks.data };
  },
}));

import { judgeRun, nextRunAt, readLastRun, type LastRun } from "./engineStatus";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const stored = (over: Record<string, unknown> = {}) => ({
  environment: "demo",
  outcome: "ok",
  finishedAt: ts(NOW - 10 * 60_000),
  windows: 2,
  capped: false,
  totals: { entriesProcessed: 12, incidentsCreated: 1, incidentsUpdated: 3, incidentsRecurred: 0, incidentsReplayed: 0 },
  problems: [],
  ...over,
});
const run = (over: Partial<LastRun> = {}): LastRun => ({
  environment: "demo",
  outcome: "ok",
  finishedAt: new Date(NOW - 10 * 60_000),
  windows: 1,
  capped: false,
  totals: { entriesProcessed: 0, incidentsCreated: 0, incidentsUpdated: 0, incidentsRecurred: 0 },
  problems: [],
  ...over,
});

describe("readLastRun", () => {
  beforeEach(() => {
    mocks.data = undefined;
  });

  it("reads {runCollection}/last_run", async () => {
    mocks.data = stored();
    await readLastRun({} as Firestore, "my_runs");
    expect(mocks.path).toEqual(["my_runs", "last_run"]);
  });

  it("reads when the run started and how often runs are started, and ignores an interval that is not a positive number", async () => {
    mocks.data = stored({ startedAt: ts(NOW - 11 * 60_000), intervalMinutes: 5 });
    expect(await readLastRun({} as Firestore, "r")).toMatchObject({ startedAt: new Date(NOW - 11 * 60_000), intervalMinutes: 5 });
    for (const bad of [0, -5, "5", Number.NaN]) {
      mocks.data = stored({ intervalMinutes: bad });
      expect((await readLastRun({} as Firestore, "r"))?.intervalMinutes).toBeUndefined();
    }
  });

  it("returns the run's outcome, time and counts", async () => {
    mocks.data = stored({ capped: true, problems: ["environment"] });
    const r = await readLastRun({} as Firestore, "starfish_runs");
    expect(r).toMatchObject({
      environment: "demo",
      outcome: "ok",
      windows: 2,
      capped: true,
      problems: ["environment"],
      totals: { entriesProcessed: 12, incidentsCreated: 1, incidentsUpdated: 3, incidentsRecurred: 0 },
    });
    expect(r?.finishedAt.getTime()).toBe(NOW - 10 * 60_000);
  });

  it("is null when nothing has been recorded", async () => {
    expect(await readLastRun({} as Firestore, "starfish_runs")).toBeNull();
  });

  it.each([
    ["no finish time", { finishedAt: undefined }],
    ["an unreadable finish time", { finishedAt: ts(NaN) }],
    ["an outcome it doesn't know", { outcome: "exploded" }],
  ])("is null for a record with %s, rather than guessing", async (_name, over) => {
    mocks.data = stored(over);
    expect(await readLastRun({} as Firestore, "starfish_runs")).toBeNull();
  });

  it("tolerates missing counts and keeps the error label", async () => {
    mocks.data = stored({ outcome: "failed", totals: undefined, error: "UNAVAILABLE", problems: "nope" });
    const r = await readLastRun({} as Firestore, "starfish_runs");
    expect(r).toMatchObject({ outcome: "failed", error: "UNAVAILABLE", problems: [], totals: { entriesProcessed: 0 } });
  });
});

describe("judgeRun", () => {
  const judge = (r: LastRun | null, env = "demo", stale = 90) => judgeRun(r, env, NOW, stale).state;

  it("a recent successful run is ok; a run with nothing new is ok too", () => {
    expect(judge(run())).toBe("ok");
    expect(judge(run({ outcome: "idle" }))).toBe("ok");
  });

  it("a failed last run is failed, however recent", () => {
    expect(judge(run({ outcome: "failed" }))).toBe("failed");
  });

  it("a run that finished longer ago than the threshold means the engine stopped", () => {
    expect(judge(run({ finishedAt: new Date(NOW - 91 * 60_000) }))).toBe("stale");
    expect(judge(run({ finishedAt: new Date(NOW - 89 * 60_000) }))).toBe("ok");
    expect(judge(run({ finishedAt: new Date(NOW - 20 * 60_000) }), "demo", 15)).toBe("stale");
  });

  it("a read that hit the cap says so", () => {
    expect(judge(run({ capped: true }))).toBe("capped");
  });

  it("worst first: failed beats stale beats capped", () => {
    const old = new Date(NOW - 5 * 3600_000);
    expect(judge(run({ outcome: "failed", finishedAt: old, capped: true }))).toBe("failed");
    expect(judge(run({ finishedAt: old, capped: true }))).toBe("stale");
  });

  it("no record, or one for another environment, is never", () => {
    expect(judge(null)).toBe("never");
    expect(judge(run({ environment: "prod" }), "demo")).toBe("never");
    expect(judgeRun(run({ environment: "prod" }), "demo", NOW, 90).run).toBeNull();
  });
});

describe("nextRunAt", () => {
  const started = new Date("2026-10-05T12:00:00.000Z");
  it("is the last start plus the schedule's interval", () => {
    expect(nextRunAt({ startedAt: started, intervalMinutes: 5 })?.toISOString()).toBe("2026-10-05T12:05:00.000Z");
  });
  it("says nothing when the engine did not say how often it runs", () => {
    expect(nextRunAt({ startedAt: started })).toBeNull();
    expect(nextRunAt({ intervalMinutes: 5 })).toBeNull();
    expect(nextRunAt(null)).toBeNull();
  });
});
