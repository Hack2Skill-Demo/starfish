/**
 * The agent loop against the real Firestore emulator (cycle, lease and events are real), the real
 * verify gate (a real scratch copy, `git apply` and shell command), and a scripted model. The only
 * stubs are the model and the pull-request opener. Run via `pnpm test:emulator`.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { runCycle, type LoopDeps, type LoopSubject, type PullRequestRequest } from "./loop.js";
import type { NotifyRequest } from "../integrations/slack.js";
import { acquireLease } from "./cycle.js";
import { FIX_SYSTEM } from "./fixer.js";
import { REVIEW_SYSTEM } from "./reviewer.js";
import { TRIAGE_SYSTEM, type AskJson } from "./triage.js";
import { SEEDED_SECRETS } from "../ingest/testSecrets.js";
import { testConfig } from "../testConfig.js";
import type { Incident, IncidentStatus } from "../types.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("loop.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "loop-emulator-tests");
const db: Firestore = getFirestore(app, "loop-tests");
afterAll(() => deleteApp(app));

const t0 = new Date("2026-10-04T12:00:00.000Z");
const key = { incidentId: "inc1", environment: "demo", recurrence: 0 };
const GOOD_PATCH = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-hello old\n+hello new\n";
const BAD_PATCH = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-hello old\n+hello still old\n";

const incident: Incident = {
  id: "inc1",
  environment: "demo",
  functionName: "orders-createOrder",
  service: "orders",
  errorType: "DatabaseError",
  occurrenceCount: 42,
  logCounterCheck: { window: "24h", count: 42 },
  message: "Cannot use undefined as a Firestore value",
};

let src: string;
let clock: Date;
let status: IncidentStatus | null;
let enabled: boolean;
let cfgOver: Partial<ReturnType<typeof testConfig>>;
beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), "loop-src-"));
  writeFileSync(join(src, "greeting.txt"), "hello old\n");
  mkdirSync(join(src, "keep"));
  clock = new Date(t0);
  status = "new";
  enabled = true;
  cfgOver = {};
});
afterEach(() => rmSync(src, { recursive: true, force: true }));

/** A model that answers by stage, from queues; an empty queue repeats the last answer. */
function scripted(answers: { triage?: unknown[]; fix?: unknown[]; review?: unknown[] }) {
  const queues = { triage: [...(answers.triage ?? [])], fix: [...(answers.fix ?? [])], review: [...(answers.review ?? [])] };
  const last: Record<string, unknown> = {};
  const calls: { stage: string; prompt: string }[] = [];
  const ask = (async (prompt: string, system: string) => {
    const stage = system === TRIAGE_SYSTEM ? "triage" : system === FIX_SYSTEM ? "fix" : system === REVIEW_SYSTEM ? "review" : "unknown";
    calls.push({ stage, prompt });
    const q = queues[stage as keyof typeof queues];
    if (q.length > 0) last[stage] = q.shift();
    const a = last[stage];
    if (a instanceof Error) throw a;
    return a;
  }) as AskJson;
  return { ask, calls, count: (stage: string) => calls.filter((c) => c.stage === stage).length };
}

const act = { decision: "act", reasoning: "A defect in the order code.", suspectedCause: "createOrder writes undefined" };
const fixOf = (patch: string, over: Record<string, unknown> = {}) => ({
  rootCause: "couponCode is written as undefined.",
  patch,
  testAdded: false,
  risk: "Orders without a coupon.",
  rejectedAlternatives: [],
  ...over,
});
const held = { attacks: [{ attack: "Empty order", outcome: "held", detail: "Handled." }] };
const broken = { attacks: [{ attack: "Zero coupon", outcome: "broken", detail: "Drops a coupon of 0." }] };

let cfg: string; // collection suffix
function deps(model: ReturnType<typeof scripted>, extra: Partial<LoopDeps> = {}, opened: PullRequestRequest[] = []): LoopDeps {
  const run = cfg;
  const loadSubject: LoopSubject = {
    subject: { incident, status: "new" },
    files: [{ path: "greeting.txt", content: "hello old\n" }],
    sourceDir: src,
    baseRevision: "rev1",
  };
  return {
    db,
    config: testConfig({
      cycleCollection: `cycles_${run}`,
      verifyCommand: "grep -q new greeting.txt",
      verifyTimeoutSeconds: 20,
      dryRun: false,
      ...cfgOver,
    }),
    owner: "worker-a",
    now: () => clock,
    ask: model.ask,
    load: async () => loadSubject,
    incidentStatus: async () => status,
    automationEnabled: async () => enabled,
    openPullRequest: async (req) => {
      opened.push(req);
      return { number: 7, url: "https://example.test/pull/7" };
    },
    ...extra,
  };
}
beforeEach(() => {
  cfg = randomUUID().slice(0, 8);
});

