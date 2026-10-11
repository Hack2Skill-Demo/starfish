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
import { RuntimeConfigLoader, SETTINGS_DOC, type ResolvedConfig } from "../runtimeSettings.js";
import type { AggregateDeps } from "./aggregate.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("run.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

// The real aggregator reads Cloud Logging; here it reads whatever this holds, as Logging would: only
// the entries inside the filter's (start, end], in the requested order, a page of `pageSize` at a time from the
// page token on with autoPaginate off (#296), else at most `maxResults` of them.
const logs = { entries: [] as unknown[], filters: [] as string[] };
const timeOf = (e: unknown) => Date.parse((e as { metadata: { timestamp: string } }).metadata.timestamp);
vi.mock("@google-cloud/logging", () => ({
  Logging: class {
    getEntries = async (request: { filter: string; orderBy?: string; maxResults?: number; pageSize?: number; pageToken?: string; autoPaginate?: boolean }) => {
      logs.filters.push(request.filter);
      const bound = (op: string) => {
        const m = request.filter.match(new RegExp(`timestamp${op}"([^"]+)"`));
        return m ? Date.parse(m[1]!) : undefined;
      };
      const after = bound(">") ?? -Infinity;
      const upTo = bound("<=") ?? Infinity;
      const inWindow = logs.entries
        .filter((e) => timeOf(e) > after && timeOf(e) <= upTo)
        .sort((a, b) => timeOf(a) - timeOf(b));
      if (request.orderBy === "timestamp desc") inWindow.reverse();
      if (request.autoPaginate !== false) return [inWindow.slice(0, request.maxResults ?? inWindow.length), null, {}];
      const from = Number(request.pageToken ?? 0);
      const to = from + (request.pageSize ?? inWindow.length);
      return [inWindow.slice(from, to), to < inWindow.length ? { ...request, pageToken: String(to) } : null, {}];
    };
  },
}));

const { runIngest, stateDocId, LEGACY_STATE_DOC, LAST_RUN_DOC, MAX_WINDOWS_PER_RUN, MAX_READS_PER_RUN, MAX_ATTEMPTS_BEFORE_SPLIT, SETTINGS_UNUSABLE } =
  await import("./run.js");
const { aggregateErrors, MAX_ENTRIES_PER_RUN } = await import("./aggregate.js");
const { windowOf } = await import("./window.js");

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

