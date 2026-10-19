import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { AGENT_LAST_RUN_DOC, agentLastRunFields, agentPassFailed, newAgentPassReport, noteFailedStep, notePassSummary, recordAgentLastRun, recordAgentPassStarted } from "./lastRun.js";
import { parseAgentPassInProgress, parseAgentRunRecord } from "../agentRunRecord.js";

function fakeDb(fail = false) {
  const writes: { collection: string; id: string; data: Record<string, unknown> }[] = [];
  const db = {
    collection: (collection: string) => ({
      doc: (id: string) => ({
        set: async (data: Record<string, unknown>) => {
          if (fail) throw new Error("permission denied");
          writes.push({ collection, id, data });
        },
      }),
    }),
  } as unknown as Firestore;
  return { db, writes };
}

const STARTED = new Date("2026-10-10T10:30:00.000Z");
const FINISHED = new Date("2026-10-10T10:34:00.000Z");
const passSummary = (over: Record<string, unknown> = {}) => ({ considered: 2, ran: 2, results: [], errors: [], aborted: false, ...over });

describe("the agent's last-run record (#274)", () => {
  it("records an ok pass with its counts, the dry run, the daily cap and the schedule's interval", () => {
    const report = newAgentPassReport(STARTED, "demo");
    report.dryRun = true;
    notePassSummary(report, passSummary({ daily: { cap: 30, startedBefore: 4 }, gaveUp: [{ incidentId: "i1", reason: "deadline" }] }));
    const fields = agentLastRunFields(report, "30 * * * *", FINISHED);
    expect(fields).toMatchObject({
      environment: "demo",
      outcome: "ok",
      considered: 2,
      ran: 2,
      cycleErrors: 0,
      aborted: false,
      gaveUp: 1,
      scanCapped: false,
      failedSteps: [],
      problems: [],
      dryRun: true,
      daily: { cap: 30, startedBefore: 4 },
      intervalMinutes: 60,
    });
    // Firestore rejects undefined: optional fields are left out, never written empty.
    expect(Object.values(fields)).not.toContain(undefined);
    expect(fields).not.toHaveProperty("error");
    expect(fields).not.toHaveProperty("skipped");
  });

  it("holds no incident id, no error message and nothing from a cycle's result: guests may read it", () => {
    const report = newAgentPassReport(STARTED, "demo");
    notePassSummary(report, passSummary({ errors: [{ incidentId: "inc-secret", message: "Error: token=abc at /srv/app.js" }], sweepError: "boom user@example.com" }));
    const text = JSON.stringify(agentLastRunFields(report, undefined, FINISHED));
    expect(text).not.toContain("inc-secret");
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("example.com");
  });

  it("is failed exactly when a step failed, a cycle threw, the pass stopped early or never got going", () => {
    const ok = newAgentPassReport(STARTED, "demo");
    notePassSummary(ok, passSummary());
    expect(agentPassFailed(ok)).toBe(false);

    const threw = newAgentPassReport(STARTED, "demo");
    notePassSummary(threw, passSummary({ errors: [{ incidentId: "i", message: "x" }] }));
    expect(threw.failedSteps).toEqual(["cycles"]);
    expect(agentLastRunFields(threw, undefined, FINISHED)).toMatchObject({ outcome: "failed", cycleErrors: 1, failedSteps: ["cycles"] });

    const aborted = newAgentPassReport(STARTED, "demo");
    notePassSummary(aborted, passSummary({ aborted: true, sweepError: "x" }));
    expect(aborted.failedSteps).toEqual(["cycles", "sweep"]);

    const step = newAgentPassReport(STARTED, "demo");
    noteFailedStep(step, "pull-requests");
    noteFailedStep(step, "pull-requests");
    expect(step.failedSteps).toEqual(["pull-requests"]);
    expect(agentPassFailed(step)).toBe(true);

    const refused = newAgentPassReport(STARTED, "dev");
    refused.error = "settings-unusable";
    refused.problems = ["settings read failed: 14"];
    expect(agentLastRunFields(refused, undefined, FINISHED)).toMatchObject({ outcome: "failed", error: "settings-unusable", considered: 0, ran: 0, environment: "dev" });
  });

  it("says nothing about the next pass when the schedule is unknown or irregular", () => {
    const report = newAgentPassReport(STARTED, "demo");
    expect(agentLastRunFields(report, undefined, FINISHED)).not.toHaveProperty("intervalMinutes");
    expect(agentLastRunFields(report, "*/7 * * * *", FINISHED)).not.toHaveProperty("intervalMinutes");
    expect(agentLastRunFields(report, "*/10 * * * *", FINISHED)).toMatchObject({ intervalMinutes: 10 });
  });

  it("records the daily reopen limit the pass applied, which the Runs page holds Retry back by (#456)", () => {
    const report = newAgentPassReport(STARTED, "demo");
    expect(agentLastRunFields(report, undefined, FINISHED)).not.toHaveProperty("reconsiderMaxPerDay");
    report.reconsiderMaxPerDay = 3;
    const fields = agentLastRunFields(report, undefined, FINISHED);
    expect(fields).toMatchObject({ reconsiderMaxPerDay: 3 });
    expect(parseAgentRunRecord({ ...fields, finishedAt: { toDate: () => FINISHED } })?.reconsiderMaxPerDay).toBe(3);
    for (const bad of [0, -1, "3", Number.NaN]) {
      expect(parseAgentRunRecord({ ...fields, finishedAt: { toDate: () => FINISHED }, reconsiderMaxPerDay: bad })).not.toHaveProperty("reconsiderMaxPerDay");
    }
  });

  it("records the skip and the capped scan", () => {
    const report = newAgentPassReport(STARTED, "demo");
    notePassSummary(report, { ...passSummary({ considered: 0, ran: 0 }), skipped: "automation-disabled" });
    report.scanCapped = true;
    expect(agentLastRunFields(report, undefined, FINISHED)).toMatchObject({ outcome: "ok", skipped: "automation-disabled", scanCapped: true });
  });

  it("is written to {runCollection}/agent_last_run and read back by the shared parser", async () => {
    const { db, writes } = fakeDb();
    const report = newAgentPassReport(STARTED, "demo");
    report.dryRun = false;
    notePassSummary(report, passSummary({ skipped: "daily-cap", daily: { cap: 3, startedBefore: 3 } }));
    noteFailedStep(report, "escalation");
    expect(await recordAgentLastRun(db, { runCollection: "runs_x", agentSchedule: "30 * * * *" }, report, FINISHED)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ collection: "runs_x", id: AGENT_LAST_RUN_DOC });
    expect(parseAgentRunRecord(writes[0]!.data)).toEqual({
      environment: "demo",
      outcome: "failed",
      startedAt: STARTED,
      finishedAt: FINISHED,
      dryRun: false,
      considered: 2,
      ran: 2,
      cycleErrors: 0,
      aborted: false,
      gaveUp: 0,
      skipped: "daily-cap",
      scanCapped: false,
      daily: { cap: 3, startedBefore: 3 },
      failedSteps: ["escalation"],
      problems: [],
      intervalMinutes: 60,
    });
  });

  it("never throws: a failed write is reported as false", async () => {
    const { db } = fakeDb(true);
    expect(await recordAgentLastRun(db, { runCollection: "runs_x" }, newAgentPassReport(STARTED, "demo"), FINISHED)).toBe(false);
  });
});