const cycleDoc = async () => (await db.collection(`cycles_${cfg}`).doc("inc1_r0").get()).data()!;
const events = async () =>
  (await db.collection(`cycles_${cfg}`).doc("inc1_r0").collection("events").orderBy("seq").get()).docs.map((d) => d.data());
const kinds = async () => (await events()).map((e) => `${e.stage}:${e.type}`);

describe("runCycle: the whole way through", () => {
  it("takes an incident to an opened pull request, recording each stage", async () => {
    const opened: PullRequestRequest[] = [];
    const model = scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] });
    const r = await runCycle(deps(model, {}, opened), key);

    expect(r).toEqual({ kind: "finished", state: "done", outcome: "pr-opened" });
    expect(await kinds()).toEqual(["cycle:started", "triage:decision", "fix:proposed", "verify:passed", "review:approve", "pr:opened"]);
    expect(await cycleDoc()).toMatchObject({ state: "done", outcome: "pr-opened", owner: null });

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ cycleId: "inc1_r0", incidentId: "inc1", baseRevision: "rev1", patch: GOOD_PATCH });
    expect(opened[0]!.verify).toMatchObject({ status: "passed", changedFiles: ["greeting.txt"] });
    expect(opened[0]!.review).toMatchObject({ verdict: "approve" });
    // The evidence in the pull request is for exactly this patch.
    const verifyEvent = (await events()).find((e) => e.stage === "verify")!;
    expect(verifyEvent.data.patchSha256).toBe(opened[0]!.patchSha256);
  });

  it("is a dry run by default: it drafts, verifies and reviews, and opens nothing", async () => {
    cfgOver = { dryRun: true };
    const opened: PullRequestRequest[] = [];
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), {}, opened), key);
    expect(r).toEqual({ kind: "finished", state: "waiting-human", outcome: "dry-run" });
    expect(opened).toHaveLength(0);
    expect(await kinds()).toContain("pr:dry-run");
  });

  it("opens nothing when no opener is configured, even with dry run off", async () => {
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { openPullRequest: undefined }), key);
    expect(r).toMatchObject({ kind: "finished", outcome: "dry-run" });
  });

  it("skips the review when it is not required, and says nothing about one", async () => {
    cfgOver = { reviewRequired: false };
    const opened: PullRequestRequest[] = [];
    const model = scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)] });
    await runCycle(deps(model, {}, opened), key);
    expect(model.count("review")).toBe(0);
    expect(opened[0]!.review).toBeUndefined();
  });

  it("never records the patch or any secret in the events", async () => {
    const model = scripted({
      triage: [{ ...act, reasoning: `token ${SEEDED_SECRETS.github} in the log` }],
      fix: [fixOf(GOOD_PATCH, { rootCause: `leaked ${SEEDED_SECRETS.stripe}` })],
      review: [held],
    });
    await runCycle(deps(model), key);
    const stored = JSON.stringify(await events());
    expect(stored).not.toContain("hello new");
    expect(stored).not.toContain(SEEDED_SECRETS.github);
    expect(stored).not.toContain(SEEDED_SECRETS.stripe);
  });
});

