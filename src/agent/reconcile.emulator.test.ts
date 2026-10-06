/**
 * Reconciling opened pull requests against the Firestore emulator, with a fake GitHub client: which cycles are read,
 * what is recorded, and that nothing but `summary.prState` changes. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { GithubError, type CheckRun, type PullRequestState } from "../integrations/githubPr.js";
import { MAX_SCAN, reconcilePullRequests, selectPrCycles, type PrReader, type ReconcileConfig } from "./reconcile.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("reconcile.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "reconcile-emulator-tests");
const db: Firestore = getFirestore(app, "reconcile-tests");
afterAll(() => deleteApp(app));

const t0 = new Date("2026-10-06T12:00:00.000Z");
const SHA = "c".repeat(40);
let cfg: ReconcileConfig;
beforeEach(() => {
  cfg = {
    cycleCollection: `cycles_${randomUUID().slice(0, 8)}`,
    leaseSeconds: 300,
    cycleDeadlineMinutes: 60,
    maxCycleAttempts: 3,
    environment: "demo",
    verifyChecks: ["verify"],
    maxPrChecksPerPass: 10,
  };
});

/** A finished cycle as the loop leaves it, written directly: `n` is the PR number, or null for a cycle that opened none. */
async function seed(id: string, n: number | null, over: Record<string, unknown> = {}, minutesAgo = 1) {
  const updated = Timestamp.fromMillis(t0.getTime() - minutesAgo * 60_000);
  await db
    .collection(cfg.cycleCollection)
    .doc(id)
    .set({
      incidentId: id.split("_")[0],
      environment: "demo",
      recurrence: 0,
      state: "done",
      path: n === null ? "draft" : "pr",
      outcome: "pr-opened",
      createdAt: updated,
      updatedAt: updated,
      summary: n === null ? { pr: { opened: false, reason: "dry-run" } } : { pr: { opened: true, number: n, url: `https://github.com/acme/shop/pull/${n}` } },
      ...over,
    });
}
const doc = async (id: string) => (await db.collection(cfg.cycleCollection).doc(id).get()).data()!;

function fakeGithub(prs: Record<number, Partial<PullRequestState> | Error>, checks: CheckRun[] = []) {
  const reads: Array<[string, number]> = [];
  const client: PrReader = {
    readPullRequest: async (cycleId, number) => {
      reads.push([cycleId, number]);
      const pr = prs[number];
      if (pr instanceof Error) throw pr;
      return { number, state: "open", mergedAt: null, closedAt: null, headSha: SHA, ...pr };
    },
    listCheckRuns: async () => checks,
  };
  return { client, reads };
}
const success: CheckRun = { id: 1, name: "verify", status: "completed", conclusion: "success", url: "", title: "", summary: "" };

describe("selectPrCycles", () => {
  it("picks finished cycles that opened a PR, never checked first, then least recently checked, at most the limit", async () => {
    await seed("a_r0", 1, { summary: { pr: { opened: true, number: 1 }, prState: { state: "open", checks: "pending", checkedAt: "2026-10-06T11:00:00.000Z" } } });
    await seed("b_r0", 2);
    await seed("c_r0", 3, { summary: { pr: { opened: true, number: 3 }, prState: { state: "open", checks: "pending", checkedAt: "2026-10-06T10:00:00.000Z" } } });
    await seed("d_r0", null);
    await seed("e_r0", 5, { state: "running" });
    await seed("f_r0", 6, { environment: "prod" });
    expect(await selectPrCycles(db, cfg, 10)).toEqual([
      { cycleId: "b_r0", number: 2 },
      { cycleId: "c_r0", number: 3 },
      { cycleId: "a_r0", number: 1 },
    ]);
    expect(await selectPrCycles(db, cfg, 1)).toEqual([{ cycleId: "b_r0", number: 2 }]);
    expect(await selectPrCycles(db, cfg, 0)).toEqual([]);
  });

  it("leaves a merged PR whose checks are settled alone, and keeps reading a merged one whose checks are not", async () => {
    await seed("a_r0", 1, { summary: { pr: { opened: true, number: 1 }, prState: { state: "merged", checks: "passed", checkedAt: "2026-10-06T11:00:00.000Z" } } });
    await seed("b_r0", 2, { summary: { pr: { opened: true, number: 2 }, prState: { state: "merged", checks: "pending", checkedAt: "2026-10-06T11:00:00.000Z" } } });
    await seed("c_r0", 3, { summary: { pr: { opened: true, number: 3 }, prState: { state: "closed", checks: "failed", checkedAt: "2026-10-06T11:00:00.000Z" } } });
    expect((await selectPrCycles(db, cfg, 10)).map((c) => c.cycleId).sort()).toEqual(["b_r0", "c_r0"]);
  });

  it("looks only at the newest cycles, a bounded read", async () => {
    await seed("old_r0", 1, {}, 60 * 24);
    const batch = db.batch();
    for (let i = 0; i < MAX_SCAN; i++) {
      const ts = Timestamp.fromMillis(t0.getTime() - i * 1000);
      batch.set(db.collection(cfg.cycleCollection).doc(`n${i}_r0`), { environment: "demo", state: "declined", createdAt: ts, updatedAt: ts });
    }
    await batch.commit();
    expect(await selectPrCycles(db, cfg, 10)).toEqual([]);
  });
});

