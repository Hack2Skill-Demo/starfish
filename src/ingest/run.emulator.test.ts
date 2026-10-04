/**
 * runIngest against the real Firestore emulator: the checkpoint, the window in flight, and what a
 * retry replays. The log read is stubbed (no Cloud Logging here), but the store is the real one, so
 * the last test shows a replayed window counted once end to end. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { testConfig } from "../testConfig.js";
import type { ResolvedConfig } from "../runtimeSettings.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("run.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

// The real aggregator reads Cloud Logging; here it reads whatever this holds.
const logs = { entries: [] as unknown[], filters: [] as string[] };
vi.mock("@google-cloud/logging", () => ({
  Logging: class {
    getEntries = async (request: { filter: string }) => {
      logs.filters.push(request.filter);
      return [logs.entries];
    };
  },
}));

const { runIngest, STATE_DOC, LAST_RUN_DOC, MAX_WINDOWS_PER_RUN } = await import("./run.js");
const { aggregateErrors } = await import("./aggregate.js");

const app = initializeApp({ projectId: "demo-starfish-rules" }, "run-emulator-tests");
const db: Firestore = getFirestore(app, "run-tests");
afterAll(() => deleteApp(app));

const HOUR = 3600_000;
const now = new Date("2026-10-04T12:00:00.000Z");
const horizon = new Date(now.getTime() - 5 * 60_000);

let config: StarfishConfig;
beforeEach(() => {
  const run = randomUUID().slice(0, 8);
  config = testConfig({
    projectId: "demo-starfish-rules",
    vertexProjectId: "demo-starfish-rules",
    watchedProjectId: "watched-app",
    settingsCollection: `settings_${run}`,
    incidentCollection: `incidents_${run}`,
    incidentKeyCollection: `keys_${run}`,
    runCollection: `runs_${run}`,
    databaseId: "run-tests",
  });
  logs.entries = [];
  logs.filters = [];
});

const loader = (over: Partial<ResolvedConfig> = {}) => ({
  resolve: async (): Promise<ResolvedConfig> => ({
    config,
    source: "env",
    problems: [],
    actionsAllowed: true,
    ...over,
  }),
});

const emptyResult = { entriesProcessed: 0, incidentsCreated: 0, incidentsUpdated: 0, incidentsRecurred: 0, incidentsReplayed: 0, capped: false };
const state = async () => (await db.collection(config.runCollection).doc(STATE_DOC).get()).data();
const lastRun = async () => (await db.collection(config.runCollection).doc(LAST_RUN_DOC).get()).data();
const ms = (t: unknown) => (t as Timestamp).toMillis();

describe("runIngest on the emulator", () => {
  it("covers the lookback in bounded windows that tile time, then has nothing left to do", async () => {
    const seen: { id: string; start: number; end: number }[] = [];
    const aggregate = async (_db: Firestore, _c: StarfishConfig, w: { id: string; start: Date; end: Date }) => {
      seen.push({ id: w.id, start: w.start.getTime(), end: w.end.getTime() });
      return emptyResult;
    };

    const first = await runIngest(db, loader(), now, { aggregate });

    expect(first).toMatchObject({ outcome: "ok", windows: 4 });
    expect(seen[0]?.start).toBe(horizon.getTime() - 24 * HOUR);
    expect(seen.at(-1)?.end).toBe(horizon.getTime());
    for (let i = 1; i < seen.length; i++) expect(seen[i]?.start).toBe(seen[i - 1]?.end);
    for (const w of seen) expect(w.end - w.start).toBeLessThanOrEqual(6 * HOUR);
    expect(new Set(seen.map((w) => w.id)).size).toBe(seen.length);
    expect(ms((await state())?.checkpoint)).toBe(horizon.getTime());
    expect((await state())?.pending).toBeUndefined();

    // Nothing has moved past the checkpoint: a second run reads nothing.
    seen.length = 0;
    const second = await runIngest(db, loader(), now, { aggregate });
    expect(second).toMatchObject({ outcome: "idle", windows: 0 });
    expect(seen).toHaveLength(0);
  });

  it("a later run starts exactly where the last one ended", async () => {
    const seen: { start: number; end: number }[] = [];
    const aggregate = async (_d: Firestore, _c: StarfishConfig, w: { start: Date; end: Date }) => {
      seen.push({ start: w.start.getTime(), end: w.end.getTime() });
      return emptyResult;
    };
    await runIngest(db, loader(), now, { aggregate });
    seen.length = 0;

    await runIngest(db, loader(), new Date(now.getTime() + HOUR), { aggregate });

    expect(seen).toEqual([{ start: horizon.getTime(), end: horizon.getTime() + HOUR }]);
  });

  it("a failed window stays pending, and a retry replays that same window even though the clock moved", async () => {
    const ids: string[] = [];
    let call = 0;
    const flaky = async (_d: Firestore, _c: StarfishConfig, w: { id: string }) => {
      ids.push(w.id);
      if (++call === 2) throw new Error("secret-token-in-message should never be stored");
      return emptyResult;
    };

    const failed = await runIngest(db, loader(), now, { aggregate: flaky });

    expect(failed).toMatchObject({ outcome: "failed", windows: 1, error: "Error" });
    const failedId = ids[1]!;
    const pending = (await state())?.pending;
    expect(ms(pending.end) - ms(pending.start)).toBeLessThanOrEqual(6 * HOUR);

    // An hour later: the clock moved, but the window in flight must not.
    ids.length = 0;
    const retry = await runIngest(db, loader(), new Date(now.getTime() + HOUR), { aggregate: flaky });

    expect(ids[0]).toBe(failedId);
    expect(retry.outcome).toBe("ok");
    expect((await state())?.pending).toBeUndefined();
  });

  it("replays a failed window whose end was set by the clock, not a fresh one from the later clock", async () => {
    config = { ...config, defaultLookbackHours: 2 };
    const ids: string[] = [];
    let fail = true;
    const aggregate = async (_d: Firestore, _c: StarfishConfig, w: { id: string }) => {
      ids.push(w.id);
      if (fail) throw new Error("boom");
      return emptyResult;
    };

    await runIngest(db, loader(), now, { aggregate });
    fail = false;
    await runIngest(db, loader(), new Date(now.getTime() + 30 * 60_000), { aggregate });

    // Planned again from the later clock, the window would end 30 minutes later and have another id.
    expect(ids[1]).toBe(ids[0]);
  });

  it("records the outcome for the UI without echoing the error message", async () => {
    await runIngest(db, loader({ source: "settings", problems: ["watchedProjectId"] }), now, {
      aggregate: async () => {
        throw Object.assign(new Error("db password=hunter2 leaked into a message"), { code: "UNAVAILABLE" });
      },
    });

    const record = await lastRun();
    expect(record).toMatchObject({
      environment: "prod",
      outcome: "failed",
      error: "UNAVAILABLE",
      configSource: "settings",
      problems: ["watchedProjectId"],
      actionsAllowed: true,
    });
    expect(JSON.stringify(record)).not.toContain("hunter2");
  });

  it("reports a capped read instead of calling the window complete", async () => {
    await runIngest(db, loader(), now, {
      aggregate: async () => ({ ...emptyResult, entriesProcessed: 5000, capped: true }),
    });
    expect(await lastRun()).toMatchObject({ outcome: "ok", capped: true, totals: { entriesProcessed: 20000 } });
  });

  it("does not carry a checkpoint over to a different watched project or environment", async () => {
    const aggregate = async () => emptyResult;
    await runIngest(db, loader(), now, { aggregate });

    config = { ...config, environment: "staging" };
    const starts: number[] = [];
    await runIngest(db, loader(), now, {
      aggregate: async (_d, _c, w) => {
        starts.push(w.start.getTime());
        return emptyResult;
      },
    });

    // Fresh target: back to the lookback, not the other target's checkpoint.
    expect(starts[0]).toBe(horizon.getTime() - 24 * HOUR);
  });

  it("stops without reading anything when the state can't be trusted", async () => {
    await db.collection(config.runCollection).doc(STATE_DOC).set({
      target: { watchedProjectId: config.watchedProjectId, environment: config.environment },
      checkpoint: "garbage",
    });
    let called = false;
    const result = await runIngest(db, loader(), now, {
      aggregate: async () => {
        called = true;
        return emptyResult;
      },
    });

    expect(result.outcome).toBe("failed");
    expect(called).toBe(false);
  });

  it("gives up on a window that never finishes, records the failure, and keeps the window pending", async () => {
    const result = await runIngest(db, loader(), now, { aggregate: () => new Promise(() => {}), windowTimeoutMs: 50 });

    expect(result).toMatchObject({ outcome: "failed", error: "TimeoutError", windows: 0 });
    expect(await lastRun()).toMatchObject({ outcome: "failed", error: "TimeoutError" });
    expect((await state())?.pending).toBeDefined();
  });

  it("two overlapping runs end up on the same windows, never on overlapping ones", async () => {
    // Two hours of lookback is one window whose end is set by the clock, so a different clock means a different window.
    config = { ...config, defaultLookbackHours: 2 };
    const calls: { id: string; start: number; end: number }[] = [];
    const aggregate = async (_d: Firestore, _c: StarfishConfig, w: { id: string; start: Date; end: Date }) => {
      calls.push({ id: w.id, start: w.start.getTime(), end: w.end.getTime() });
      await new Promise((r) => setTimeout(r, 20));
      return emptyResult;
    };

    // A slow run and the next scheduled one start together, a minute of clock apart.
    await Promise.all([
      runIngest(db, loader(), now, { aggregate }),
      runIngest(db, loader(), new Date(now.getTime() + 60_000), { aggregate }),
    ]);

    const windows = [...new Map(calls.map((c) => [c.id, c])).values()].sort((a, b) => a.start - b.start);
    expect(windows.length).toBeGreaterThan(0);
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.start).toBeGreaterThanOrEqual(windows[i - 1]!.end);
  });

  it("a run that finishes late never moves the checkpoint backwards", async () => {
    config = { ...config, defaultLookbackHours: 6 };
    const stateRef = db.collection(config.runCollection).doc(STATE_DOC);
    const target = { watchedProjectId: config.watchedProjectId, environment: config.environment };
    const ahead = new Date(horizon.getTime() + HOUR);

    // While this run is still working on its window, another run completes that window and moves on.
    await runIngest(db, loader(), now, {
      aggregate: async () => {
        await stateRef.set({ target, checkpoint: Timestamp.fromDate(ahead) });
        return emptyResult;
      },
    });

    expect(ms((await state())?.checkpoint)).toBe(ahead.getTime());
  });

  it("works through at most MAX_WINDOWS_PER_RUN windows per invocation", async () => {
    config = { ...config, defaultLookbackHours: 24 * 30 };
    let calls = 0;
    await runIngest(db, loader(), now, { aggregate: async () => (calls++, emptyResult) });
    expect(calls).toBe(MAX_WINDOWS_PER_RUN);
  });

  it("counts a replayed window once, end to end, through the real aggregator and store", async () => {
    logs.entries = [
      {
        metadata: { timestamp: new Date(horizon.getTime() - 3 * HOUR).toISOString(), resource: { labels: { function_name: "mailDrainer" } } },
        data: "email send failed",
      },
    ];
    config = { ...config, defaultLookbackHours: 6 };

    // The window commits, then the process dies before the checkpoint is written.
    const realThenCrash = async (d: Firestore, c: StarfishConfig, w: Parameters<typeof aggregateErrors>[2]) => {
      await aggregateErrors(d, c, w);
      throw new Error("died before the checkpoint");
    };
    expect((await runIngest(db, loader(), now, { aggregate: realThenCrash })).outcome).toBe("failed");

    // The retry replays the window through the real aggregator.
    const retry = await runIngest(db, loader(), now);
    expect(retry).toMatchObject({ outcome: "ok", totals: { incidentsCreated: 0, incidentsReplayed: 1 } });

    const docs = (await db.collection(config.incidentCollection).get()).docs;
    expect(docs).toHaveLength(1);
    expect(docs[0]?.get("occurrenceCount")).toBe(1);
    // The filter carried both ends of the window.
    expect(logs.filters.at(-1)).toMatch(/timestamp>"[^"]+"\ntimestamp<="[^"]+"/);
  });
});
