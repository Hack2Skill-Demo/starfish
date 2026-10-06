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
import type { AlertRequest, NotifyRequest } from "../integrations/slack.js";
import type { IssueRequest } from "../integrations/githubPr.js";
import { acquireLease } from "./cycle.js";
import { selectCandidates } from "./pass.js";
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

  it("keeps the counter-check triage judged on, the alternatives the fixer rejected and each attack the reviewer tried (#39)", async () => {
    const model = scripted({
      triage: [act],
      fix: [fixOf(GOOD_PATCH, { rejectedAlternatives: ["Default couponCode to an empty string", "Turn on ignoreUndefinedProperties"] })],
      review: [{ attacks: [{ attack: "Empty order", outcome: "held", detail: "Handled." }, { attack: "Coupon of 0", outcome: "flagged", detail: "Worth a test." }] }],
    });
    await runCycle(deps(model), key);
    const doc = await cycleDoc();
    expect(doc.summary.triage).toMatchObject({ counterCount: 42, counterWindow: "24h", counterCapped: false });
    expect(doc.summary.triage.model).toEqual(expect.any(String));
    expect(doc.summary.fix).toMatchObject({ alternative1: "Default couponCode to an empty string", alternative2: "Turn on ignoreUndefinedProperties" });
    expect(doc.summary.fix.alternative3).toBeUndefined();
    expect(doc.summary.review).toMatchObject({ attack1: "flagged: Coupon of 0 | Worth a test.", attack2: "held: Empty order | Handled." });
  });

  it("records a missing counter-check as missing, never as zero", async () => {
    const missing = { ...incident, logCounterCheck: undefined };
    const d = deps(scripted({}), { load: async () => ({ subject: { incident: missing, status: "new" }, files: [], sourceDir: src, baseRevision: "r" }) });
    await runCycle(d, key);
    const triage = (await cycleDoc()).summary.triage;
    expect(triage.counterCount).toBeNull();
    expect(triage.counterWindow).toBeUndefined();
    // A gate decided, not the model: no model is named.
    expect(triage.model).toBeUndefined();
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

  it("pauses, without settling, when automation is off, and takes the cycle up again, uncounted, once it is on (#133)", async () => {
    await db.collection(`incidents_${cfg}`).doc("inc1").set({ environment: "demo", status: "new", lastOccurredAt: t0 });
    const model = scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] });
    enabled = false;
    expect(await runCycle(deps(model), key)).toEqual({ kind: "released", reason: "automation-disabled" });
    expect(model.calls).toHaveLength(0);
    expect(await cycleDoc()).toMatchObject({ state: "running", owner: null, attempts: 1, resumeUncounted: true });
    // Still a candidate: a paused cycle is not settled.
    const d = deps(model);
    const passCfg = testConfig({ environment: "demo", incidentCollection: `incidents_${cfg}`, cycleCollection: `cycles_${cfg}` });
    expect(await selectCandidates(db, passCfg, 5)).toEqual([{ incidentId: "inc1", recurrence: 0 }]);
    // Off again on the next pass, and again: pausing never uses up the attempts.
    for (let i = 0; i < 3; i++) expect(await runCycle(d, key)).toMatchObject({ kind: "released" });
    enabled = true;
    expect(await runCycle(d, key)).toEqual({ kind: "finished", state: "done", outcome: "pr-opened" });
    expect(await cycleDoc()).toMatchObject({ attempts: 1, resumeUncounted: false });
  });

  it("pauses when the switch cannot be read, which reads as off: one failed settings read declines nothing (#133)", async () => {
    const r = await runCycle(deps(scripted({ triage: [act] }), { automationEnabled: async () => false }), key);
    expect(r).toEqual({ kind: "released", reason: "automation-disabled" });
    expect((await cycleDoc()).state).toBe("running");
  });

  it("asks the kill switch again before verify, so nothing is pushed for CI once automation is off (#138)", async () => {
    const verified: string[] = [];
    const verify: LoopDeps["verify"] = async (req) => {
      verified.push(req.patch);
      throw new Error("must not run");
    };
    const d = deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)] }), { verify });
    const ask = d.ask!;
    d.ask = (async (p: string, s: string, sc: Record<string, unknown>) => {
      const out = await ask(p, s, sc);
      if (s === FIX_SYSTEM) enabled = false;
      return out;
    }) as AskJson;
    expect(await runCycle(d, key)).toEqual({ kind: "released", reason: "automation-disabled" });
    expect(verified).toEqual([]);
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
    expect(await runCycle(d, key)).toEqual({ kind: "released", reason: "automation-disabled" });
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
    // The fifth look at the automation switch (triage, fix, verify, review, open) is the one just before opening; time passes during it.
    d.automationEnabled = async () => {
      if (++asked === 5) clock = new Date(t0.getTime() + 400_000);
      return true;
    };
    expect(await runCycle(d, key)).toEqual({ kind: "lease-lost" });
    expect(opened).toHaveLength(0);
    expect(await kinds()).toContain("review:approve");
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