describe("runCycle: seeded secrets stay out of everything that leaves the process (#18)", () => {
  const all = Object.values(SEEDED_SECRETS);
  /** The seeded values and the fragments of them that would still identify a leak. */
  const leaked = (text: string) => all.filter((secret) => text.includes(secret));

  it("keeps every seeded credential out of the prompts, the stored records and the pull request payload", async () => {
    const S = SEEDED_SECRETS;
    const leakyIncident: Incident = {
      ...incident,
      message: `Cannot use undefined as a Firestore value; header ${S.bearerHeader}; key ${S.google}`,
      errorDetail: `upstream said ${S.stripe} and ${S.awsId}`,
      stackTrace: `Error at createOrder\n  token=${S.jwt}\n  hook ${S.slackHook}`,
    };
    const opened: PullRequestRequest[] = [];
    const model = scripted({
      triage: [{ ...act, reasoning: `saw ${S.github} in the log`, suspectedCause: `url had ${S.githubPat}` }],
      // The first patch fails the gate, so the verify output is fed back to the fixer on the second call.
      fix: [
        fixOf(BAD_PATCH, { rootCause: `first try ${S.slack}` }),
        fixOf(GOOD_PATCH, { rootCause: `couponCode is undefined; token was ${S.googleOauth}`, risk: `risk ${S.jwt}`, rejectedAlternatives: [`alt ${S.pem}`] }),
      ],
      review: [{ attacks: [{ attack: `Probe ${S.stripe}`, outcome: "held", detail: `Held; output had ${S.github}` }] }],
    });
    const base = deps(model, {}, opened);
    const r = await runCycle(
      {
        ...base,
        // The gate's own output carries a secret: it is shown to the fixer and to people, so it must be redacted first.
        config: { ...base.config, verifyCommand: `echo "${S.github}"; grep -q new greeting.txt` },
        load: async () => ({
          subject: { incident: leakyIncident, status: "new" },
          files: [{ path: "greeting.txt", content: `hello old\nconst key = "${S.stripe}";\nconst t = "${S.githubPat}";\n` }],
          sourceDir: src,
          baseRevision: "rev1",
        }),
      },
      key
    );
    expect(r).toMatchObject({ kind: "finished", outcome: "pr-opened" });
    expect(model.count("fix")).toBe(2); // the feedback path ran

    // What the model was shown.
    expect(leaked(model.calls.map((c) => c.prompt).join("\n"))).toEqual([]);
    // What was stored, and so shown to guests.
    expect(leaked(JSON.stringify(await cycleDoc()))).toEqual([]);
    expect(leaked(JSON.stringify(await events()))).toEqual([]);
    // What the pull request opener is handed. The patch is a diff of the repository's own files and goes only to a
    // pull request in that repository (the fixer refuses a patch that ADDS a credential shape); everything else is text.
    expect(leaked(JSON.stringify({ ...opened[0], patch: undefined }))).toEqual([]);
  });
});

describe("runCycle: the run record on the cycle", () => {
  it("holds each stage that ran and the way it went, so a reader can tell the outcomes apart", async () => {
    const model = scripted({ triage: [act], fix: [fixOf(GOOD_PATCH, { testAdded: true })], review: [held] });
    await runCycle(deps(model), key);
    const doc = await cycleDoc();
    expect(doc).toMatchObject({ state: "done", outcome: "pr-opened", path: "pr" });
    expect(Object.keys(doc.summary).sort()).toEqual(["fix", "pr", "review", "triage", "verify"]);
    expect(doc.summary.triage).toMatchObject({ decision: "act", rule: "model-act", reason: expect.any(String) });
    expect(doc.summary.fix).toMatchObject({ outcome: "proposed", testAdded: true, revisions: 0 });
    expect(doc.summary.verify).toMatchObject({ status: "passed", rule: "command-passed", baseRevision: "rev1", files: 1, exitCode: 0 });
    expect(doc.summary.review).toMatchObject({ verdict: "approve", attacks: 1, held: 1, broken: 0 });
    expect(doc.summary.pr).toMatchObject({ opened: true, number: 7, url: "https://example.test/pull/7" });
    expect(doc.summary.verify.patchSha256).toBe(doc.summary.pr.patchSha256);
  });

  it.each([
    ["declined", { triage: [{ decision: "decline", reasoning: "noise", suspectedCause: null }] }, {}, { state: "declined", path: "decline" }, ["triage"]],
    ["notified", { triage: [{ decision: "notify", reasoning: "api off", suspectedCause: null }] }, {}, { state: "waiting-human", path: "notify" }, ["triage"]],
    ["handed to a person by the fixer", { triage: [act], fix: [fixOf("", { rootCause: "no context" })] }, {}, { state: "waiting-human", path: "human", outcome: "fixer-declined" }, ["fix", "triage"]],
    ["a draft in dry run", { triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }, { dryRun: true }, { state: "waiting-human", path: "draft", outcome: "dry-run" }, ["fix", "pr", "review", "triage", "verify"]],
    ["blocked by review", { triage: [act], fix: [fixOf(GOOD_PATCH)], review: [broken] }, {}, { state: "waiting-human", path: "human", outcome: "review-blocked" }, ["fix", "review", "triage", "verify"]],
    ["failed on budget", { triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }, { modelCallBudget: 1 }, { state: "failed", path: "failed", outcome: "budget-exceeded" }, ["triage"]],
  ])("is %s", async (_name, answers, over, expected, stages) => {
    cfgOver = over as typeof cfgOver;
    await runCycle(deps(scripted(answers as Parameters<typeof scripted>[0])), key);
    const doc = await cycleDoc();
    expect(doc).toMatchObject(expected);
    // Only the stages that ran are in the record: nothing faked for the ones that did not.
    expect(Object.keys(doc.summary).sort()).toEqual(stages);
  });

  it("shows the final verify result when the first patch was rejected and the second passed", async () => {
    await runCycle(deps(scripted({ triage: [act], fix: [fixOf(BAD_PATCH), fixOf(GOOD_PATCH)], review: [held] })), key);
    const doc = await cycleDoc();
    expect(doc.summary.verify.status).toBe("passed");
    expect(doc.summary.fix.revisions).toBe(1);
  });

  it("tells a timed-out cycle from a declined one", async () => {
    cfgOver = { cycleDeadlineMinutes: 10 };
    const d = deps(scripted({}), { load: async () => null });
    // The cycle begins, then the clock passes its deadline before anyone picks it up again.
    await acquireLease(db, d.config, key, "worker-b", clock);
    clock = new Date(t0.getTime() + 601_000);
    expect(await runCycle(d, key)).toEqual({ kind: "not-acquired", reason: "deadline-passed" });
    expect(await cycleDoc()).toMatchObject({ state: "failed", outcome: "deadline-passed", path: "failed" });
  });
});