describe("recordAgentPassStarted", () => {
  it("never throws, and creates nothing when the update failed for any reason but a missing record", async () => {
    let creates = 0;
    const db = {
      collection: () => ({
        doc: () => ({
          update: async () => {
            throw Object.assign(new Error("permission denied"), { code: 7 });
          },
          create: async () => void creates++,
        }),
      }),
    } as unknown as Firestore;
    expect(await recordAgentPassStarted(db, { runCollection: "runs_x" }, "demo", STARTED)).toBe(false);
    expect(creates).toBe(0);
  });
});

describe("parseAgentPassInProgress", () => {
  const ts = (d: Date) => ({ toDate: () => d });
  const since = new Date("2026-10-10T16:30:00.000Z");
  it("reads a start mark newer than the last finish, or on a record that has none", () => {
    expect(parseAgentPassInProgress({ environment: "demo", runningSince: ts(since), finishedAt: ts(new Date(since.getTime() - 3_600_000)) })).toEqual({ environment: "demo", since });
    expect(parseAgentPassInProgress({ environment: "demo", runningSince: ts(since) })).toEqual({ environment: "demo", since });
  });
  it("is null with no mark, an unusable one, or one the last finish is not older than", () => {
    expect(parseAgentPassInProgress(undefined)).toBeNull();
    expect(parseAgentPassInProgress({ environment: "demo" })).toBeNull();
    expect(parseAgentPassInProgress({ runningSince: "2026-10-10" })).toBeNull();
    expect(parseAgentPassInProgress({ runningSince: ts(since), finishedAt: ts(since) })).toBeNull();
  });
});

describe("parseAgentRunRecord", () => {
  const ts = (d: Date) => ({ toDate: () => d });
  it("refuses a record with no usable finish time or an unknown outcome", () => {
    expect(parseAgentRunRecord(undefined)).toBeNull();
    expect(parseAgentRunRecord({ outcome: "ok" })).toBeNull();
    expect(parseAgentRunRecord({ outcome: "ok", finishedAt: ts(new Date(Number.NaN)) })).toBeNull();
    expect(parseAgentRunRecord({ outcome: "idle", finishedAt: ts(FINISHED) })).toBeNull();
  });

  it("reads missing counts as zero, drops unknown labels and a bad interval", () => {
    const r = parseAgentRunRecord({
      outcome: "ok",
      finishedAt: ts(FINISHED),
      considered: -1,
      ran: "3",
      failedSteps: ["cycles", "rm -rf", 7],
      skipped: "because",
      intervalMinutes: 0,
      daily: { cap: "30" },
    });
    expect(r).toEqual({
      environment: "",
      outcome: "ok",
      finishedAt: FINISHED,
      considered: 0,
      ran: 0,
      cycleErrors: 0,
      aborted: false,
      gaveUp: 0,
      scanCapped: false,
      failedSteps: ["cycles"],
      problems: [],
    });
  });
});