describe("runCycle: the incident's GitHub issue (#17)", () => {
  const notifyDecision = { decision: "notify", reasoning: "The API is not enabled.", suspectedCause: "Translation API disabled" };
  const ISSUE = { number: 12, url: "https://github.com/acme/shop/issues/12" };
  const recorder = () => {
    const calls: IssueRequest[] = [];
    return { calls, openIssue: async (req: IssueRequest) => (calls.push(req), ISSUE) };
  };
  const summaryIssue = async () => (await cycleDoc()).summary?.issue;

  it("files the issue right after triage, before any fix, and the pull request then closes it", async () => {
    const { calls, openIssue } = recorder();
    const opened: PullRequestRequest[] = [];
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { openIssue }, opened), key);

    expect(r).toEqual({ kind: "finished", state: "done", outcome: "pr-opened" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cycleId: "inc1_r0", incidentId: "inc1", functionName: "orders-createOrder", service: "orders", path: "act", occurrenceCount: 42, counterCheck: { window: "24h", count: 42, capped: false } });
    expect(calls[0]!.reason).toContain("A defect in the order code");
    expect(await kinds()).toEqual(["cycle:started", "triage:decision", "issue:opened", "fix:proposed", "verify:passed", "review:approve", "pr:opened"]);
    expect(await summaryIssue()).toEqual({ state: "opened", number: 12, url: ISSUE.url });
    expect(opened[0]!.issueNumber).toBe(12);
  });

  it("files one for an incident that needs a person, and links it from the Slack message", async () => {
    const { calls, openIssue } = recorder();
    const told: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (told.push(req), { state: "sent" as const, attempts: 1 });
    await runCycle(deps(scripted({ triage: [notifyDecision] }), { openIssue, notify }), key);
    expect(calls[0]).toMatchObject({ path: "notify", suspectedCause: "Translation API disabled" });
    expect(told[0]!.issueUrl).toBe(ISSUE.url);
    expect(await kinds()).toEqual(["cycle:started", "triage:decision", "issue:opened", "notify:pending", "notify:sent"]);
  });

  it("files none for a declined incident, or one that is released to try again", async () => {
    const { calls, openIssue } = recorder();
    await runCycle(deps(scripted({ triage: [{ decision: "decline", reasoning: "Noise.", suspectedCause: "" }] }), { openIssue }), key);
    cfg = randomUUID().slice(0, 8);
    await runCycle(deps(scripted({ triage: [new Error("boom")] }), { openIssue }), key);
    expect(calls).toHaveLength(0);
    expect((await kinds()).some((k) => k.startsWith("issue:"))).toBe(false);
  });

  it("records a failure with GitHub's reason, and the cycle goes on without an issue to close", async () => {
    const openIssue = async () => {
      throw Object.assign(new Error(`GitHub said no ${SEEDED_SECRETS.github}`), { rule: "forbidden" });
    };
    const opened: PullRequestRequest[] = [];
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { openIssue }, opened), key);
    expect(r).toEqual({ kind: "finished", state: "done", outcome: "pr-opened" });
    expect(await summaryIssue()).toEqual({ state: "failed", reason: "forbidden" });
    expect(opened[0]!.issueNumber).toBeUndefined();
    expect(JSON.stringify(await events())).not.toContain(SEEDED_SECRETS.github);
  });

  it("files nothing in a dry run, and the record says so", async () => {
    const { calls, openIssue } = recorder();
    cfgOver = { dryRun: true };
    await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { openIssue }), key);
    expect(calls).toHaveLength(0);
    expect(await summaryIssue()).toEqual({ state: "dry-run" });
  });

  it("records no issue stage at all when nothing is configured to file one", async () => {
    await runCycle(deps(scripted({ triage: [notifyDecision] })), key);
    expect(await summaryIssue()).toBeUndefined();
  });

  it("reuses the issue a resumed cycle already recorded, and tries again after a recorded failure", async () => {
    const { calls, openIssue } = recorder();
    const prior: Array<[unknown, number]> = [[{ state: "opened", number: 7, url: "https://github.com/acme/shop/issues/7" }, 0], [{ state: "failed", reason: "server-error" }, 1]];
    for (const [record, expectedCalls] of prior) {
      cfg = randomUUID().slice(0, 8);
      calls.length = 0;
      expect(await runCycle(deps(scripted({ triage: [new Error("boom")] }), { openIssue }), key)).toMatchObject({ kind: "released" });
      await db.collection(`cycles_${cfg}`).doc("inc1_r0").update({ "summary.issue": record });
      const opened: PullRequestRequest[] = [];
      await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { openIssue }, opened), key);
      expect(calls, JSON.stringify(record)).toHaveLength(expectedCalls);
      expect(opened[0]!.issueNumber, JSON.stringify(record)).toBe(expectedCalls === 0 ? 7 : 12);
    }
  });
});