describe("runCycle: what triage decides", () => {
  it("declines noise without asking the model for a fix", async () => {
    const noisy = { ...incident, logCounterCheck: { window: "24h", count: 0 } };
    const model = scripted({});
    const d = deps(model, { load: async () => ({ subject: { incident: noisy, status: "new" }, files: [], sourceDir: src, baseRevision: "r" }) });
    const r = await runCycle(d, key);
    expect(r).toEqual({ kind: "finished", state: "declined", outcome: "counter-check-zero" });
    expect(model.calls).toHaveLength(0);
  });

  it("hands a notify-only incident to a person without a fix", async () => {
    const model = scripted({ triage: [{ decision: "notify", reasoning: "The API is not enabled.", suspectedCause: "Vertex API disabled" }] });
    const r = await runCycle(deps(model), key);
    expect(r).toEqual({ kind: "finished", state: "waiting-human", outcome: "notify:model-notify" });
    expect(model.count("fix")).toBe(0);
  });

  it("releases the cycle to try again when the evidence is missing, and gives up after the cap", async () => {
    const missing = { ...incident, logCounterCheck: undefined };
    const d = deps(scripted({}), { load: async () => ({ subject: { incident: missing, status: "new" }, files: [], sourceDir: src, baseRevision: "r" }) });
    expect(await runCycle(d, key)).toEqual({ kind: "released", reason: "counter-check-missing" });
    expect(await cycleDoc()).toMatchObject({ state: "running", owner: null, attempts: 1 });
    expect(await runCycle(d, key)).toMatchObject({ kind: "released" });
    expect(await runCycle(d, key)).toMatchObject({ kind: "released" });
    expect(await runCycle(d, key)).toEqual({ kind: "not-acquired", reason: "retries-exhausted" });
  });

  it("releases the cycle when the model call fails", async () => {
    const r = await runCycle(deps(scripted({ triage: [new Error("boom")] })), key);
    expect(r).toEqual({ kind: "released", reason: "model-call-failed" });
  });
});

