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
import { PUBLIC_VIEW_OFF } from "../testConfig.js";
import { linkIncident } from "./incidentLinks.js";

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
    incidentCollection: `incidents_${randomUUID().slice(0, 8)}`,
    leaseSeconds: 300,
    cycleDeadlineMinutes: 60,
    maxCycleAttempts: 3,
    environment: "demo",
    verifyCheckApp: "github-actions",
    verifyChecks: ["verify"],
    maxPrChecksPerPass: 10,
    ...PUBLIC_VIEW_OFF,
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
const success: CheckRun = { id: 1, name: "verify", status: "completed", conclusion: "success", url: "", app: "github-actions", title: "", summary: "" };

describe("selectPrCycles", () => {
  it("picks finished cycles that opened a PR, never checked first, then least recently checked, at most the limit", async () => {
    await seed("a_r0", 1, { summary: { pr: { opened: true, number: 1 }, prState: { state: "open", checks: "pending", checkedAt: "2026-10-06T11:00:00.000Z" } } });
    await seed("b_r0", 2);
    await seed("c_r0", 3, { summary: { pr: { opened: true, number: 3 }, prState: { state: "open", checks: "pending", checkedAt: "2026-10-06T10:00:00.000Z" } } });
    await seed("d_r0", null);
    await seed("e_r0", 5, { state: "running" });
    await seed("f_r0", 6, { environment: "prod" });
    expect(await selectPrCycles(db, cfg, 10)).toEqual([
      { cycleId: "b_r0", number: 2, key: { incidentId: "b", environment: "demo", recurrence: 0 }, url: "https://github.com/acme/shop/pull/2" },
      { cycleId: "c_r0", number: 3, key: { incidentId: "c", environment: "demo", recurrence: 0 } },
      { cycleId: "a_r0", number: 1, key: { incidentId: "a", environment: "demo", recurrence: 0 } },
    ]);
    expect((await selectPrCycles(db, cfg, 1)).map(({ cycleId, number }) => ({ cycleId, number }))).toEqual([{ cycleId: "b_r0", number: 2 }]);
    expect(await selectPrCycles(db, cfg, 0)).toEqual([]);
  });

  it("never picks a seeded synthetic cycle: the pull request it names does not exist (#192)", async () => {
    await seed("synthetic-demo-x_r0", 103, { synthetic: true });
    await seed("b_r0", 2);
    expect((await selectPrCycles(db, cfg, 10)).map(({ cycleId, number }) => ({ cycleId, number }))).toEqual([{ cycleId: "b_r0", number: 2 }]);
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

  it("copies the PR's state onto the incident's link (#194), only for the same PR and recurrence, and keeps a status that is not new", async () => {
    const incidents = db.collection(cfg.incidentCollection);
    await incidents.doc("a").set({ environment: "demo", status: "logged", githubPrNumber: 1, githubPrState: "open" });
    await incidents.doc("b").set({ environment: "demo", status: "recurred", recurrenceCount: 1, githubPrNumber: 2, githubPrState: "open" });
    await incidents.doc("c").set({ environment: "demo", status: "new", githubPrNumber: 99 });
    await seed("a_r0", 1);
    await seed("b_r0", 2);
    await seed("c_r0", 3);
    const gh = fakeGithub({ 1: { state: "merged", mergedAt: "2026-10-06T11:30:00.000Z" }, 2: { state: "closed" }, 3: { state: "closed" } });
    expect(await reconcilePullRequests({ db, config: cfg, client: gh.client, now: () => t0 })).toMatchObject({ recorded: 3, errors: [] });
    expect((await incidents.doc("a").get()).data()).toEqual({
      environment: "demo",
      status: "logged",
      githubPrNumber: 1,
      githubPrUrl: "https://github.com/acme/shop/pull/1",
      githubPrState: "merged",
    });
    expect((await incidents.doc("b").get()).data()!.githubPrState).toBe("open"); // a later recurrence: not this cycle's
    expect((await incidents.doc("c").get()).data()).not.toHaveProperty("githubPrState"); // another PR's link
  });

  it("repairs an incident link whose first copy failed, on a read that changes nothing (#194)", async () => {
    const incidents = db.collection(cfg.incidentCollection);
    await incidents.doc("a").set({ environment: "demo", status: "new" });
    await seed("a_r0", 1, { summary: { pr: { opened: true, number: 1, url: "https://github.com/acme/shop/pull/1" }, prState: { state: "open", checks: "pending", checkedAt: "2026-10-06T11:00:00.000Z" } } });
    const gh = fakeGithub({ 1: { state: "open" } });
    await reconcilePullRequests({ db, config: { ...cfg, verifyChecks: [] }, client: gh.client, now: () => t0 });
    expect((await incidents.doc("a").get()).data()).toMatchObject({ githubPrNumber: 1, githubPrUrl: "https://github.com/acme/shop/pull/1", githubPrState: "open", status: "logged", statusChangedBy: "starfish" });
  });

  it("an issue filed or a PR opened makes a new incident logged, and leaves every other status as it is", async () => {
    const incidents = db.collection(cfg.incidentCollection);
    const key = (incidentId: string) => ({ incidentId, environment: "demo", recurrence: 0 });
    const statuses = ["new", "acknowledged", "logged", "recurred", "resolved", "ignored"] as const;
    for (const status of statuses) await incidents.doc(status).set({ environment: "demo", status, statusChangedBy: "op1" });
    for (const status of statuses) {
      expect(await linkIncident(db, cfg, key(status), { kind: "issue", number: 5, url: "https://github.com/acme/shop/issues/5" })).toBe(true);
    }
    expect((await incidents.doc("new").get()).data()).toMatchObject({ status: "logged", statusChangedBy: "starfish", githubIssueNumber: 5 });
    expect((await incidents.doc("new").get()).data()!.updatedAt).toBeInstanceOf(Timestamp);
    for (const status of statuses.filter((s) => s !== "new")) {
      expect((await incidents.doc(status).get()).data()).toMatchObject({ status, statusChangedBy: "op1", githubIssueNumber: 5 });
    }
    // A PR opened does the same, when no issue was filed first.
    await incidents.doc("p").set({ environment: "demo", status: "new" });
    expect(await linkIncident(db, cfg, key("p"), { kind: "pr", number: 7, url: "https://github.com/acme/shop/pull/7" })).toBe(true);
    expect((await incidents.doc("p").get()).data()).toMatchObject({ status: "logged", githubPrNumber: 7, githubPrState: "open" });
    // Never on another recurrence's incident, nor a retired one.
    await incidents.doc("r").set({ environment: "demo", status: "new", recurrenceCount: 1 });
    expect(await linkIncident(db, cfg, key("r"), { kind: "issue", number: 5, url: "https://github.com/acme/shop/issues/5" })).toBe(false);
    expect((await incidents.doc("r").get()).data()!.status).toBe("new");
    await incidents.doc("x").set({ environment: "demo", status: "new", retired: true });
    await linkIncident(db, cfg, key("x"), { kind: "issue", number: 5, url: "https://github.com/acme/shop/issues/5" });
    expect((await incidents.doc("x").get()).data()!.status).toBe("new");
  });
});