describe("runCycle: the #ops-alerts \"new incident\" message (#17)", () => {
  const notifyDecision = { decision: "notify", reasoning: "The API is not enabled.", suspectedCause: "Translation API disabled" };
  const ISSUE = { number: 12, url: "https://github.com/acme/shop/issues/12" };
  const recorder = () => {
    const calls: AlertRequest[] = [];
    return { calls, alert: async (req: AlertRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 }) };
  };
  const summaryAlert = async () => (await cycleDoc()).summary?.alert;

  it("alerts once for an incident Starfish acts on, after its issue is filed and linking it, then goes on to the PR", async () => {
    const { calls, alert } = recorder();
    const openIssue = async () => ISSUE;
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { alert, openIssue }), key);
    expect(r).toEqual({ kind: "finished", state: "done", outcome: "pr-opened" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cycleId: "inc1_r0", incidentId: "inc1", functionName: "orders-createOrder", path: "act", occurrenceCount: 42, issueUrl: ISSUE.url });
    expect(calls[0]!.reason).toContain("A defect in the order code");
    expect(await kinds()).toEqual(["cycle:started", "triage:decision", "issue:opened", "alert:pending", "alert:sent", "fix:proposed", "verify:passed", "review:approve", "pr:opened"]);
    expect(await summaryAlert()).toEqual({ state: "sent", attempts: 1 });
  });

  it("alerts for an escalated incident too, beside the on-call message, and never for a declined one", async () => {
    const { calls, alert } = recorder();
    const notify = async () => ({ state: "sent" as const, attempts: 1 });
    await runCycle(deps(scripted({ triage: [notifyDecision] }), { alert, notify }), key);
    expect(calls.map((c) => c.path)).toEqual(["notify"]);
    expect(await kinds()).toEqual(["cycle:started", "triage:decision", "alert:pending", "alert:sent", "notify:pending", "notify:sent"]);
    cfg = randomUUID().slice(0, 8);
    await runCycle(deps(scripted({ triage: [{ decision: "decline", reasoning: "Noise.", suspectedCause: "" }] }), { alert }), key);
    expect(calls).toHaveLength(1);
    expect(await summaryAlert()).toBeUndefined();
  });

  it("records a failed or throwing delivery and the cycle goes on", async () => {
    const alert = async (): Promise<never> => {
      throw new Error(`boom ${SEEDED_SECRETS.github}`);
    };
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { alert }), key);
    expect(r).toMatchObject({ kind: "finished", state: "done" });
    expect(await summaryAlert()).toMatchObject({ state: "failed", reason: "notifier-error" });
    expect(JSON.stringify(await events())).not.toContain(SEEDED_SECRETS.github);
  });

  it("sends nothing in a dry run, and the record says so", async () => {
    const { calls, alert } = recorder();
    cfgOver = { dryRun: true };
    await runCycle(deps(scripted({ triage: [notifyDecision] }), { alert }), key);
    expect(calls).toHaveLength(0);
    expect(await summaryAlert()).toEqual({ state: "dry-run" });
  });

  it("does not send again once recorded sent or failed, and sends again after a crash left it pending", async () => {
    const { calls, alert } = recorder();
    const outcomes: Array<[unknown, number]> = [[{ state: "sent", attempts: 1 }, 0], [{ state: "failed", attempts: 3, reason: "http-500" }, 0], [{ state: "pending", attempts: 0 }, 1]];
    for (const [prior, expectedCalls] of outcomes) {
      cfg = randomUUID().slice(0, 8);
      calls.length = 0;
      expect(await runCycle(deps(scripted({ triage: [new Error("boom")] }), { alert }), key)).toMatchObject({ kind: "released" });
      await db.collection(`cycles_${cfg}`).doc("inc1_r0").update({ "summary.alert": prior });
      await runCycle(deps(scripted({ triage: [notifyDecision] }), { alert }), key);
      expect(calls, JSON.stringify(prior)).toHaveLength(expectedCalls);
    }
  });
});