describe("runCycle: the fix, the gate and the review", () => {
  it("hands a fixer that lacks the context to a person", async () => {
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf("", { rootCause: "Source not enough." })] })), key);
    expect(r).toEqual({ kind: "finished", state: "waiting-human", outcome: "fixer-declined" });
  });

  it("releases the cycle to try again when the fixer's answer cannot be trusted", async () => {
    const r = await runCycle(deps(scripted({ triage: [act], fix: [{ nonsense: true }] })), key);
    expect(r).toEqual({ kind: "released", reason: "model-output-invalid" });
    expect(await cycleDoc()).toMatchObject({ state: "running", owner: null });
  });

  it("releases the cycle to try again when the reviewer fails", async () => {
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [new Error("boom")] })), key);
    expect(r).toEqual({ kind: "released", reason: "model-call-failed" });
    expect(await cycleDoc()).toMatchObject({ state: "running", owner: null });
  });

  it("sends a patch the tests reject back once, with what failed, and accepts the corrected one", async () => {
    const opened: PullRequestRequest[] = [];
    const model = scripted({ triage: [act], fix: [fixOf(BAD_PATCH), fixOf(GOOD_PATCH)], review: [held] });
    const r = await runCycle(deps(model, {}, opened), key);
    expect(r).toMatchObject({ kind: "finished", state: "done" });
    expect(model.count("fix")).toBe(2);
    expect(model.calls.filter((c) => c.stage === "fix")[1]!.prompt).toContain("PREVIOUS ATTEMPT FAILED VERIFICATION");
    expect(await kinds()).toEqual([
      "cycle:started", "triage:decision", "fix:proposed", "verify:failed", "fix:proposed", "verify:passed", "review:approve", "pr:opened",
    ]);
    expect(opened[0]!.patch).toBe(GOOD_PATCH);
  });

  it("gives up to a person when the second patch fails too, and opens nothing", async () => {
    const opened: PullRequestRequest[] = [];
    const model = scripted({ triage: [act], fix: [fixOf(BAD_PATCH)] });
    const r = await runCycle(deps(model, {}, opened), key);
    expect(r).toEqual({ kind: "finished", state: "waiting-human", outcome: "verify-command-failed" });
    expect(model.count("fix")).toBe(2);
    expect(opened).toHaveLength(0);
  });

  it("refuses a patch that touches a protected path, without running the command", async () => {
    const evil = "--- /dev/null\n+++ b/.github/workflows/ci.yml\n@@ -0,0 +1 @@\n+name: x\n";
    cfgOver = { patchExcludedPaths: [".github/"], verifyCommand: "touch /tmp/should-not-run-loop-test" };
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(evil)] })), key);
    expect(r).toEqual({ kind: "finished", state: "waiting-human", outcome: "verify-excluded-path" });
  });

  it("verifies through the injected verifier and never runs the command in this process", async () => {
    cfgOver = { verifyCommand: "touch /tmp/should-not-run-in-process-loop-test" };
    const seen: { sourceDir: string; patch: string; cycleId?: string; baseRevision?: string }[] = [];
    const remote: LoopDeps["verify"] = async (req) => {
      seen.push({ sourceDir: req.sourceDir, patch: req.patch, ...(req.cycleId !== undefined && { cycleId: req.cycleId }), ...(req.baseRevision !== undefined && { baseRevision: req.baseRevision }) });
      return { status: "passed", rule: "command-passed", reason: "The verify command passed.", patchSha256: createHash("sha256").update(req.patch).digest("hex"), baseRevision: req.baseRevision, changedFiles: ["greeting.txt"], exitCode: 0, output: "ok", durationMs: 5 };
    };
    const opened: PullRequestRequest[] = [];
    const model = scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] });
    const r = await runCycle(deps(model, { verify: remote }, opened), key);
    expect(r).toMatchObject({ kind: "finished", state: "done" });
    // The cycle id is what names the branch in the CI-backed verifier.
    expect(seen).toEqual([{ sourceDir: src, patch: GOOD_PATCH, cycleId: "inc1_r0", baseRevision: "rev1" }]);
    expect(existsSync("/tmp/should-not-run-in-process-loop-test")).toBe(false);
    expect(opened[0]!.verify).toMatchObject({ status: "passed", rule: "command-passed" });
  });

  it("lets an infrastructure failure of the verifier escape, so the lease expires and the cycle is resumed", async () => {
    const down: LoopDeps["verify"] = async () => {
      throw new Error("the verify job wrote no result before the deadline");
    };
    const model = scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)] });
    await expect(runCycle(deps(model, { verify: down }), key)).rejects.toThrow("no result");
    expect((await cycleDoc()).state).toBe("running");
    expect(model.count("fix")).toBe(1);
  });

  it("sends a patch the reviewer breaks back once, and accepts the corrected one", async () => {
    const model = scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [broken, held] });
    const r = await runCycle(deps(model), key);
    expect(r).toMatchObject({ kind: "finished", state: "done" });
    expect(model.count("review")).toBe(2);
    expect(model.calls.filter((c) => c.stage === "fix")[1]!.prompt).toContain("A reviewer broke this patch");
  });

  it("escalates to a person when the review blocks a second time", async () => {
    const opened: PullRequestRequest[] = [];
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [broken] }), {}, opened), key);
    expect(r).toEqual({ kind: "finished", state: "waiting-human", outcome: "review-blocked" });
    expect(opened).toHaveLength(0);
  });

  it("shares ONE revision between a failed gate and a blocked review", async () => {
    const model = scripted({ triage: [act], fix: [fixOf(BAD_PATCH), fixOf(GOOD_PATCH)], review: [broken] });
    const r = await runCycle(deps(model), key);
    expect(r).toEqual({ kind: "finished", state: "waiting-human", outcome: "review-blocked" });
    expect(model.count("fix")).toBe(2);
  });

  it("stops at the model-call budget instead of spending without limit", async () => {
    cfgOver = { modelCallBudget: 3 };
    const model = scripted({ triage: [act], fix: [fixOf(BAD_PATCH), fixOf(GOOD_PATCH)], review: [held] });
    const r = await runCycle(deps(model), key);
    // triage, fix, (verify fails) fix, then the review would be the fourth call.
    expect(r).toEqual({ kind: "finished", state: "failed", outcome: "budget-exceeded" });
    expect(model.calls).toHaveLength(3);
  });
});

