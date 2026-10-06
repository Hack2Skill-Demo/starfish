/**
 * The auto-merge step and the fast-revert watch (#9) against the Firestore emulator, with a fake GitHub client that
 * records every call. What is proven here: nothing merges unless every switch and gate allows it, the evidence is
 * posted before the merge, the head merged is the head verified, the daily cap holds, a revert opens and merges only
 * on a recurrence, and a revert is never reverted. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { GithubError, type CheckRun, type PullRequestState, type RevertRequest } from "../integrations/githubPr.js";
import type { NotifyRequest } from "../integrations/slack.js";
import { testConfig } from "../testConfig.js";
import type { IncidentStatus } from "../types.js";
import { runAutoMergeStep, type AutoMergeDeps, type MergeClient } from "./autoMerge.js";
import { runFastRevertStep, WATCH_SETTLE_MS, type FastRevertDeps, type RevertClient } from "./fastRevert.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("autoMerge.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "automerge-emulator-tests");
const db: Firestore = getFirestore(app, "automerge-tests");
afterAll(() => deleteApp(app));

const P = "a".repeat(64);
const HEAD = "b".repeat(40);
const MERGED = "e".repeat(40);
const REVERT_HEAD = "f".repeat(40);
const t0 = new Date("2026-10-06T12:00:00.000Z");

let cfg: ReturnType<typeof testConfig>;
let clock: Date;
let blocked: (string | null)[];
let status: IncidentStatus | null;
let told: NotifyRequest[];
beforeEach(() => {
  const run = randomUUID().slice(0, 8);
  cfg = testConfig({
    environment: "demo",
    cycleCollection: `cycles_${run}`,
    incidentCollection: `incidents_${run}`,
    runCollection: `runs_${run}`,
    verifyChecks: ["verify"],
    githubRepo: "acme/demo-shop",
    dryRun: false,
    autoMerge: true,
    autoMergeTargets: ["acme/demo-shop"],
  });
  clock = new Date(t0);
  blocked = [null];
  status = "new";
  told = [];
});

function proven(over: Record<string, Record<string, unknown>> = {}): Record<string, Record<string, unknown>> {
  const base: Record<string, Record<string, unknown>> = {
    triage: { decision: "act", rule: "model-act", counterCount: 42, counterWindow: "24h" },
    fix: { outcome: "proposed", rule: "fixer-proposed", testAdded: true, rootCause: "couponCode is written as undefined." },
    before: { status: "failed", rule: "command-failed", patchSha256: "c".repeat(64), forPatchSha256: P },
    verify: { status: "passed", rule: "command-passed", patchSha256: P, baseRevision: "1".repeat(40) },
    review: { verdict: "approve", rule: "reviewed", held: 3, flagged: 0, broken: 0, patchSha256: P },
    pr: { opened: true, number: 7, url: "https://github.com/acme/demo-shop/pull/7", patchSha256: P },
    merge: {
      state: "pending",
      number: 7,
      patchSha256: P,
      headSha: HEAD,
      gate1: "pass",
      fixClass: "firestore-undefined-field",
      sourceFile: "functions/src/orders/createOrder.ts",
      causeFrame: true,
      pendingSince: t0.toISOString(),
    },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
  return base;
}

async function seed(id: string, summary: Record<string, unknown> = proven(), over: Record<string, unknown> = {}) {
  const incidentId = id.split("_")[0]!;
  await db.collection(cfg.cycleCollection).doc(id).set({
    incidentId,
    environment: "demo",
    recurrence: 0,
    state: "done",
    path: "pr",
    outcome: "pr-opened",
    updatedAt: Timestamp.fromDate(t0),
    summary,
    ...over,
  });
  await db.collection(cfg.incidentCollection).doc(incidentId).set({ functionName: "orders-createOrder", service: "orders", errorType: "DatabaseError", occurrenceCount: 42, status: "new", lastOccurredAt: Timestamp.fromMillis(t0.getTime() - 3_600_000) }, { merge: true });
}
const cycle = async (id: string) => (await db.collection(cfg.cycleCollection).doc(id).get()).data()!;

const success: CheckRun = { id: 11, name: "verify", status: "completed", conclusion: "success", url: "https://github.com/acme/demo-shop/actions/runs/1", title: "", summary: "" };

function fakeGithub(
  opts: { pr?: Partial<PullRequestState>; checks?: CheckRun[]; mergeError?: Error; commentError?: Error; revertError?: Error; revertPr?: Partial<PullRequestState>; changed?: string[] | Error } = {}
) {
  const calls: string[] = [];
  const merges: { id: string; number: number; sha: string }[] = [];
  const reverts: RevertRequest[] = [];
  const client: MergeClient & RevertClient = {
    readPullRequest: async (id, number) => {
      calls.push(`read ${id} #${number}`);
      const base = id.startsWith("revert-") ? { headSha: REVERT_HEAD, ...opts.revertPr } : { headSha: HEAD, ...opts.pr };
      return { number, state: "open", mergedAt: null, closedAt: null, ...base } as PullRequestState;
    },
    listCheckRuns: async (sha) => {
      calls.push(`checks ${sha.slice(0, 4)}`);
      return opts.checks ?? [success];
    },
    filesChangedSince: async (rev) => {
      calls.push(`compare ${rev.slice(0, 4)}`);
      if (opts.changed instanceof Error) throw opts.changed;
      return opts.changed ?? [];
    },
    commentOnPullRequest: async (id, number) => {
      calls.push(`comment ${id} #${number}`);
      if (opts.commentError) throw opts.commentError;
    },
    mergePullRequest: async (id, number, sha) => {
      calls.push(`merge ${id} #${number}`);
      if (opts.mergeError) throw opts.mergeError;
      merges.push({ id, number, sha });
      return { sha: id.startsWith("revert-") ? "9".repeat(40) : MERGED };
    },
    openRevertPullRequest: async (req) => {
      calls.push(`revert ${req.cycleId}`);
      if (opts.revertError) throw opts.revertError;
      reverts.push(req);
      return { number: 8, url: "https://github.com/acme/demo-shop/pull/8", headSha: REVERT_HEAD };
    },
  };
  return { client, calls, merges, reverts };
}

function mergeDeps(client: MergeClient, over: Partial<AutoMergeDeps> = {}): AutoMergeDeps {
  return {
    db,
    config: cfg,
    client,
    now: () => clock,
    owner: "worker-a",
    blockedBy: async () => (blocked.length > 1 ? blocked.shift()! : blocked[0]!),
    incidentStatus: async () => status,
    notify: async (req) => {
      told.push(req);
      return { state: "sent", attempts: 1 };
    },
    ...over,
  };
}
const revertDeps = (client: RevertClient, over: Partial<FastRevertDeps> = {}): FastRevertDeps => {
  const m = mergeDeps(client as unknown as MergeClient);
  return { db, config: cfg, client, now: m.now, owner: m.owner, blockedBy: m.blockedBy, notify: m.notify!, ...over };
};

describe("runAutoMergeStep: merges only what every switch and gate allows", () => {
  it("posts the evidence, then squash-merges the exact verified head, and starts the fast-revert watch", async () => {
    await seed("inc1_r0");
    const gh = fakeGithub();
    const r = await runAutoMergeStep(mergeDeps(gh.client));
    expect(r).toMatchObject({ considered: 1, merged: 1, skipped: 0 });
    expect(gh.calls.indexOf("comment inc1_r0 #7")).toBeLessThan(gh.calls.indexOf("merge inc1_r0 #7"));
    expect(gh.merges).toEqual([{ id: "inc1_r0", number: 7, sha: HEAD }]);
    const s = (await cycle("inc1_r0")).summary;
    expect(s.merge).toMatchObject({ state: "merged", mergeSha: MERGED, headSha: HEAD, claimedBy: "worker-a" });
    expect(s.revert).toMatchObject({ state: "watching", mergeSha: MERGED, until: new Date(t0.getTime() + 60 * 60_000).toISOString() });
    expect(told).toEqual([]);
    // Settled: a second pass does nothing more.
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ considered: 0 });
    expect(gh.merges).toHaveLength(1);
  });

  it.each(["auto-merge-off", "target-not-allowed", "merge-freeze", "dry-run", "settings-unusable"])(
    "never merges with the switch %s: the PR stays open and a person is told",
    async (why) => {
      blocked = [why];
      await seed("inc1_r0");
      const gh = fakeGithub();
      const r = await runAutoMergeStep(mergeDeps(gh.client));
      expect(r).toMatchObject({ merged: 0, skipped: 1 });
      expect(gh.calls.filter((c) => c.startsWith("merge") || c.startsWith("comment"))).toEqual([]);
      expect((await cycle("inc1_r0")).summary.merge).toMatchObject({ state: "skipped", reason: `switch:${why}`, escalation: "sent" });
      expect(told[0]).toMatchObject({ path: "human", rule: "auto-merge-switch" });
    }
  );

  it("pauses while automation is off: nothing read, nothing decided", async () => {
    blocked = ["automation-disabled"];
    await seed("inc1_r0");
    const gh = fakeGithub();
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ paused: true, considered: 0 });
    expect(gh.calls).toEqual([]);
    expect((await cycle("inc1_r0")).summary.merge.state).toBe("pending");
  });

  it("never touches a cycle with no auto-merge candidate (a target where it is off opened a plain PR)", async () => {
    const summary = proven();
    delete summary.merge;
    await seed("inc1_r0", summary);
    const gh = fakeGithub();
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ considered: 0 });
    expect(gh.calls).toEqual([]);
  });

  it.each([
    ["the counter-check counted nothing", { triage: { counterCount: 0 } }, "gate2:counter-check"],
    ["the test did not fail before the fix", { before: { status: "passed", rule: "command-passed" } }, "gate2:fails-before"],
    ["the review flagged something", { review: { flagged: 1 } }, "gate2:review-approve"],
    ["gate 1 did not pass", { merge: { gate1: "fail" } }, "gate1:not-recorded"],
  ])("never merges on almost: %s", async (_name, over, reason) => {
    await seed("inc1_r0", proven(over as Record<string, Record<string, unknown>>));
    const gh = fakeGithub();
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc1_r0")).summary.merge).toMatchObject({ state: "skipped", reason, escalation: "sent" });
  });

  it("waits for checks still running, then hands the PR to a person when they take too long", async () => {
    await seed("inc1_r0");
    const gh = fakeGithub({ checks: [{ ...success, status: "in_progress", conclusion: null }] });
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ waiting: 1 });
    expect((await cycle("inc1_r0")).summary.merge.state).toBe("pending");
    clock = new Date(t0.getTime() + 121 * 60_000);
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ skipped: 1 });
    expect((await cycle("inc1_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "checks-timeout" });
    expect(gh.merges).toEqual([]);
  });

  it.each([
    ["a failed required check", { checks: [{ ...success, conclusion: "failure" }] }, "checks-failed"],
    ["a required check never reported, past the wait", { checks: [] }, "checks-timeout"],
    ["a head that moved since it was verified", { pr: { headSha: "d".repeat(40) } }, "head-changed"],
  ])("refuses %s", async (_name, gh0, reason) => {
    if (reason === "checks-timeout") clock = new Date(t0.getTime() + 121 * 60_000);
    await seed("inc1_r0");
    const gh = fakeGithub(gh0);
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc1_r0")).summary.merge).toMatchObject({ state: "skipped", reason });
  });

  it("refuses when the base branch changed the fixed file after the fix was verified, or that cannot be told", async () => {
    await seed("a_r0");
    await runAutoMergeStep(mergeDeps(fakeGithub({ changed: ["README.md", "functions/src/orders/createOrder.ts"] }).client));
    expect((await cycle("a_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "base-changed-same-file" });
    await seed("b_r0");
    await runAutoMergeStep(mergeDeps(fakeGithub({ changed: new GithubError("unexpected-response", "too many") }).client));
    expect((await cycle("b_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "base-unknown" });
    await seed("c_r0", proven({ verify: { baseRevision: null } }));
    await runAutoMergeStep(mergeDeps(fakeGithub().client));
    expect((await cycle("c_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "base-unknown" });
  });

  it("merges over unrelated later changes on the base branch", async () => {
    await seed("inc1_r0");
    const gh = fakeGithub({ changed: ["README.md", "functions/src/other.ts"] });
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ merged: 1 });
  });

  it("refuses with no required check named: nothing would prove the head green", async () => {
    cfg = { ...cfg, verifyChecks: [] };
    await seed("inc1_r0");
    const gh = fakeGithub();
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc1_r0")).summary.merge.reason).toBe("no-required-checks");
  });

  it("leaves a PR a person closed or merged, and an incident a person resolved, without telling anyone", async () => {
    await seed("a_r0");
    status = "resolved";
    await runAutoMergeStep(mergeDeps(fakeGithub().client));
    expect((await cycle("a_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "incident-resolved", escalation: "none" });
    status = "new";
    await seed("b_r0");
    await runAutoMergeStep(mergeDeps(fakeGithub({ pr: { state: "closed" } }).client));
    expect((await cycle("b_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "pr-closed", escalation: "none" });
    expect(told).toEqual([]);
  });

  it("holds the daily cap across candidates: the one over it goes to a person", async () => {
    cfg = { ...cfg, maxMergesPerDay: 1 };
    await seed("a_r0");
    await seed("b_r0");
    const gh = fakeGithub();
    const r = await runAutoMergeStep(mergeDeps(gh.client));
    expect(r).toMatchObject({ merged: 1, skipped: 1 });
    expect(gh.merges).toHaveLength(1);
    const states = [(await cycle("a_r0")).summary.merge, (await cycle("b_r0")).summary.merge];
    expect(states.map((m) => m.state).sort()).toEqual(["merged", "skipped"]);
    expect(states.find((m) => m.state === "skipped")).toMatchObject({ reason: "daily-merge-cap" });
  });

  it("re-checks the switches right before merging: an admin who just froze merging wins", async () => {
    blocked = [null, null, "merge-freeze"];
    await seed("inc1_r0");
    const gh = fakeGithub();
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(gh.calls.filter((c) => c.startsWith("merge") || c.startsWith("comment"))).toEqual([]);
    expect((await cycle("inc1_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "switch:merge-freeze" });
  });

  it("never merges without its evidence posted", async () => {
    await seed("inc1_r0");
    const gh = fakeGithub({ commentError: new GithubError("server-error", "down") });
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc1_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "evidence-not-posted" });
  });

  it("records GitHub's refusal and leaves the PR to a person", async () => {
    await seed("inc1_r0");
    await runAutoMergeStep(mergeDeps(fakeGithub({ mergeError: new GithubError("head-changed", "moved") }).client));
    expect((await cycle("inc1_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "merge-refused:head-changed", escalation: "sent" });
  });

  it("never retries an interrupted merge blindly: a merged PR is recorded, anything else goes to a person", async () => {
    const stale = new Date(t0.getTime() - 20 * 60_000).toISOString();
    await seed("a_r0", proven({ merge: { state: "merging", claimedAt: stale, claimedBy: "gone" } }));
    const merged = fakeGithub({ pr: { state: "merged", mergedAt: t0.toISOString(), mergeCommitSha: MERGED } });
    await runAutoMergeStep(mergeDeps(merged.client));
    expect((await cycle("a_r0")).summary.merge).toMatchObject({ state: "merged", mergeSha: MERGED });
    expect((await cycle("a_r0")).summary.revert).toMatchObject({ state: "watching", mergeSha: MERGED });
    expect(merged.merges).toEqual([]);
    // b: read back as still open.
    await seed("b_r0", proven({ merge: { state: "merging", claimedAt: stale, claimedBy: "gone" } }));
    const open = fakeGithub();
    await runAutoMergeStep(mergeDeps(open.client));
    expect(open.merges).toEqual([]);
    expect((await cycle("b_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "interrupted" });
  });

  it("lets only one of two racing passes merge a candidate", async () => {
    await seed("inc1_r0");
    const gh = fakeGithub();
    const [a, b] = await Promise.all([runAutoMergeStep(mergeDeps(gh.client, { owner: "a" })), runAutoMergeStep(mergeDeps(gh.client, { owner: "b" }))]);
    expect(a.merged + b.merged).toBe(1);
    expect(gh.merges).toHaveLength(1);
  });

  it("does not try again on an incident where Starfish already reverted one of its merges", async () => {
    await seed("inc1_r0", proven({ merge: { state: "merged" }, revert: { state: "reverted", mergeSha: MERGED } }));
    await seed("inc1_r1", proven(), { recurrence: 1 });
    const gh = fakeGithub();
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc1_r1")).summary.merge).toMatchObject({ state: "skipped", reason: "incident-reverted-before", escalation: "sent" });
  });
});

describe("runFastRevertStep: reverts Starfish's own merge when the incident comes back", () => {
  const watching = (mergedAt = t0) =>
    proven({
      merge: { state: "merged", mergeSha: MERGED, mergedAt: mergedAt.toISOString() },
      revert: { state: "watching", mergeSha: MERGED, mergedAt: mergedAt.toISOString(), until: new Date(mergedAt.getTime() + 3_600_000).toISOString() },
    });
  const occurred = (minutesAfterMerge: number) =>
    db.collection(cfg.incidentCollection).doc("inc1").update({ lastOccurredAt: Timestamp.fromMillis(t0.getTime() + minutesAfterMerge * 60_000) });

  it("does nothing while the incident stays quiet, then closes the watch", async () => {
    await seed("inc1_r0", watching());
    const gh = fakeGithub();
    clock = new Date(t0.getTime() + 30 * 60_000);
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ considered: 1, cleared: 0, opened: 0 });
    clock = new Date(t0.getTime() + 60 * 60_000 + WATCH_SETTLE_MS + 1);
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ cleared: 1 });
    expect((await cycle("inc1_r0")).summary.revert.state).toBe("clear");
    expect(gh.calls).toEqual([]);
  });

  it("opens a revert of the merge commit on a recurrence, tells a person, and merges it once its checks pass", async () => {
    await seed("inc1_r0", watching());
    await occurred(25);
    clock = new Date(t0.getTime() + 30 * 60_000);
    const gh = fakeGithub();
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ opened: 1 });
    expect(gh.reverts).toEqual([expect.objectContaining({ cycleId: "inc1_r0", mergeSha: MERGED, mergedPr: 7 })]);
    expect((await cycle("inc1_r0")).summary.revert).toMatchObject({ state: "pending", number: 8, headSha: REVERT_HEAD, escalation: "sent" });
    expect(told[0]).toMatchObject({ rule: "fast-revert-opened" });

    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ reverted: 1 });
    expect(gh.merges).toEqual([{ id: "revert-inc1_r0", number: 8, sha: REVERT_HEAD }]);
    expect((await cycle("inc1_r0")).summary.revert).toMatchObject({ state: "reverted", by: "starfish" });
    // The revert is never itself watched, so never itself reverted.
    await occurred(40);
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ considered: 0 });
    expect(gh.reverts).toHaveLength(1);
  });

  it("does not revert for an occurrence during the grace (the old code still deploying)", async () => {
    await seed("inc1_r0", watching());
    await occurred(5);
    clock = new Date(t0.getTime() + 8 * 60_000);
    const gh = fakeGithub();
    await runFastRevertStep(revertDeps(gh.client));
    expect(gh.reverts).toEqual([]);
  });

  it("escalates instead of overwriting a later change to the same files", async () => {
    await seed("inc1_r0", watching());
    await occurred(25);
    clock = new Date(t0.getTime() + 30 * 60_000);
    const gh = fakeGithub({ revertError: new GithubError("intervening-changes", "later commit") });
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ escalated: 1 });
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc1_r0")).summary.revert).toMatchObject({ state: "escalated", reason: "intervening-changes", escalation: "sent" });
  });

  it("does not revert while merging is frozen: a person is told instead", async () => {
    blocked = ["merge-freeze"];
    await seed("inc1_r0", watching());
    await occurred(25);
    clock = new Date(t0.getTime() + 30 * 60_000);
    const gh = fakeGithub();
    await runFastRevertStep(revertDeps(gh.client));
    expect(gh.calls).toEqual([]);
    expect((await cycle("inc1_r0")).summary.revert).toMatchObject({ state: "escalated", reason: "switch:merge-freeze" });
  });

  it("does not merge a revert whose checks failed", async () => {
    await seed("inc1_r0", proven({ merge: { state: "merged", mergeSha: MERGED }, revert: { state: "pending", mergeSha: MERGED, number: 8, headSha: REVERT_HEAD, openedAt: t0.toISOString() } }));
    const gh = fakeGithub({ checks: [{ ...success, conclusion: "failure" }] });
    await runFastRevertStep(revertDeps(gh.client));
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc1_r0")).summary.revert).toMatchObject({ state: "escalated", reason: "checks-failed" });
  });

  it("leaves alone a watch whose merge record does not match it", async () => {
    await seed("inc1_r0", proven({ merge: { state: "skipped" }, revert: { state: "watching", mergeSha: MERGED, mergedAt: t0.toISOString() } }));
    await occurred(25);
    clock = new Date(t0.getTime() + 30 * 60_000);
    const gh = fakeGithub();
    await runFastRevertStep(revertDeps(gh.client));
    expect(gh.calls).toEqual([]);
  });
});