describe("runCycle: a patch unfit to verify goes to a person, not round again (#137)", () => {
  it.each([
    ["patch-malformed", fixOf("not a diff at all")],
    ["patch-contains-secret-shape", fixOf(`${GOOD_PATCH}+const k = "${SEEDED_SECRETS.stripe}";\n`)],
  ])("%s ends the cycle waiting for a person, and a person is told", async (rule, answer) => {
    const calls: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 });
    const r = await runCycle(deps(scripted({ triage: [act], fix: [answer] }), { notify }), key);
    expect(r).toEqual({ kind: "finished", state: "waiting-human", outcome: rule });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "human", rule });
  });
});

describe("runCycle: the lease is kept alive through a long verify (#132)", () => {
  it("renews it before verify, and on every heartbeat the verifier beats while it waits", async () => {
    const expiries: number[] = [];
    const verify: LoopDeps["verify"] = async (req) => {
      expiries.push((await cycleDoc()).leaseExpiresAt.toMillis());
      // CI takes ten minutes, twice the lease; the verifier beats on each poll.
      for (let i = 0; i < 6; i++) {
        clock = new Date(clock.getTime() + 100_000);
        await req.heartbeat!();
      }
      expiries.push((await cycleDoc()).leaseExpiresAt.toMillis());
      return { status: "passed", rule: "command-passed", reason: "ok", patchSha256: createHash("sha256").update(req.patch).digest("hex"), baseRevision: req.baseRevision, changedFiles: ["greeting.txt"], exitCode: 0, output: "", durationMs: 1 };
    };
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { verify }), key);
    expect(r).toEqual({ kind: "finished", state: "done", outcome: "pr-opened" });
    expect(expiries).toEqual([t0.getTime() + 300_000, t0.getTime() + 600_000 + 300_000]);
  });

  it("makes the heartbeat throw once another worker has taken the cycle, and the run stops with nothing more written", async () => {
    const opened: PullRequestRequest[] = [];
    let threw = false;
    const verify: LoopDeps["verify"] = async (req) => {
      clock = new Date(clock.getTime() + 400_000);
      await acquireLease(db, testConfig({ cycleCollection: `cycles_${cfg}` }), key, "worker-b", clock);
      try {
        await req.heartbeat!();
      } catch (err) {
        threw = true;
        throw err;
      }
      throw new Error("not reached");
    };
    const r = await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { verify }, opened), key);
    expect(r).toEqual({ kind: "lease-lost" });
    expect(threw).toBe(true);
    expect(opened).toHaveLength(0);
    expect((await kinds()).filter((k) => k.startsWith("verify"))).toEqual([]);
  });
});