describe("runCycle: an operator, or the kill switch, can stop it at any step", () => {
  it("stops before triage when the incident is already resolved", async () => {
    status = "resolved";
    const model = scripted({ triage: [act] });
    expect(await runCycle(deps(model), key)).toEqual({ kind: "finished", state: "declined", outcome: "incident-resolved" });
    expect(model.calls).toHaveLength(0);
  });

  it("stops before triage when automation is off", async () => {
    enabled = false;
    expect(await runCycle(deps(scripted({ triage: [act] })), key)).toEqual({ kind: "finished", state: "declined", outcome: "automation-disabled" });
  });

  it("stops before opening when the incident is resolved while the fix was being made", async () => {
    const opened: PullRequestRequest[] = [];
    const model = scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] });
    const d = deps(model, {}, opened);
    // An operator resolves it while the reviewer is working.
    const ask = d.ask!;
    d.ask = (async (p: string, s: string, sc: Record<string, unknown>) => {
      const out = await ask(p, s, sc);
      if (s === REVIEW_SYSTEM) status = "resolved";
      return out;
    }) as AskJson;
    const r = await runCycle(d, key);
    expect(r).toEqual({ kind: "finished", state: "declined", outcome: "incident-resolved" });
    expect(opened).toHaveLength(0);
  });

  it("stops before opening when automation is switched off while the review ran", async () => {
    const opened: PullRequestRequest[] = [];
    const d = deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), {}, opened);
    const ask = d.ask!;
    d.ask = (async (p: string, s: string, sc: Record<string, unknown>) => {
      const out = await ask(p, s, sc);
      if (s === REVIEW_SYSTEM) enabled = false;
      return out;
    }) as AskJson;
    expect(await runCycle(d, key)).toMatchObject({ kind: "finished", outcome: "automation-disabled" });
    expect(opened).toHaveLength(0);
  });

  it("treats an incident that has vanished as a failure to load", async () => {
    const r = await runCycle(deps(scripted({}), { load: async () => null }), key);
    expect(r).toEqual({ kind: "finished", state: "failed", outcome: "incident-gone" });
  });
});

describe("runCycle: one worker at a time", () => {
  it("does not start when another worker holds the cycle", async () => {
    await acquireLease(db, testConfig({ cycleCollection: `cycles_${cfg}` }), key, "worker-b", clock);
    const model = scripted({ triage: [act] });
    expect(await runCycle(deps(model), key)).toEqual({ kind: "not-acquired", reason: "held" });
    expect(model.calls).toHaveLength(0);
  });

  it("stops dead, opens nothing and writes nothing more when its lease is taken over mid-cycle", async () => {
    const opened: PullRequestRequest[] = [];
    const d = deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), {}, opened);
    const ask = d.ask!;
    d.ask = (async (p: string, s: string, sc: Record<string, unknown>) => {
      const out = await ask(p, s, sc);
      if (s === FIX_SYSTEM) {
        // The fixer was slow: the lease runs out and another worker takes the cycle.
        clock = new Date(t0.getTime() + 400_000);
        await acquireLease(db, d.config, key, "worker-b", clock);
      }
      return out;
    }) as AskJson;

    const r = await runCycle(d, key);

    expect(r).toEqual({ kind: "lease-lost" });
    expect(opened).toHaveLength(0);
    expect(await cycleDoc()).toMatchObject({ state: "running", owner: "worker-b" });
    expect((await kinds()).filter((k) => k.startsWith("verify") || k.startsWith("review") || k.startsWith("pr"))).toEqual([]);
  });
});