describe("reconcilePullRequests", () => {
  it("records what GitHub says on each cycle, and changes nothing else: not the cycle's outcome, not its updatedAt", async () => {
    await seed("a_r0", 1);
    await seed("b_r0", 2);
    const before = await doc("a_r0");
    const gh = fakeGithub({ 1: { state: "merged", mergedAt: "2026-10-06T11:30:00.000Z" }, 2: {} }, [success]);
    const r = await reconcilePullRequests({ db, config: cfg, client: gh.client, now: () => t0 });
    expect(r).toEqual({ considered: 2, recorded: 2, unchanged: 0, errors: [] });
    const a = await doc("a_r0");
    expect(a.summary.prState).toEqual({
      number: 1,
      state: "merged",
      mergedAt: "2026-10-06T11:30:00.000Z",
      closedAt: null,
      headSha: SHA,
      checks: "passed",
      checksPassed: 1,
      checksRequired: 1,
      checkedAt: t0.toISOString(),
    });
    for (const k of ["state", "path", "outcome", "updatedAt", "incidentId"]) expect(a[k], k).toEqual(before[k]);
    expect((await doc("b_r0")).summary.prState).toMatchObject({ state: "open", checks: "passed" });
  });

  it("reads at most the configured number a pass", async () => {
    for (let i = 1; i <= 5; i++) await seed(`i${i}_r0`, i);
    const gh = fakeGithub({ 1: {}, 2: {}, 3: {}, 4: {}, 5: {} });
    const r = await reconcilePullRequests({ db, config: { ...cfg, maxPrChecksPerPass: 2 }, client: gh.client, now: () => t0 });
    expect(r.considered).toBe(2);
    expect(gh.reads).toHaveLength(2);
  });

  it("does not undo a merge a later pass reads as open (a stale replica), and says it left it unchanged", async () => {
    await seed("a_r0", 1);
    await reconcilePullRequests({ db, config: cfg, client: fakeGithub({ 1: { state: "merged", mergedAt: "2026-10-06T11:30:00.000Z" } }).client, now: () => t0 });
    const r = await reconcilePullRequests({ db, config: cfg, client: fakeGithub({ 1: { state: "open" } }).client, now: () => new Date(t0.getTime() + 60_000) });
    expect(r).toMatchObject({ recorded: 0, unchanged: 1 });
    expect((await doc("a_r0")).summary.prState.state).toBe("merged");
  });

  it("keeps one PR's failure to itself, and stops at an error every other PR would hit too", async () => {
    await seed("a_r0", 1, {}, 3);
    await seed("b_r0", 2, {}, 2);
    await seed("c_r0", 3, {}, 1);
    const gone = fakeGithub({ 1: new GithubError("not-found", "gone"), 2: {}, 3: {} });
    const r = await reconcilePullRequests({ db, config: cfg, client: gone.client, now: () => t0 });
    expect(r.recorded).toBe(2);
    expect(r.errors).toEqual([{ cycleId: "a_r0", message: "GithubError: gone" }]);

    const limited = fakeGithub({ 1: new GithubError("rate-limited", "slow down"), 2: {}, 3: {} });
    const r2 = await reconcilePullRequests({ db, config: { ...cfg, cycleCollection: cfg.cycleCollection }, client: limited.client, now: () => new Date(t0.getTime() + 1000) });
    expect(r2.stoppedBecause).toBe("rate-limited");
    expect(limited.reads).toHaveLength(1);
  });

  it("asks for no check runs when none is named, and records that as not-configured", async () => {
    await seed("a_r0", 1);
    let asked = 0;
    const client: PrReader = { ...fakeGithub({ 1: {} }).client, listCheckRuns: async () => (asked++, []) };
    await reconcilePullRequests({ db, config: { ...cfg, verifyChecks: [] }, client, now: () => t0 });
    expect(asked).toBe(0);
    expect((await doc("a_r0")).summary.prState).toMatchObject({ checks: "not-configured", checksRequired: 0 });
  });
});