describe("runCycle: a pull request already opened for the cycle ends it (#134)", () => {
  const verifyMustNotRun: LoopDeps["verify"] = async () => {
    throw new Error("verify must not run");
  };

  it("stops at once when an earlier attempt recorded one", async () => {
    expect(await runCycle(deps(scripted({ triage: [new Error("boom")] })), key)).toMatchObject({ kind: "released" });
    await db.collection(`cycles_${cfg}`).doc("inc1_r0").update({ "summary.pr": { opened: true, number: 5, url: "https://github.com/acme/shop/pull/5", patchSha256: "abc" } });
    const model = scripted({ triage: [act] });
    const r = await runCycle(deps(model, { verify: verifyMustNotRun }), key);
    expect(r).toEqual({ kind: "finished", state: "done", outcome: "pr-opened" });
    expect(model.calls).toHaveLength(0);
    expect((await cycleDoc()).summary.pr).toEqual({ opened: true, number: 5, url: "https://github.com/acme/shop/pull/5", patchSha256: "abc" });
  });

  it("stops at once when the opener finds one an earlier attempt opened but never recorded", async () => {
    const asked: string[] = [];
    const findPullRequest = async (id: string) => (asked.push(id), { number: 6, url: "https://github.com/acme/shop/pull/6" });
    const model = scripted({ triage: [act] });
    const r = await runCycle(deps(model, { verify: verifyMustNotRun, findPullRequest }), key);
    expect(r).toEqual({ kind: "finished", state: "done", outcome: "pr-opened" });
    expect(asked).toEqual(["inc1_r0"]);
    expect(model.calls).toHaveLength(0);
    expect(await kinds()).toEqual(["cycle:started", "pr:opened"]);
  });

  it("goes on as usual when there is none, and does not look in a dry run", async () => {
    const asked: string[] = [];
    const findPullRequest = async (id: string) => (asked.push(id), null);
    expect(await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { findPullRequest }), key)).toMatchObject({ state: "done" });
    expect(asked).toEqual(["inc1_r0"]);
    cfg = randomUUID().slice(0, 8);
    cfgOver = { dryRun: true };
    expect(await runCycle(deps(scripted({ triage: [act], fix: [fixOf(GOOD_PATCH)], review: [held] }), { findPullRequest }), key)).toMatchObject({ outcome: "dry-run" });
    expect(asked).toHaveLength(1);
  });
});

describe("runCycle: a cycle given up on is not given up silently (#137)", () => {
  it("tells a person once when the deadline passes, with what the store knows of the incident", async () => {
    cfgOver = { cycleDeadlineMinutes: 10, incidentCollection: `incidents_${cfg}` };
    await db.collection(`incidents_${cfg}`).doc("inc1").set({ functionName: "orders-createOrder", service: "orders", errorType: "DatabaseError", occurrenceCount: 42 });
    const calls: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 });
    const d = deps(scripted({}), { notify });
    await acquireLease(db, d.config, key, "worker-b", clock);
    clock = new Date(t0.getTime() + 601_000);
    expect(await runCycle(d, key)).toEqual({ kind: "not-acquired", reason: "deadline-passed" });
    expect(await runCycle(d, key)).toEqual({ kind: "not-acquired", reason: "closed" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cycleId: "inc1_r0", functionName: "orders-createOrder", occurrenceCount: 42, path: "human", rule: "deadline-passed" });
    expect((await cycleDoc()).summary.notify).toEqual({ state: "sent", attempts: 1 });
  });

  it("tells a person when the attempts run out, and records a failed delivery", async () => {
    const calls: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (calls.push(req), { state: "failed" as const, attempts: 3, reason: "http-500" });
    const d = deps(scripted({ triage: [new Error("boom")] }), { notify });
    for (let i = 0; i < 3; i++) expect(await runCycle(d, key)).toMatchObject({ kind: "released" });
    expect(await runCycle(d, key)).toEqual({ kind: "not-acquired", reason: "retries-exhausted" });
    expect(calls).toHaveLength(1);
    // The incident is not in the store here: unknown, and no count rather than zero.
    expect(calls[0]).toMatchObject({ rule: "retries-exhausted", functionName: "unknown function", occurrenceCount: null });
    expect((await cycleDoc()).summary.notify).toEqual({ state: "failed", attempts: 3, reason: "http-500" });
  });

  it("sends nothing in a dry run, and the record says so", async () => {
    cfgOver = { dryRun: true };
    const calls: NotifyRequest[] = [];
    const notify = async (req: NotifyRequest) => (calls.push(req), { state: "sent" as const, attempts: 1 });
    const d = deps(scripted({ triage: [new Error("boom")] }), { notify });
    for (let i = 0; i < 3; i++) await runCycle(d, key);
    expect(await runCycle(d, key)).toEqual({ kind: "not-acquired", reason: "retries-exhausted" });
    expect(calls).toHaveLength(0);
    expect((await cycleDoc()).summary.notify).toEqual({ state: "dry-run" });
  });
});

