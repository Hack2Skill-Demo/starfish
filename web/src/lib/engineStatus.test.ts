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

import { agentActivity, judgeAgentRun, judgeRun, nextRunAt, readAgentPass, readLastRun, type AgentRunRecord, type LastRun } from "./engineStatus";
import { judgeAgentRun as cliJudgeAgent, judgeRun as cliJudge, parseRunRecord } from "../../../src/status";
import { parseAgentRunRecord } from "../../../src/agentRunRecord";

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

  it("a checkpoint further behind than twice the schedule's interval is behind, though every run said ok (#297)", () => {
    expect(judge(run({ intervalMinutes: 60, lagSeconds: 121 * 60 }))).toBe("behind");
    expect(judge(run({ intervalMinutes: 60, lagSeconds: 120 * 60 }))).toBe("ok");
    expect(judge(run({ intervalMinutes: 60, lagSeconds: 0 }))).toBe("ok");
    // No interval recorded: the stale threshold. A configured threshold beats both.
    expect(judge(run({ lagSeconds: 91 * 60 }))).toBe("behind");
    expect(judge(run({ lagSeconds: 89 * 60 }))).toBe("ok");
    expect(judgeRun(run({ intervalMinutes: 60, lagSeconds: 31 * 60 }), "demo", NOW, 90, 30).state).toBe("behind");
    // No lag recorded (an older record): never behind. Missing is not a large number.
    expect(judge(run({ intervalMinutes: 1 }))).toBe("ok");
  });

  it("reads the lag and ignores one that is not a count of seconds", async () => {
    mocks.data = stored({ lagSeconds: 4200 });
    expect((await readLastRun({} as Firestore, "r"))?.lagSeconds).toBe(4200);
    for (const bad of [-1, "4200", Number.NaN]) {
      mocks.data = stored({ lagSeconds: bad });
      expect((await readLastRun({} as Firestore, "r"))?.lagSeconds).toBeUndefined();
    }
  });

  it("worst first: failed beats stale beats behind beats capped", () => {
    const behind = { intervalMinutes: 5, lagSeconds: 3600 };
    expect(judge(run({ ...behind, capped: true }))).toBe("behind");
    expect(judge(run({ ...behind, finishedAt: new Date(NOW - 5 * 3600_000) }))).toBe("stale");
    expect(judge(run({ ...behind, outcome: "failed" }))).toBe("failed");
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

  it("a refusal on unusable settings is failed whatever environment it names: it records the env default's (#223)", () => {
    const refusal = run({ environment: "dev", outcome: "failed", error: "settings-unusable", problems: ["settings read failed: 14"] });
    expect(judgeRun(refusal, "demo", NOW, 90)).toEqual({ state: "failed", run: refusal });
    expect(judge({ ...refusal, environment: "demo" })).toBe("failed");
    // Only that refusal: another failure recorded for another environment is still not this one's run.
    expect(judge({ ...refusal, error: "TimeoutError" })).toBe("never");
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

// `pnpm status` (src/status.ts) promises a terminal the same verdict this page shows (#190): the same stored record,
// read by each side's parser and judged by each side's judge, must agree.
describe("agreement with pnpm status", () => {
  const cases: [string, Record<string, unknown> | undefined, string][] = [
    ["ok", stored(), "demo"],
    ["idle", stored({ outcome: "idle" }), "demo"],
    ["failed", stored({ outcome: "failed", capped: true, finishedAt: ts(NOW - 500 * 60_000) }), "demo"],
    ["stale", stored({ finishedAt: ts(NOW - 91 * 60_000) }), "demo"],
    ["capped", stored({ capped: true }), "demo"],
    ["behind (#297)", stored({ intervalMinutes: 60, lagSeconds: 3 * 3600, capped: true }), "demo"],
    ["behind on the stale threshold, no interval recorded", stored({ lagSeconds: 91 * 60 }), "demo"],
    ["a lag under the threshold", stored({ intervalMinutes: 60, lagSeconds: 3600 }), "demo"],
    ["an unusable lag", stored({ intervalMinutes: 60, lagSeconds: "9999" }), "demo"],
    ["another environment", stored(), "prod"],
    ["a settings refusal for another environment (#223)", stored({ outcome: "failed", error: "settings-unusable", environment: "dev" }), "demo"],
    ["another failure for another environment", stored({ outcome: "failed", error: "TimeoutError", environment: "dev" }), "demo"],
    ["no environment recorded", stored({ environment: undefined }), "demo"],
    ["an unknown outcome", stored({ outcome: "exploded" }), "demo"],
    ["no finish time", stored({ finishedAt: undefined }), "demo"],
    ["no record at all", undefined, "demo"],
  ];

  it.each(cases)("%s", async (_name, data, env) => {
    mocks.data = data;
    const ui = judgeRun(await readLastRun({} as Firestore, "r"), env, NOW, 90).state;
    expect(cliJudge(parseRunRecord(data), env, new Date(NOW), 90)).toBe(ui);
  });
});

// The agent pass's own record (#274), written by src/agent/lastRun.ts.
describe("the agent's last pass", () => {
  const storedPass = (over: Record<string, unknown> = {}) => ({
    environment: "demo",
    outcome: "ok",
    startedAt: ts(NOW - 14 * 60_000),
    finishedAt: ts(NOW - 10 * 60_000),
    dryRun: true,
    considered: 2,
    ran: 1,
    cycleErrors: 0,
    aborted: false,
    gaveUp: 0,
    scanCapped: false,
    failedSteps: [],
    problems: [],
    intervalMinutes: 60,
    ...over,
  });
  const pass = (over: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
    environment: "demo",
    outcome: "ok",
    finishedAt: new Date(NOW - 10 * 60_000),
    considered: 0,
    ran: 0,
    cycleErrors: 0,
    aborted: false,
    gaveUp: 0,
    scanCapped: false,
    failedSteps: [],
    problems: [],
    ...over,
  });

  beforeEach(() => {
    mocks.data = undefined;
  });

  it("reads {runCollection}/agent_last_run, and is null when no pass was recorded", async () => {
    expect((await readAgentPass({} as Firestore, "my_runs")).run).toBeNull();
    expect(mocks.path).toEqual(["my_runs", "agent_last_run"]);
    mocks.data = storedPass();
    expect((await readAgentPass({} as Firestore, "my_runs")).run).toMatchObject({
      outcome: "ok",
      dryRun: true,
      considered: 2,
      ran: 1,
      intervalMinutes: 60,
      startedAt: new Date(NOW - 14 * 60_000),
    });
  });

  it("is null for a record it cannot use, rather than guessing", async () => {
    mocks.data = storedPass({ outcome: "idle" });
    expect((await readAgentPass({} as Firestore, "r")).run).toBeNull();
    mocks.data = storedPass({ finishedAt: undefined });
    expect((await readAgentPass({} as Firestore, "r")).run).toBeNull();
  });

  it("is judged like the ingest's run, a capped candidate scan being its 'capped'", () => {
    const judge = (r: AgentRunRecord | null, env = "demo") => judgeAgentRun(r, env, NOW, 90).state;
    expect(judge(null)).toBe("never");
    expect(judge(pass())).toBe("ok");
    expect(judge(pass({ outcome: "failed", failedSteps: ["cycles"] }))).toBe("failed");
    expect(judge(pass({ finishedAt: new Date(NOW - 91 * 60_000) }))).toBe("stale");
    expect(judge(pass({ scanCapped: true }))).toBe("capped");
    expect(judge(pass({ environment: "prod" }))).toBe("never");
    expect(judgeAgentRun(pass({ environment: "prod" }), "demo", NOW, 90).run).toBeNull();
    const refusal = pass({ environment: "dev", outcome: "failed", error: "settings-unusable" });
    expect(judgeAgentRun(refusal, "demo", NOW, 90)).toEqual({ state: "failed", run: refusal });
  });

  it("reads a pass in progress from its start mark, a first pass's included", async () => {
    mocks.data = storedPass({ runningSince: ts(NOW - 30_000) });
    expect(await readAgentPass({} as Firestore, "r")).toMatchObject({ run: { outcome: "ok" }, inProgress: { environment: "demo", since: new Date(NOW - 30_000) } });
    mocks.data = { environment: "demo", runningSince: ts(NOW - 30_000) };
    expect(await readAgentPass({} as Firestore, "r")).toEqual({ run: null, inProgress: { environment: "demo", since: new Date(NOW - 30_000) } });
    mocks.data = storedPass();
    expect((await readAgentPass({} as Firestore, "r")).inProgress).toBeNull();
  });

  it("says what the agent is doing now: running, overrun, due or idle", () => {
    const activity = (p: { run: AgentRunRecord | null; inProgress: { environment: string; since: Date } | null }, env = "demo") =>
      agentActivity(p, judgeAgentRun(p.run, env, NOW, 90), env, NOW, 90);
    const hourly = pass({ startedAt: new Date(NOW - 14 * 60_000), intervalMinutes: 60 });
    const late = pass({ startedAt: new Date(NOW - 61 * 60_000), finishedAt: new Date(NOW - 60 * 60_000), intervalMinutes: 60 });
    expect(activity({ run: hourly, inProgress: null })).toEqual({ kind: "idle" });
    expect(activity({ run: late, inProgress: null })).toEqual({ kind: "due", dueAt: new Date(NOW - 60_000) });
    expect(activity({ run: late, inProgress: { environment: "demo", since: new Date(NOW - 20_000) } })).toEqual({ kind: "running", since: new Date(NOW - 20_000) });
    expect(activity({ run: null, inProgress: { environment: "demo", since: new Date(NOW - 20_000) } })).toEqual({ kind: "running", since: new Date(NOW - 20_000) });
    expect(activity({ run: late, inProgress: { environment: "demo", since: new Date(NOW - 91 * 60_000) } })).toEqual({ kind: "overrun", since: new Date(NOW - 91 * 60_000) });
    // Another environment's mark is not this one's pass; a failed or unscheduled pass promises no next one.
    expect(activity({ run: late, inProgress: { environment: "prod", since: new Date(NOW - 20_000) } })).toEqual({ kind: "due", dueAt: new Date(NOW - 60_000) });
    expect(activity({ run: { ...late, outcome: "failed", failedSteps: ["cycles"] }, inProgress: null })).toEqual({ kind: "idle" });
    expect(activity({ run: pass({ startedAt: new Date(NOW - 61 * 60_000) }), inProgress: null })).toEqual({ kind: "idle" });
  });

  it("says when the next pass is expected from its start and interval", () => {
    expect(nextRunAt(pass({ startedAt: new Date(NOW - 14 * 60_000), intervalMinutes: 60 }))?.getTime()).toBe(NOW + 46 * 60_000);
    expect(nextRunAt(pass({ startedAt: new Date(NOW) }))).toBeNull();
  });

  // `pnpm status` and this page judge the same stored record the same way.
  it.each([
    ["ok", storedPass(), "demo"],
    ["failed", storedPass({ outcome: "failed", failedSteps: ["escalation"] }), "demo"],
    ["stale", storedPass({ finishedAt: ts(NOW - 91 * 60_000) }), "demo"],
    ["capped", storedPass({ scanCapped: true }), "demo"],
    ["another environment", storedPass(), "prod"],
    ["a settings refusal for another environment", storedPass({ outcome: "failed", error: "settings-unusable", environment: "dev" }), "demo"],
    ["no record at all", undefined, "demo"],
  ] as [string, Record<string, unknown> | undefined, string][])("agrees with pnpm status: %s", async (_name, data, env) => {
    mocks.data = data;
    const ui = judgeAgentRun((await readAgentPass({} as Firestore, "r")).run, env, NOW, 90).state;
    expect(cliJudgeAgent(parseAgentRunRecord(data), env, new Date(NOW), 90)).toBe(ui);
  });
});