describe("runCycle: the lease is proved again just before anything is opened", () => {
  it("does not open if the lease ran out in the moment between the last check and the open", async () => {
    const opened: PullRequestRequest[] = [];
    let asked = 0;
    const d = deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), {}, opened);
    // The fourth look at the automation switch is the one just before opening; time passes during it.
    d.automationEnabled = async () => {
      if (++asked === 4) clock = new Date(t0.getTime() + 400_000);
      return true;
    };
    expect(await runCycle(d, key)).toEqual({ kind: "lease-lost" });
    expect(opened).toHaveLength(0);
  });
});

describe("runCycle: the pull request is opened once per cycle", () => {
  it("retries a failed open with the same idempotency key", async () => {
    const keys: string[] = [];
    let first = true;
    const d = deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), {
      openPullRequest: async (req) => {
        keys.push(req.cycleId);
        if (first) {
          first = false;
          throw new Error("GitHub timed out");
        }
        return { number: 9, url: "u" };
      },
    });
    await expect(runCycle(d, key)).rejects.toThrow("GitHub timed out");
    // The lease runs out; the next worker resumes the same cycle.
    clock = new Date(t0.getTime() + 400_000);
    const r = await runCycle({ ...d, owner: "worker-b" }, key);
    expect(r).toMatchObject({ kind: "finished", state: "done" });
    expect(keys).toEqual(["inc1_r0", "inc1_r0"]);
  });

  it("does not open another for a cycle that is already done, and a regression gets its own", async () => {
    const opened: PullRequestRequest[] = [];
    const d = deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), {}, opened);
    await runCycle(d, key);
    expect(await runCycle(d, key)).toEqual({ kind: "not-acquired", reason: "closed" });
    expect(opened).toHaveLength(1);

    const again = await runCycle(d, { ...key, recurrence: 1 });
    expect(again).toMatchObject({ kind: "finished", state: "done" });
    expect(opened.map((o) => o.cycleId)).toEqual(["inc1_r0", "inc1_r1"]);
  });
});