describe("runCycle: a declined incident is reconsidered on new evidence (#8)", () => {
  const policy = { reconsiderCooldownMinutes: 30, reconsiderMaxPerDay: 3, reconsiderBurstOccurrences: 20 };
  const incidents = () => `incidents_${cfg}`;
  const stored = (over: Record<string, unknown> = {}) =>
    db.collection(incidents()).doc("inc1").set({ environment: "demo", status: "new", occurrenceCount: 42, errorType: "DatabaseError", lastOccurredAt: t0, ...over });
  const later = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  const decline = { decision: "decline", reasoning: "A one-off.", suspectedCause: "" };

  it("isolated transient -> sustained burst: declined once, untouched by a replay, then triaged again into one pull request", async () => {
    cfgOver = { incidentCollection: incidents() };
    await stored();
    const opened: PullRequestRequest[] = [];
    const model = scripted({ triage: [decline, act], fix: [fixOf(GOOD_PATCH)], review: [held] });
    const d = deps(model, { reconsider: policy }, opened);

    expect(await runCycle(d, key)).toEqual({ kind: "finished", state: "declined", outcome: "model-decline" });
    expect((await cycleDoc()).decision).toMatchObject({ rule: "model-decline", reason: "A one-off.", occurrenceCount: 42, counterCount: 42, counterWindow: "24h", errorType: "DatabaseError", causeClass: expect.any(String) });

    // The same logs read again, after the cooldown: no new evidence, no model call, still declined.
    clock = later(45);
    expect(await runCycle(d, key)).toEqual({ kind: "not-acquired", reason: "closed" });
    expect(await selectCandidates(db, testConfig({ environment: "demo", cycleCollection: `cycles_${cfg}`, incidentCollection: incidents() }), 5, { reconsider: policy, now: clock })).toEqual([]);
    expect(model.count("triage")).toBe(1);

    // A burst since the decline: selected, and the same cycle is triaged again.
    await stored({ occurrenceCount: 90 });
    expect(await selectCandidates(db, testConfig({ environment: "demo", cycleCollection: `cycles_${cfg}`, incidentCollection: incidents() }), 5, { reconsider: policy, now: clock })).toEqual([{ incidentId: "inc1", recurrence: 0, reconsider: "burst" }]);
    expect(await runCycle(d, key)).toEqual({ kind: "finished", state: "done", outcome: "pr-opened" });
    expect(model.count("triage")).toBe(2);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.cycleId).toBe("inc1_r0");
    const k = await kinds();
    expect(k.slice(0, 3)).toEqual(["cycle:started", "triage:decision", "cycle:reconsidered"]);
    expect(k.filter((x) => x === "pr:opened")).toHaveLength(1);
    const c = await cycleDoc();
    expect(c).toMatchObject({ state: "done", path: "pr", reconsiderCount: 1, reconsideredBecause: "burst" });
    expect(c.history[0]).toMatchObject({ rule: "model-decline", occurrenceCount: 42 });
    expect(c.summary.triage).toMatchObject({ decision: "act" });

    // A done cycle is never reconsidered: no second pull request for the recurrence.
    await stored({ occurrenceCount: 500, retriageRequestedAt: later(50) });
    clock = later(120);
    expect(await runCycle(d, key)).toEqual({ kind: "not-acquired", reason: "closed" });
    expect(opened).toHaveLength(1);
  });

  it("a new structural cause after the cooldown is new evidence too", async () => {
    cfgOver = { incidentCollection: incidents() };
    await stored();
    const model = scripted({ triage: [decline, decline] });
    const d = deps(model, { reconsider: policy });
    await runCycle(d, key);
    clock = later(31);
    expect(await runCycle(d, key)).toEqual({ kind: "not-acquired", reason: "closed" });
    await stored({ errorCode: "FAILED_PRECONDITION" });
    expect(await runCycle(d, key)).toEqual({ kind: "finished", state: "declined", outcome: "model-decline" });
    expect(model.count("triage")).toBe(2);
    expect(await cycleDoc()).toMatchObject({ reconsideredBecause: "cause", reconsiderCount: 1 });
  });

  it("an operator who ignores the incident during the reconsideration settles it", async () => {
    cfgOver = { incidentCollection: incidents() };
    await stored();
    const model = scripted({ triage: [decline, act], fix: [fixOf(GOOD_PATCH)], review: [held] });
    const d = deps(model, { reconsider: policy });
    await runCycle(d, key);
    await stored({ retriageRequestedAt: later(1) });
    clock = later(2);
    // The request is honoured at acquire; the operator then ignores it before the first stage.
    status = "ignored";
    expect(await runCycle(d, key)).toEqual({ kind: "finished", state: "declined", outcome: "incident-ignored" });
    expect(model.count("triage")).toBe(1);
  });
});
