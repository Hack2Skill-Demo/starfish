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
import { stateDocId } from "../ingest/run.js";
import type { NotifyRequest } from "../integrations/slack.js";
import { testConfig } from "../testConfig.js";
import type { LevelCap } from "../triageRules.js";
import type { IncidentStatus } from "../types.js";
import { runAutoMergeStep, type AutoMergeDeps, type MergeClient } from "./autoMerge.js";
import { runFastRevertStep, watchSpan, type FastRevertDeps, type RevertClient } from "./fastRevert.js";

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
/** The rules engine's cap the merge step reads (null: none; an Error: the read fails). */
let cap: LevelCap | null | Error;
let told: NotifyRequest[];
/** The merge case each read of the switches asked about (null: none). */
let asked: (string | null)[];
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
  cap = null;
  told = [];
  asked = [];
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
      kind: "code",
      mergeCase: "firestore-undefined-field",
      floor: "pass",
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

const success: CheckRun = { id: 11, name: "verify", status: "completed", conclusion: "success", url: "https://github.com/acme/demo-shop/actions/runs/1", app: "github-actions", title: "", summary: "" };

function fakeGithub(
  opts: { pr?: Partial<PullRequestState>; readError?: Error; revertReadError?: Error; checks?: CheckRun[] | Error; mergeError?: Error; commentError?: Error; revertError?: Error; revertPr?: Partial<PullRequestState>; changed?: string[] | Error } = {}
) {
  const calls: string[] = [];
  const merges: { id: string; number: number; sha: string }[] = [];
  const reverts: RevertRequest[] = [];
  const client: MergeClient & RevertClient = {
    readPullRequest: async (id, number) => {
      calls.push(`read ${id} #${number}`);
      const readError = id.startsWith("revert-") ? opts.revertReadError : opts.readError;
      if (readError) throw readError;
      const base = id.startsWith("revert-") ? { headSha: REVERT_HEAD, ...opts.revertPr } : { headSha: HEAD, ...opts.pr };
      return { number, state: "open", mergedAt: null, closedAt: null, ...base } as PullRequestState;
    },
    listCheckRuns: async (sha) => {
      calls.push(`checks ${sha.slice(0, 4)}`);
      if (opts.checks instanceof Error) throw opts.checks;
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
    blockedBy: async (mergeCase?: string) => {
      asked.push(mergeCase ?? null);
      return blocked.length > 1 ? blocked.shift()! : blocked[0]!;
    },
    incidentStatus: async () => status,
    incidentCap: async () => {
      if (cap instanceof Error) throw cap;
      return cap;
    },
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

  it("asks the switches about the candidate's own merge case, so a case an admin removed stops its merge", async () => {
    await seed("inc1_r0");
    const gh = fakeGithub();
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(asked).toContain("firestore-undefined-field");
    blocked = ["case-not-listed"];
    await seed("inc2_r0");
    await runAutoMergeStep(mergeDeps(gh.client));
    expect((await cycle("inc2_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "switch:case-not-listed", escalation: "sent" });
  });

  it("merges on Gemini's case, the floor and green checks even when the old certainty gate would not have held (reported instead)", async () => {
    await seed("inc1_r0", proven({ review: { flagged: 1 }, before: { status: "unavailable", rule: "no-test-in-patch" } }));
    const gh = fakeGithub();
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ merged: 1 });
    expect(gh.merges).toEqual([{ id: "inc1_r0", number: 7, sha: HEAD }]);
  });

  it("merges a missing-index evidence PR on green checks, and starts no revert watch (a revert would not remove the index)", async () => {
    await seed(
      "inc3_r0",
      {
        index: { state: "ready", probe: "passed" },
        pr: { opened: true, number: 9, url: "https://github.com/acme/demo-shop/pull/9", patchSha256: P },
        merge: { state: "pending", kind: "index", mergeCase: "missing-index", number: 9, patchSha256: P, headSha: HEAD, floor: "pass", sourceFile: "firestore.indexes.json", baseRevision: "1".repeat(40), pendingSince: t0.toISOString() },
      },
      { path: "index", outcome: "index-pr-opened" }
    );
    const gh = fakeGithub();
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ merged: 1 });
    expect(asked).toContain("missing-index");
    const s = (await cycle("inc3_r0")).summary;
    expect(s.merge).toMatchObject({ state: "merged", mergeSha: MERGED });
    expect(s.revert).toMatchObject({ state: "clear", reason: "index-not-reverted" });
  });

  it("never merges an index evidence PR whose index file changed on the base branch since", async () => {
    await seed("inc3_r0", {
      pr: { opened: true, number: 9, url: "u", patchSha256: P },
      merge: { state: "pending", kind: "index", mergeCase: "missing-index", number: 9, patchSha256: P, headSha: HEAD, floor: "pass", sourceFile: "firestore.indexes.json", baseRevision: "1".repeat(40), pendingSince: t0.toISOString() },
    });
    const gh = fakeGithub({ changed: ["firestore.indexes.json"] });
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc3_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "base-changed-same-file" });
  });

  it("pauses while automation is off: nothing read, nothing decided", async () => {
    blocked = ["automation-disabled"];
    await seed("inc1_r0");
    const gh = fakeGithub();
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ paused: true, considered: 0 });
    expect(gh.calls).toEqual([]);
    expect((await cycle("inc1_r0")).summary.merge.state).toBe("pending");
  });

  it("never touches a seeded synthetic cycle, whatever its record says (#192)", async () => {
    await seed("inc1_r0", proven(), { synthetic: true });
    const gh = fakeGithub();
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ considered: 0 });
    expect(gh.calls).toEqual([]);
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
    ["the change is outside the safety floor", { merge: { floor: "fail" } }, "floor:not-recorded"],
    ["no merge case was decided", { merge: { mergeCase: null } }, "no-merge-case"],
    // A record from before merge cases (#9's gate 1) names none: never merged on a guess.
    ["a record from before merge cases", { merge: { mergeCase: null, gate1: "pass" } }, "no-merge-case"],
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
    // GitHub listed fewer runs than it counts, or more than Starfish reads: never judged on part of them (#205).
    ["check runs it cannot all read", { checks: new GithubError("too-many-check-runs", "more than 500") }, "checks-unreadable"],
  ])("refuses %s", async (_name, gh0, reason) => {
    if (reason === "checks-timeout") clock = new Date(t0.getTime() + 121 * 60_000);
    await seed("inc1_r0");
    const gh = fakeGithub(gh0);
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc1_r0")).summary.merge).toMatchObject({ state: "skipped", reason });
  });

  it("hands a pull request retargeted to another base branch to a person, and merges nothing (#186)", async () => {
    await seed("inc1_r0");
    const gh = fakeGithub({ readError: new GithubError("wrong-base", "not the configured base") });
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ skipped: 1, errors: [] });
    expect(gh.calls.filter((c) => c.startsWith("merge") || c.startsWith("comment"))).toEqual([]);
    expect((await cycle("inc1_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "wrong-base", escalation: "sent" });
    expect(told[0]).toMatchObject({ path: "human", rule: "auto-merge-wrong-base" });
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

  it("never merges an incident an admin's rule or an operator's correction holds below merge, and tells a person", async () => {
    await seed("a_r0");
    cap = { level: "fix", by: "correction" };
    const gh = fakeGithub();
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(gh.merges).toEqual([]);
    expect((await cycle("a_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "capped:correction", escalation: "sent" });
    cap = { level: "log", by: "rule", ruleId: "payments-human" };
    await seed("b_r0");
    await runAutoMergeStep(mergeDeps(gh.client));
    expect(gh.merges).toEqual([]);
    expect((await cycle("b_r0")).summary.merge).toMatchObject({ state: "skipped", reason: "capped:rule" });
  });

  it("leaves the candidate pending when the cap can't be read: never a merge on a guess", async () => {
    await seed("a_r0");
    cap = new Error("unavailable");
    const gh = fakeGithub();
    const out = await runAutoMergeStep(mergeDeps(gh.client));
    expect(out.errors).toHaveLength(1);
    expect(gh.merges).toEqual([]);
    expect((await cycle("a_r0")).summary.merge.state).toBe("pending");
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

  it("does not merge a second fix while the first merge's fast-revert watch is open: a person is told (#240)", async () => {
    // The review's scenario: M1 merged and watched; the incident came back, and a new cycle's PR is green in the same pass.
    for (const state of ["watching", "opening", "pending", "merging"]) {
      await seed("inc1_r0", proven({ merge: { state: "merged", mergeSha: MERGED }, revert: { state, mergeSha: MERGED, mergedAt: t0.toISOString() } }));
      await seed("inc1_r1", proven(), { recurrence: 1 });
      told = [];
      const gh = fakeGithub();
      await runAutoMergeStep(mergeDeps(gh.client));
      expect(gh.merges, state).toEqual([]);
      expect((await cycle("inc1_r1")).summary.merge, state).toMatchObject({ state: "skipped", reason: "incident-merge-watched", escalation: "sent" });
      expect(told[0], state).toMatchObject({ path: "human", rule: "auto-merge-incident-merge-watched" });
    }
  });

  it("does not merge a second fix while another is being merged, or was merged with no watch recorded", async () => {
    for (const [name, earlier] of [
      ["merging", { merge: { state: "merging", claimedAt: t0.toISOString(), claimedBy: "other" } }],
      ["merged, no watch", { merge: { state: "merged", mergeSha: MERGED } }],
    ] as const) {
      const summary = proven(earlier as Record<string, Record<string, unknown>>);
      delete summary.revert;
      await seed("inc1_r0", summary);
      await seed("inc1_r1", proven(), { recurrence: 1 });
      const gh = fakeGithub();
      await runAutoMergeStep(mergeDeps(gh.client));
      expect(gh.merges, name).toEqual([]);
      expect((await cycle("inc1_r1")).summary.merge, name).toMatchObject({ state: "skipped", reason: "incident-merge-watched" });
    }
  });

  it("merges a later fix once the earlier merge's watch closed clear", async () => {
    await seed("inc1_r0", proven({ merge: { state: "merged", mergeSha: MERGED }, revert: { state: "clear", mergeSha: MERGED } }));
    await seed("inc1_r1", proven(), { recurrence: 1 });
    const gh = fakeGithub();
    expect(await runAutoMergeStep(mergeDeps(gh.client))).toMatchObject({ merged: 1 });
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
  /** Ingest has read this target's logs through `at` (its checkpoint, as src/ingest/run.ts keeps it). */
  const ingested = (at: number) =>
    db.collection(cfg.runCollection).doc(stateDocId(cfg)).set({ target: { watchedProjectId: cfg.watchedProjectId, environment: cfg.environment }, checkpoint: Timestamp.fromMillis(at) });

  it("does nothing while the incident stays quiet, then closes the watch", async () => {
    await seed("inc1_r0", watching());
    const { reach, closesAt } = watchSpan(t0.getTime(), cfg);
    await ingested(reach + 3_600_000);
    const gh = fakeGithub();
    clock = new Date(t0.getTime() + 30 * 60_000);
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ considered: 1, cleared: 0, opened: 0 });
    clock = new Date(closesAt - 1);
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ cleared: 0 });
    clock = new Date(closesAt + 1);
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ cleared: 1 });
    expect((await cycle("inc1_r0")).summary.revert.state).toBe("clear");
    expect(gh.calls).toEqual([]);
  });

  it("never closes a watch clear on logs ingest has not read: it keeps watching, then tells a person (#241)", async () => {
    await seed("inc1_r0", watching());
    const { reach, closesAt } = watchSpan(t0.getTime(), cfg);
    const gh = fakeGithub();
    clock = new Date(closesAt + 1);
    // No checkpoint at all: not covered.
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ cleared: 0, uncovered: 1, escalated: 0 });
    // Ingest stalled short of the last hour that counts: still not covered, however quiet the incident's record looks.
    await ingested(reach + 3_600_000 - 1);
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ cleared: 0, uncovered: 1 });
    expect((await cycle("inc1_r0")).summary.revert.state).toBe("watching");
    // Ingest catches up and reads the recurrence it had missed: the watch still sees it.
    await ingested(reach + 3_600_000);
    await occurred(25);
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ opened: 1 });
    expect(told.map((t) => t.rule)).toEqual(["fast-revert-opened"]);
  });

  it("tells a person, and reverts nothing, when ingest has still not read the window a day after the watch closed (#241)", async () => {
    await seed("inc1_r0", watching());
    const { reach, closesAt } = watchSpan(t0.getTime(), cfg);
    await ingested(reach);
    const gh = fakeGithub();
    clock = new Date(closesAt + 24 * 3_600_000);
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ uncovered: 1, escalated: 0 });
    clock = new Date(closesAt + 24 * 3_600_000 + 1);
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ cleared: 0, uncovered: 0, escalated: 1 });
    expect((await cycle("inc1_r0")).summary.revert).toMatchObject({ state: "escalated", reason: "ingest-not-covered", escalation: "sent" });
    expect(told[0]).toMatchObject({ path: "human", rule: "fast-revert-not-covered" });
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

  it("does not merge a revert whose check runs cannot all be read (#205)", async () => {
    await seed("inc1_r0", proven({ merge: { state: "merged", mergeSha: MERGED }, revert: { state: "pending", mergeSha: MERGED, number: 8, headSha: REVERT_HEAD, openedAt: t0.toISOString() } }));
    const gh = fakeGithub({ checks: new GithubError("too-many-check-runs", "more than 500") });
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ escalated: 1, errors: [] });
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc1_r0")).summary.revert).toMatchObject({ state: "escalated", reason: "checks-unreadable" });
  });

  it("does not merge a revert retargeted to another base branch: a person is told, once (#186)", async () => {
    await seed("inc1_r0", proven({ merge: { state: "merged", mergeSha: MERGED }, revert: { state: "pending", mergeSha: MERGED, number: 8, headSha: REVERT_HEAD, openedAt: t0.toISOString() } }));
    const gh = fakeGithub({ revertReadError: new GithubError("wrong-base", "not the configured base") });
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ escalated: 1, errors: [] });
    expect(gh.merges).toEqual([]);
    expect((await cycle("inc1_r0")).summary.revert).toMatchObject({ state: "escalated", reason: "wrong-base", escalation: "sent" });
  });

  it("does not revert from ambiguous hourly counts after the window (#252)", async () => {
    await seed("inc1_r0", watching());
    // Every minute from the merge to 70 minutes after it: the latest is past the window, the 13:00 hour is not.
    const byHour: Record<string, number> = {};
    for (let m = 0; m <= 70; m++) {
      const k = String(Math.floor((t0.getTime() + m * 60_000) / 3_600_000));
      byHour[k] = (byHour[k] ?? 0) + 1;
    }
    await db.collection(cfg.incidentCollection).doc("inc1").update({ lastOccurredAt: Timestamp.fromMillis(t0.getTime() + 70 * 60_000), occurrencesByHour: byHour });
    clock = new Date(t0.getTime() + 75 * 60_000);
    const gh = fakeGithub();
    expect(await runFastRevertStep(revertDeps(gh.client))).toMatchObject({ opened: 0 });
    expect(gh.calls).toEqual([]);
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