describe("runCycle: telling a person (#17)", () => {
  const notifyDecision = { decision: "notify", reasoning: "The API is not enabled.", suspectedCause: "Translation API disabled" };
  const summaryNotify = async () => (await cycleDoc()).summary?.notify;

  it("tells a person once when no code change helps, recording pending and then sent", async () => {
    const calls: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 });
    const r = await runCycle(deps(scripted({ triage: [notifyDecision] }), { notify }), key);

    expect(r).toEqual({ kind: "finished", state: "waiting-human", outcome: "notify:model-notify" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cycleId: "inc1_r0", incidentId: "inc1", functionName: "orders-createOrder", service: "orders", path: "notify", rule: "model-notify", occurrenceCount: 42 });
    expect(calls[0]!.reason).toContain("The API is not enabled");
    expect(await kinds()).toEqual(["cycle:started", "triage:decision", "notify:pending", "notify:sent"]);
    expect(await summaryNotify()).toEqual({ state: "sent", attempts: 1 });
  });

  it("tells a person when a fix could not be finished: the fixer declines, the gate or the review will not pass", async () => {
    const paths: Array<[string, ReturnType<typeof scripted>]> = [
      ["the fixer declines", scripted({ triage: [act], fix: [{ rootCause: "No context.", patch: "", testAdded: false, risk: "", rejectedAlternatives: [] }] })],
      ["the gate rejects twice", scripted({ triage: [act], fix: [fixOf(BAD_PATCH)] })],
      ["the review blocks twice", scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [broken] })],
    ];
    for (const [name, model] of paths) {
      cfg = randomUUID().slice(0, 8);
      const calls: NotifyRequest[] = [];
      const notify = async (req: NotifyRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 });
      const r = await runCycle(deps(model, { notify }), key);
      expect(r, name).toMatchObject({ kind: "finished", state: "waiting-human" });
      expect(calls, name).toHaveLength(1);
      expect(calls[0]!.path, name).toBe("human");
    }
  });

  it("passes no count, not zero, when the stored incident has none", async () => {
    const calls: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 });
    const unknown = { ...incident, occurrenceCount: undefined };
    const load = async () => ({ subject: { incident: unknown, status: "new" as const }, files: [], sourceDir: src, baseRevision: "r" });
    await runCycle(deps(scripted({ triage: [notifyDecision] }), { notify, load }), key);
    expect(calls[0]!.occurrenceCount).toBeNull();
  });

  it("does not tell anyone about a cycle that opened a pull request, or one that declined", async () => {
    const calls: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 });
    await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { notify }), key);
    cfg = randomUUID().slice(0, 8);
    await runCycle(deps(scripted({ triage: [{ decision: "decline", reasoning: "Noise.", suspectedCause: "" }] }), { notify }), key);
    expect(calls).toHaveLength(0);
    expect((await kinds()).some((k) => k.startsWith("notify:"))).toBe(false);
  });

  it("records a failed delivery where a person can see it, and still finishes the cycle", async () => {
    const notify = async () => ({ state: "failed" as const, attempts: 3, reason: "http-404:no_service" });
    const r = await runCycle(deps(scripted({ triage: [notifyDecision] }), { notify }), key);
    expect(r).toMatchObject({ kind: "finished", state: "waiting-human" });
    expect(await summaryNotify()).toEqual({ state: "failed", attempts: 3, reason: "http-404:no_service" });
    expect(await kinds()).toContain("notify:failed");
  });

  it("treats a notifier that throws as a failed delivery, not a lost cycle", async () => {
    const notify = async (): Promise<never> => {
      throw new Error(`boom ${SEEDED_SECRETS.github}`);
    };
    const r = await runCycle(deps(scripted({ triage: [notifyDecision] }), { notify }), key);
    expect(r).toMatchObject({ kind: "finished", state: "waiting-human" });
    expect(await summaryNotify()).toMatchObject({ state: "failed", reason: "notifier-error" });
    expect(JSON.stringify(await events())).not.toContain(SEEDED_SECRETS.github);
  });

  it("sends nothing in a dry run, and the record says so", async () => {
    const calls: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 });
    cfgOver = { dryRun: true };
    await runCycle(deps(scripted({ triage: [notifyDecision] }), { notify }), key);
    expect(calls).toHaveLength(0);
    expect(await summaryNotify()).toEqual({ state: "dry-run" });
  });

  it("records no notify stage at all when nothing is configured to tell a person", async () => {
    await runCycle(deps(scripted({ triage: [notifyDecision] })), key);
    expect(await summaryNotify()).toBeUndefined();
    expect((await kinds()).some((k) => k.startsWith("notify:"))).toBe(false);
  });

  it("does not send again for a delivery already recorded sent or failed, and sends again after a crash left it pending", async () => {
    // A cycle that exists and is resumable: triage errors once, which releases the lease.
    const calls: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 });
    const outcomes: Array<[unknown, number]> = [[{ state: "sent", attempts: 1 }, 0], [{ state: "failed", attempts: 3, reason: "http-500" }, 0], [{ state: "pending", attempts: 0 }, 1]];
    for (const [prior, expectedCalls] of outcomes) {
      cfg = randomUUID().slice(0, 8);
      calls.length = 0;
      expect(await runCycle(deps(scripted({ triage: [new Error("boom")] }), { notify }), key)).toMatchObject({ kind: "released" });
      await db.collection(`cycles_${cfg}`).doc("inc1_r0").update({ "summary.notify": prior });
      await runCycle(deps(scripted({ triage: [notifyDecision] }), { notify }), key);
      expect(calls, JSON.stringify(prior)).toHaveLength(expectedCalls);
    }
  });

  it("does not send once a person has resolved the incident in the meantime", async () => {
    const calls: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 });
    const model = scripted({ triage: [notifyDecision] });
    const ask = (async (...args: Parameters<AskJson>) => {
      const answer = await model.ask(...args);
      status = "resolved"; // resolved while the model was thinking
      return answer;
    }) as AskJson;
    const r = await runCycle(deps(model, { notify, ask }), key);
    expect(r).toMatchObject({ kind: "finished", state: "waiting-human" });
    expect(calls).toHaveLength(0);
  });
});