const emptyResult = { entriesProcessed: 0, incidentsCreated: 0, incidentsUpdated: 0, incidentsRecurred: 0, incidentsReplayed: 0, errorsFoldedIntoOverflow: 0, capped: false };
const state = async () => (await db.collection(config.runCollection).doc(stateDocId(config)).get()).data();
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

  it("records how often runs are started, so the UI can say when the next is expected, and nothing when it can't tell", async () => {
    const aggregate = async () => emptyResult;
    config = { ...config, ingestSchedule: "*/5 * * * *" };
    await runIngest(db, loader(), now, { aggregate });
    expect((await lastRun())?.intervalMinutes).toBe(5);

    config = { ...config, ingestSchedule: "0,30 * * * *" };
    await runIngest(db, loader(), new Date(now.getTime() + 60_000), { aggregate });
    expect((await lastRun())?.intervalMinutes).toBeUndefined();
  });

  it("never completes a window past entries a capped read did not reach: the rest is read next (#127)", async () => {
    config = { ...config, defaultLookbackHours: 6 };
    const start = horizon.getTime() - 6 * HOUR;
    const entry = (t: number, message: string, fn = "api") => ({
      metadata: { timestamp: new Date(t).toISOString(), resource: { labels: { function_name: fn } } },
      data: message,
    });
    const BURST = MAX_ENTRIES_PER_RUN + 1000;
    logs.entries = [
      // Fired once, early: reading the newest MAX_ENTRIES_PER_RUN entries never saw it.
      entry(start + 10 * 60_000, "early failure", "billing"),
      ...Array.from({ length: BURST }, (_, i) => entry(start + HOUR + i * 2000, "burst failure")),
      entry(horizon.getTime() - 10 * 60_000, "late failure", "billing"),
    ];

    const result = await runIngest(db, loader(), now);

    expect(result).toMatchObject({ outcome: "ok", capped: false, totals: { entriesProcessed: BURST + 2, incidentsCreated: 3 } });
    const docs = (await db.collection(config.incidentCollection).get()).docs.map((d) => d.data());
    const count = (m: string) => docs.find((d) => d.errorMessage === m)?.occurrenceCount;
    expect(count("early failure")).toBe(1);
    expect(count("late failure")).toBe(1);
    // Every burst entry counted exactly once across the narrowed window and the one after it.
    expect(count("burst failure")).toBe(BURST);
    expect(ms((await state())?.checkpoint)).toBe(horizon.getTime());
    expect(await lastRun()).toMatchObject({ outcome: "ok", capped: false });
  });

  it("a burst of large entries narrows on the byte budget and still counts every entry once, end to end (#296)", async () => {
    config = { ...config, defaultLookbackHours: 6, ingestReadBudgetMb: 1 };
    const start = horizon.getTime() - 6 * HOUR;
    // 100 KB each (a long stack trace): about ten fit in the 1 MB budget, so the window is narrowed several times.
    const BURST = 40;
    logs.entries = Array.from({ length: BURST }, (_, i) => ({
      metadata: { timestamp: new Date(start + HOUR + i * 2000).toISOString(), resource: { labels: { function_name: "api" } } },
      data: { message: "upstream failed", stack: "x".repeat(100 * 1024) },
    }));

    const result = await runIngest(db, loader(), now);

    expect(result).toMatchObject({ outcome: "ok", capped: false, totals: { entriesProcessed: BURST, incidentsCreated: 1 } });
    const docs = (await db.collection(config.incidentCollection).get()).docs.map((d) => d.data());
    expect(docs).toHaveLength(1);
    expect(docs[0]?.occurrenceCount).toBe(BURST);
    expect(ms((await state())?.checkpoint)).toBe(horizon.getTime());
    expect(await lastRun()).toMatchObject({ outcome: "ok", capped: false, lagSeconds: 0 });
  });

  it("reports a read it could not narrow as capped, so its counts read as a floor", async () => {
    await runIngest(db, loader(), now, {
      aggregate: async () => ({ ...emptyResult, entriesProcessed: 5000, capped: true }),
    });
    expect(await lastRun()).toMatchObject({ outcome: "ok", capped: true, totals: { entriesProcessed: 20000 } });
  });

  it("records the Monitoring signal's counts, and a window whose read failed as unavailable, never as zero (#19)", async () => {
    let n = 0;
    await runIngest(db, loader(), now, {
      aggregate: async () => ({
        ...emptyResult,
        monitoring: n++ === 0
          ? { observations: 2, annotated: 1, monitoringOnly: 1, unavailable: false }
          : { observations: 0, annotated: 0, monitoringOnly: 0, unavailable: true },
      }),
    });
    expect((await lastRun())?.monitoring).toEqual({ observations: 2, annotated: 1, monitoringOnly: 1, unavailableWindows: 3 });

    // Off: nothing is recorded about it.
    await runIngest(db, loader(), new Date(now.getTime() + HOUR), { aggregate: async () => emptyResult });
    expect((await lastRun())?.monitoring).toBeUndefined();
  });

  it("a run that only narrowed its window is not idle, and the next run replays the narrowed window", async () => {
    config = { ...config, defaultLookbackHours: 2 };
    const seen: { id: string; start: number; end: number }[] = [];
    let clockMs = 0;
    const aggregate = async (_d: Firestore, _c: StarfishConfig, w: { id: string; start: Date; end: Date }) => {
      seen.push({ id: w.id, start: w.start.getTime(), end: w.end.getTime() });
      // Each read takes a tenth of the run budget: after eight, less than the share a new read needs is left.
      clockMs += 100;
      // Narrow on every read, to the first half: the run spends its whole budget narrowing.
      const half = new Date(w.start.getTime() + Math.floor((w.end.getTime() - w.start.getTime()) / 2));
      return { ...emptyResult, narrowedTo: windowOf(w.start, half) };
    };

    const first = await runIngest(db, loader(), now, { aggregate, runBudgetMs: 1000, clock: () => clockMs });

    expect(first).toMatchObject({ outcome: "ok", windows: 0, capped: false });
    // Narrowings are bounded by the run budget, not by MAX_WINDOWS_PER_RUN (#297).
    expect(seen).toHaveLength(8);
    // Each read was of the window the one before it narrowed to, never a fresh one.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toMatchObject({ start: seen[0]!.start, end: seen[i - 1]!.start + (seen[i - 1]!.end - seen[i - 1]!.start) / 2 });
    const pending = (await state())?.pending;
    expect(ms(pending.start)).toBe(seen[0]!.start);
    expect(ms(pending.end)).toBeLessThan(seen.at(-1)!.end);
    expect((await state())?.checkpoint).toBeUndefined();

    seen.length = 0;
    clockMs = 0;
    await runIngest(db, loader(), new Date(now.getTime() + HOUR), { aggregate, runBudgetMs: 1000, clock: () => clockMs });
    expect(seen[0]).toMatchObject({ start: ms(pending.start), end: ms(pending.end) });
  });

  it("does not count a narrowing against MAX_WINDOWS_PER_RUN: under a flood a run still completes that many windows (#297)", async () => {
    config = { ...config, defaultLookbackHours: 24 * 30 };
    const narrowedOnce = new Set<string>();
    let reads = 0;
    // Every planned window is narrowed once, to its first hour, then read in full: a sustained flood.
    const aggregate = async (_d: Firestore, _c: StarfishConfig, w: { id: string; start: Date; end: Date }) => {
      reads += 1;
      if (w.end.getTime() - w.start.getTime() > HOUR && !narrowedOnce.has(w.id)) {
        narrowedOnce.add(w.id);
        return { ...emptyResult, narrowedTo: windowOf(w.start, new Date(w.start.getTime() + HOUR)) };
      }
      return emptyResult;
    };

    const result = await runIngest(db, loader(), now, { aggregate });

    // Counting the narrowings too, the run stopped after four windows and the checkpoint fell further behind each run.
    expect(result).toMatchObject({ outcome: "ok", windows: MAX_WINDOWS_PER_RUN });
    expect(reads).toBe(2 * MAX_WINDOWS_PER_RUN);
  });

  it("stops at MAX_READS_PER_RUN when every read narrows and the budget never runs out (#297)", async () => {
    config = { ...config, defaultLookbackHours: 6 };
    let reads = 0;
    // A minute shorter each time: never too short to narrow within the backstop.
    const aggregate = async (_d: Firestore, _c: StarfishConfig, w: { start: Date; end: Date }) => {
      reads += 1;
      return { ...emptyResult, narrowedTo: windowOf(w.start, new Date(w.end.getTime() - 60_000)) };
    };

    const result = await runIngest(db, loader(), now, { aggregate, clock: () => 0 });

    expect(result).toMatchObject({ outcome: "ok", windows: 0 });
    expect(reads).toBe(MAX_READS_PER_RUN);
  });

  it("records how far the checkpoint is behind the newest readable logs: 0 caught up, more when stopped short, absent when unknown (#297)", async () => {
    config = { ...config, defaultLookbackHours: 24 * 30 };
    const aggregate = async () => emptyResult;

    await runIngest(db, loader(), now, { aggregate });
    // Eight 6-hour windows from a 30-day lookback: the checkpoint is 30 days less 48 hours behind the horizon.
    expect((await lastRun())?.lagSeconds).toBe((24 * 30 - 48) * 3600);
    expect(ms((await state())?.checkpoint)).toBe(horizon.getTime() - (24 * 30 - 48) * HOUR);

    // A failed window: the checkpoint did not move, and the lag says so.
    await runIngest(db, loader(), now, { aggregate: async () => { throw new Error("boom"); } });
    expect(await lastRun()).toMatchObject({ outcome: "failed", lagSeconds: (24 * 30 - 48) * 3600 });

    // Caught up: an idle run behind nothing.
    config = { ...config, runCollection: `${config.runCollection}_b`, defaultLookbackHours: 2 };
    await runIngest(db, loader(), now, { aggregate });
    expect((await lastRun())?.lagSeconds).toBe(0);
    await runIngest(db, loader(), now, { aggregate });
    expect(await lastRun()).toMatchObject({ outcome: "idle", lagSeconds: 0 });

    // A run that read nothing (state it can't trust): not known, so not recorded, never zero.
    await db.collection(config.runCollection).doc(stateDocId(config)).set({ target: { watchedProjectId: config.watchedProjectId, environment: config.environment }, checkpoint: "garbage" });
    await runIngest(db, loader(), now, { aggregate });
    const failed = await lastRun();
    expect(failed?.outcome).toBe("failed");
    expect(failed?.lagSeconds).toBeUndefined();
  });

  it("splits a pending window no attempt finishes, rather than replaying it unchanged forever (#296)", async () => {
    config = { ...config, defaultLookbackHours: 2 };
    const seen: { start: number; end: number }[] = [];
    // Dies on every window longer than half an hour, as a read too big for the job's memory would.
    const aggregate = async (_d: Firestore, _c: StarfishConfig, w: { start: Date; end: Date }) => {
      seen.push({ start: w.start.getTime(), end: w.end.getTime() });
      if (w.end.getTime() - w.start.getTime() > HOUR / 2) throw Object.assign(new Error("out of memory"), { code: "OOM" });
      return emptyResult;
    };

    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_SPLIT; i++) await runIngest(db, loader(), now, { aggregate });
    expect(new Set(seen.map((w) => `${w.start}..${w.end}`)).size).toBe(1);
    const whole = seen[0]!;
    expect((await state())?.pending.attempts).toBe(MAX_ATTEMPTS_BEFORE_SPLIT);

    // The next claim halves it, and the half is a prefix: nothing skipped, nothing read twice.
    seen.length = 0;
    await runIngest(db, loader(), now, { aggregate });
    expect(seen[0]).toEqual({ start: whole.start, end: whole.start + (whole.end - whole.start) / 2 });

    // Halved again after as many failures, it fits, and the windows after it cover the rest exactly.
    for (let i = 0; i < 2 * MAX_ATTEMPTS_BEFORE_SPLIT; i++) await runIngest(db, loader(), now, { aggregate });
    expect(seen.some((w) => w.end - w.start <= HOUR / 2 && w.start === whole.start)).toBe(true);
  });

  it("never splits a window an attempt already began writing: the half would count those writes again (#199, #296)", async () => {
    config = { ...config, defaultLookbackHours: 2 };
    const ids: string[] = [];
    const aggregate = async (_d: Firestore, _c: StarfishConfig, w: { id: string }, deps: AggregateDeps) => {
      ids.push(w.id);
      await deps.writes!.beginWrites();
      throw new Error("an upsert failed");
    };

    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_SPLIT + 2; i++) await runIngest(db, loader(), now, { aggregate });

    expect(new Set(ids).size).toBe(1);
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
    await db.collection(config.runCollection).doc(stateDocId(config)).set({
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

  it("gives up on a stalled window at the end of the run budget, not the window's own limit, and records it (#221)", async () => {
    // The window's own limit (10 min) would fire only after the task timeout killed the process: no last_run at all.
    const result = await runIngest(db, loader(), now, { aggregate: () => new Promise(() => {}), runBudgetMs: 50 });

    expect(result).toMatchObject({ outcome: "failed", error: "TimeoutError", windows: 0 });
    expect(await lastRun()).toMatchObject({ outcome: "failed", error: "TimeoutError" });
    expect((await state())?.pending).toBeDefined();
  });

  it("starts no new window once most of the run budget is spent, and the next run carries on (#221)", async () => {
    let clockMs = 0;
    const seen: { start: number; end: number }[] = [];
    // Each window takes 40% of the budget: after two, 20% is left, under the share a new window needs.
    const aggregate = async (_d: Firestore, _c: StarfishConfig, w: { start: Date; end: Date }) => {
      seen.push({ start: w.start.getTime(), end: w.end.getTime() });
      clockMs += 400;
      return emptyResult;
    };
    const deps = { aggregate, runBudgetMs: 1000, clock: () => clockMs };

    const first = await runIngest(db, loader(), now, deps);

    expect(first).toMatchObject({ outcome: "ok", windows: 2 });
    expect(ms((await state())?.checkpoint)).toBe(seen[1]!.end);
    expect((await state())?.pending).toBeUndefined();

    clockMs = 0;
    const second = await runIngest(db, loader(), now, deps);
    expect(second).toMatchObject({ outcome: "ok", windows: 2 });
    expect(seen[2]!.start).toBe(seen[1]!.end);
    expect(seen.at(-1)!.end).toBe(horizon.getTime());
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
    const stateRef = db.collection(config.runCollection).doc(stateDocId(config));
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

  // A log entry as the stubbed Logging serves it.
  const logEntry = (t: number, message: string, fn = "api") => ({
    metadata: { timestamp: new Date(t).toISOString(), resource: { labels: { function_name: fn } } },
    data: message,
  });
  const countOf = async (message: string, environment = config.environment) =>
    (await db.collection(config.incidentCollection).where("environment", "==", environment).get()).docs
      .filter((d) => d.get("errorMessage") === message)
      .map((d) => d.get("occurrenceCount") as number);

  it("switching to another target and back resumes from its own checkpoint, counting nothing twice (#198)", async () => {
    config = { ...config, defaultLookbackHours: 6 };
    logs.entries = [logEntry(horizon.getTime() - 3 * HOUR, "email send failed", "mailDrainer")];
    const prod = config;

    await runIngest(db, loader(), now);
    expect(await countOf("email send failed")).toEqual([1]);

    // An admin points the engine at another environment for a while, then back.
    config = { ...prod, environment: "staging" };
    await runIngest(db, loader(), now);
    config = prod;
    const back = await runIngest(db, loader(), new Date(now.getTime() + HOUR));

    // With one shared state document, the switch back re-read the lookback under new window ids: 2.
    expect(await countOf("email send failed")).toEqual([1]);
    expect(back.window?.start.getTime()).toBe(horizon.getTime());
    expect(ms((await state())?.checkpoint)).toBe(horizon.getTime() + HOUR);
  });

  it("keeps the checkpoint of a deployment from before per-target state, and moves it (#198)", async () => {
    const runs = db.collection(config.runCollection);
    const target = { watchedProjectId: config.watchedProjectId, environment: config.environment };
    await runs.doc(LEGACY_STATE_DOC).set({ target, checkpoint: Timestamp.fromDate(horizon) });
    const seen: number[] = [];

    await runIngest(db, loader(), new Date(now.getTime() + HOUR), {
      aggregate: async (_d, _c, w) => (seen.push(w.start.getTime()), emptyResult),
    });

    expect(seen).toEqual([horizon.getTime()]);
    expect(ms((await state())?.checkpoint)).toBe(horizon.getTime() + HOUR);
    expect((await runs.doc(LEGACY_STATE_DOC).get()).exists).toBe(false);
  });

  it("leaves a legacy state written for another target alone (#198)", async () => {
    const runs = db.collection(config.runCollection);
    const other = { watchedProjectId: config.watchedProjectId, environment: "staging" };
    await runs.doc(LEGACY_STATE_DOC).set({ target: other, checkpoint: Timestamp.fromDate(horizon) });
    const seen: number[] = [];

    await runIngest(db, loader(), now, { aggregate: async (_d, _c, w) => (seen.push(w.start.getTime()), emptyResult) });

    expect(seen[0]).toBe(horizon.getTime() - 24 * HOUR);
    expect((await runs.doc(LEGACY_STATE_DOC).get()).data()?.target).toEqual(other);
  });

  it("refuses to run on env defaults it fell back to because the settings could not be used (#198)", async () => {
    let called = false;
    const result = await runIngest(db, loader({ source: "env", problems: ["settings read failed: 14"], actionsAllowed: false }), now, {
      aggregate: async () => ((called = true), emptyResult),
    });

    expect(called).toBe(false);
    expect(result).toMatchObject({ outcome: "failed", error: SETTINGS_UNUSABLE, windows: 0 });
    expect(await lastRun()).toMatchObject({ outcome: "failed", error: SETTINGS_UNUSABLE, actionsAllowed: false, problems: ["settings read failed: 14"] });
    expect(await state()).toBeUndefined();
  });

  it("with the real loader: no settings document runs on the defaults, an invalid one with no last-good does not (#198)", async () => {
    const aggregate = async () => emptyResult;
    expect(await runIngest(db, new RuntimeConfigLoader(config), now, { aggregate })).toMatchObject({ outcome: "ok", actionsAllowed: true });

    await db.collection(config.settingsCollection).doc(SETTINGS_DOC).set({ version: 999 });
    const refused = await runIngest(db, new RuntimeConfigLoader(config), new Date(now.getTime() + HOUR), { aggregate });
    expect(refused).toMatchObject({ outcome: "failed", error: SETTINGS_UNUSABLE, actionsAllowed: false });
  });

  it("never narrows a window an earlier attempt already wrote: the capped read counts nothing twice (#199)", async () => {
    config = { ...config, defaultLookbackHours: 2 };
    const start = horizon.getTime() - 2 * HOUR;
    logs.entries = Array.from({ length: 10 }, (_, i) => logEntry(start + 10 * 60_000 + i, "early failure", "billing"));

    // The window commits its upserts, then the process dies before the checkpoint.
    const realThenCrash = async (d: Firestore, c: StarfishConfig, w: Parameters<typeof aggregateErrors>[2], deps: AggregateDeps) => {
      await aggregateErrors(d, c, w, deps);
      throw new Error("died before the checkpoint");
    };
    expect((await runIngest(db, loader(), now, { aggregate: realThenCrash })).outcome).toBe("failed");
    expect(await countOf("early failure")).toEqual([10]);

    // Late entries arrive in the same window: the retry's read now hits the cap.
    logs.entries.push(...Array.from({ length: MAX_ENTRIES_PER_RUN }, (_, i) => logEntry(start + HOUR + i * 100, "burst failure")));
    const retry = await runIngest(db, loader(), now);

    // Narrowed, the window got a new id and its first 10 entries were applied again under it: 20.
    expect(await countOf("early failure")).toEqual([10]);
    expect(retry).toMatchObject({ outcome: "ok", capped: true, totals: { incidentsReplayed: 1, incidentsCreated: 1 } });
    expect(await countOf("burst failure")).toEqual([MAX_ENTRIES_PER_RUN - 10]);
    expect(await lastRun()).toMatchObject({ capped: true });
  });

  it("never narrows a window pending in the legacy state: the code that wrote it never recorded its writes (#222)", async () => {
    config = { ...config, defaultLookbackHours: 2 };
    const start = horizon.getTime() - 2 * HOUR;
    const window = windowOf(new Date(start), horizon);
    logs.entries = Array.from({ length: 10 }, (_, i) => logEntry(start + 10 * 60_000 + i, "early failure", "billing"));
    // A deployment from before #198/#199 committed the window's upserts, then died before its checkpoint. Its single
    // state document holds the window as pending, with no `writesBegun`: that code never wrote one.
    await aggregateErrors(db, config, window);
    const target = { watchedProjectId: config.watchedProjectId, environment: config.environment };
    await db.collection(config.runCollection).doc(LEGACY_STATE_DOC).set({
      target,
      pending: { start: Timestamp.fromDate(window.start), end: Timestamp.fromDate(window.end) },
    });
    expect(await countOf("early failure")).toEqual([10]);

    // Late entries arrive in the same window: the retry's read now hits the cap.
    logs.entries.push(...Array.from({ length: MAX_ENTRIES_PER_RUN }, (_, i) => logEntry(start + HOUR + i * 100, "burst failure")));
    const retry = await runIngest(db, loader(), now);

    // Narrowed, the window got a new id and its first 10 entries were applied again under it: 20.
    expect(await countOf("early failure")).toEqual([10]);
    expect(retry).toMatchObject({ outcome: "ok", capped: true, totals: { incidentsReplayed: 1 } });
    expect(ms((await state())?.checkpoint)).toBe(horizon.getTime());
    expect((await db.collection(config.runCollection).doc(LEGACY_STATE_DOC).get()).exists).toBe(false);
  });

  it("does not narrow a window another attempt began writing, even on a read made before that (#199)", async () => {
    config = { ...config, defaultLookbackHours: 2 };
    const calls: { id: string; mayNarrow: boolean | undefined }[] = [];
    const aggregate = async (_d: Firestore, _c: StarfishConfig, w: { id: string; start: Date; end: Date }, deps: AggregateDeps) => {
      calls.push({ id: w.id, mayNarrow: deps.writes?.mayNarrow });
      if (calls.length > 1) return emptyResult;
      // An overlapping attempt reaches its writes while this read comes back capped.
      expect(await deps.writes!.beginWrites()).toBe(true);
      return { ...emptyResult, narrowedTo: windowOf(w.start, new Date(w.start.getTime() + HOUR)) };
    };

    await runIngest(db, loader(), now, { aggregate });

    expect(calls).toEqual([{ id: calls[0]!.id, mayNarrow: true }, { id: calls[0]!.id, mayNarrow: false }]);
    expect(ms((await state())?.checkpoint)).toBe(horizon.getTime());
  });

  it("writes nothing for a window that stopped being the pending one before its writes began (#199)", async () => {
    config = { ...config, defaultLookbackHours: 2 };
    const stateRef = db.collection(config.runCollection).doc(stateDocId(config));
    const target = { watchedProjectId: config.watchedProjectId, environment: config.environment };
    const seen: { start: number; end: number; began: boolean }[] = [];
    const result = await runIngest(db, loader(), now, {
      aggregate: async (_d, _c, w, deps) => {
        // Another run narrowed this window meanwhile (the first time only).
        if (seen.length === 0) {
          await stateRef.set({ target, pending: { start: Timestamp.fromDate(w.start), end: Timestamp.fromDate(new Date(w.start.getTime() + HOUR)) } });
        }
        const began = await deps.writes!.beginWrites();
        seen.push({ start: w.start.getTime(), end: w.end.getTime(), began });
        return began ? emptyResult : { ...emptyResult, superseded: true as const };
      },
    });

    const start = horizon.getTime() - 2 * HOUR;
    expect(seen).toEqual([
      { start, end: horizon.getTime(), began: false },
      // The superseded window was neither counted nor completed: the narrowed one is claimed next, then the rest.
      { start, end: start + HOUR, began: true },
      { start: start + HOUR, end: horizon.getTime(), began: true },
    ]);
    expect(result.windows).toBe(2);
    expect(ms((await state())?.checkpoint)).toBe(horizon.getTime());
  });
});
