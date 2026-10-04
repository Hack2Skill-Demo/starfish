/**
 * One run of the agent job end to end: the real store (Firestore emulator), a real git remote on disk cloned by
 * the real checkout, the real verify gate where a command is allowed, and a scripted model. The only stubs are
 * the model and Cloud Logging. Run via `pnpm test:emulator`.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { jobSucceeded, runAgentJob, type AgentJobDeps } from "./job.js";
import { FIX_SYSTEM } from "./fixer.js";
import { TRIAGE_SYSTEM, type AskJson } from "./triage.js";
import { REVIEW_SYSTEM } from "./reviewer.js";
import { RuntimeConfigLoader } from "../runtimeSettings.js";
import type { RunGit } from "../integrations/githubPr.js";
import { testConfig } from "../testConfig.js";
import type { StarfishConfig } from "../config.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("job.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "job-emulator-tests");
const db: Firestore = getFirestore(app, "job-tests");
afterAll(() => deleteApp(app));

const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const GOOD_PATCH = '--- a/src/orders.ts\n+++ b/src/orders.ts\n@@ -1 +1 @@\n-const greeting = "old";\n+const greeting = "new";\n';

let scratch: string;
let tmp: string;
let remote: string;
let run: string;
let cfg: StarfishConfig;
let gitCalls: string[][];
beforeEach(() => {
  run = randomUUID().slice(0, 8);
  scratch = mkdtempSync(join(tmpdir(), "job-test-"));
  tmp = join(scratch, "tmp");
  mkdirSync(tmp);
  remote = join(scratch, "remote");
  mkdirSync(join(remote, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: remote, env: gitEnv });
  writeFileSync(join(remote, "src", "orders.ts"), 'const greeting = "old";\n');
  execFileSync("git", ["add", "-A"], { cwd: remote, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: remote, env: gitEnv });
  gitCalls = [];
  cfg = testConfig({
    environment: "demo",
    incidentCollection: `incidents_${run}`,
    cycleCollection: `cycles_${run}`,
    settingsCollection: `settings_${run}`,
    githubRepo: "acme/shop",
    githubRemoteUrl: `file://${remote}`,
    agentMaxCycles: 2,
  });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const ts = (minutesAgo: number) => Timestamp.fromMillis(Date.now() - minutesAgo * 60_000);
async function incident(id: string, over: Record<string, unknown> = {}) {
  await db.collection(cfg.incidentCollection).doc(id).set({
    environment: "demo",
    status: "new",
    functionName: "orders-createOrder",
    errorMessage: "boom",
    stackTrace: "Error: boom\n    at createOrder (/workspace/src/orders.ts:1:1)",
    occurrenceCount: 9,
    lastOccurredAt: ts(1),
    ...over,
  });
}
const cycle = async (id: string) => (await db.collection(cfg.cycleCollection).doc(id).get()).data();
const events = async (id: string) => (await db.collection(cfg.cycleCollection).doc(id).collection("events").orderBy("seq").get()).docs.map((d) => `${d.data().stage}:${d.data().type}`);

const logging = { getEntries: async () => [[{ metadata: { timestamp: new Date(), severity: "ERROR" }, data: { message: "boom" } }], null] as [unknown[], object | null] };

/** A model answering by stage; every call is counted. */
function scripted(answers: { triage?: unknown; fix?: unknown; review?: unknown }) {
  const calls: string[] = [];
  const prompts: Record<string, string> = {};
  const ask = (async (prompt: string, system: string) => {
    const stage = system === TRIAGE_SYSTEM ? "triage" : system === FIX_SYSTEM ? "fix" : system === REVIEW_SYSTEM ? "review" : "unknown";
    calls.push(stage);
    prompts[stage] = prompt;
    return answers[stage as keyof typeof answers];
  }) as AskJson;
  return { ask, calls, prompts };
}
const act = { decision: "act", reasoning: "A defect in the order code.", suspectedCause: "createOrder" };
const fix = { rootCause: "greeting is stale.", patch: GOOD_PATCH, testAdded: false, risk: "None.", rejectedAlternatives: [] };

const spyGit: RunGit = async (args, opts) => {
  gitCalls.push(args);
  return execFileSync("git", args, { cwd: opts.cwd, env: { ...opts.env, GIT_ALLOW_PROTOCOL: "file" }, encoding: "utf8" });
};

function deps(ask: AskJson, config: StarfishConfig = cfg, over: Partial<AgentJobDeps> = {}): AgentJobDeps {
  return { db, loader: new RuntimeConfigLoader(config), logging, childEnv, ask, runGit: spyGit, tmpDir: tmp, ...over };
}

describe("runAgentJob", () => {
  it("does nothing, and clones nothing, when no incident needs a cycle", async () => {
    await incident("resolved", { status: "resolved" });
    const r = await runAgentJob(deps(scripted({}).ask));
    expect(r).toMatchObject({ kind: "ran", summary: { considered: 0, ran: 0 } });
    expect(gitCalls).toEqual([]);
    expect(jobSucceeded(r)).toBe(true);
  });

  it("declines noise and settles the cycle, with its events in the store, and leaves no checkout behind", async () => {
    await incident("noise");
    const model = scripted({ triage: { decision: "decline", reasoning: "A one-off.", suspectedCause: null } });
    const r = await runAgentJob(deps(model.ask));
    expect(r).toMatchObject({ kind: "ran", summary: { considered: 1, ran: 1, aborted: false, errors: [] } });
    expect(await cycle("noise_r0")).toMatchObject({ state: "declined", outcome: "model-decline" });
    expect(await events("noise_r0")).toEqual(["cycle:started", "triage:decision"]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("hands an incident it cannot prove a fix for to a person, without a second draft and without opening anything", async () => {
    await incident("orders");
    const model = scripted({ triage: act, fix });
    const r = await runAgentJob(deps(model.ask)); // the default config: no verify command
    expect(r).toMatchObject({ kind: "ran" });
    expect(await cycle("orders_r0")).toMatchObject({ state: "waiting-human", outcome: "verify-no-verify-command", path: "human" });
    expect(await events("orders_r0")).toEqual(["cycle:started", "triage:decision", "fix:proposed", "verify:rejected"]);
    expect(model.calls).toEqual(["triage", "fix"]);
    // Triage was shown the counter-check taken from Logging now (the ingest stores none), and the fixer the
    // file the stack names, read from the checkout.
    expect(model.prompts.triage).toContain("log counter-check: 1 error entries");
    expect(model.prompts.fix).toContain("src/orders.ts");
    expect(model.prompts.fix).toContain('const greeting = "old";');
    expect(gitCalls[0]).toEqual(expect.arrayContaining(["clone", "--depth", "1"]));
  });

  it("works one checkout for the whole run, at most agentMaxCycles cycles, newest activity first", async () => {
    await incident("a", { lastOccurredAt: ts(30) });
    await incident("b", { lastOccurredAt: ts(20) });
    await incident("c", { lastOccurredAt: ts(10) });
    const model = scripted({ triage: { decision: "decline", reasoning: "Noise.", suspectedCause: null } });
    const r = await runAgentJob(deps(model.ask));
    expect(r).toMatchObject({ kind: "ran", summary: { considered: 2, ran: 2 } });
    expect(gitCalls.filter((c) => c[0] === "clone")).toHaveLength(1);
    expect((await cycle("c_r0"))?.state).toBe("declined");
    expect((await cycle("b_r0"))?.state).toBe("declined");
    expect(await cycle("a_r0")).toBeUndefined();
    // The next run takes the one left, and not the two that are settled.
    const again = await runAgentJob(deps(model.ask));
    expect(again).toMatchObject({ kind: "ran", summary: { considered: 1, ran: 1 } });
    expect((await cycle("a_r0"))?.state).toBe("declined");
  });

  it("REFUSES to start with a verify command and no allowance: the job holds credentials, the gate is not a sandbox", async () => {
    await incident("orders");
    const r = await runAgentJob(deps(scripted({}).ask, { ...cfg, verifyCommand: "pnpm test" }));
    expect(r).toMatchObject({ kind: "refused" });
    expect((r as { reason: string }).reason).toContain("not a sandbox");
    expect(jobSucceeded(r)).toBe(false);
    expect(gitCalls).toEqual([]);
    expect(await cycle("orders_r0")).toBeUndefined();
  });

  it("refuses even when the command arrives from the settings document rather than the environment", async () => {
    // The settings schema has no verify command, but the refusal is on the resolved config, whatever its source.
    await incident("orders");
    const r = await runAgentJob(deps(scripted({}).ask, { ...cfg, verifyCommand: "true", agentAllowLocalVerify: false }));
    expect(r.kind).toBe("refused");
  });

  it("with the allowance, runs the real gate against the real checkout and ends a dry run waiting for a person", async () => {
    await incident("orders");
    const model = scripted({ triage: act, fix, review: { attacks: [{ attack: "Empty order", outcome: "held", detail: "Handled." }] } });
    const local = { ...cfg, verifyCommand: "grep -q new src/orders.ts", agentAllowLocalVerify: true, verifyTimeoutSeconds: 20 };
    const r = await runAgentJob(deps(model.ask, local));
    expect(r).toMatchObject({ kind: "ran", summary: { errors: [] } });
    expect(await cycle("orders_r0")).toMatchObject({ state: "waiting-human", outcome: "dry-run", path: "draft" });
    expect(await events("orders_r0")).toEqual(["cycle:started", "triage:decision", "fix:proposed", "verify:passed", "review:approve", "pr:dry-run"]);
  });

  it("stops without cloning when an admin has switched automation off, and that is not a failure", async () => {
    await incident("orders");
    const r = await runAgentJob(deps(scripted({}).ask, { ...cfg, automationEnabled: false }));
    expect(r).toMatchObject({ kind: "stopped" });
    expect(jobSucceeded(r)).toBe(true);
    expect(gitCalls).toEqual([]);
    expect(await cycle("orders_r0")).toBeUndefined();
  });

  it("does not act when the repository is not configured", async () => {
    await incident("orders");
    const r = await runAgentJob(deps(scripted({}).ask, { ...cfg, githubRepo: "" }));
    expect(r).toMatchObject({ kind: "skipped" });
    expect(jobSucceeded(r)).toBe(false);
    expect(gitCalls).toEqual([]);
  });

  it("records a clone that fails as a failed run, and stops after a few in a row", async () => {
    for (const id of ["a", "b", "c", "d"]) await incident(id);
    const broken: RunGit = async () => {
      throw new Error("no route to github");
    };
    const r = await runAgentJob(deps(scripted({}).ask, { ...cfg, agentMaxCycles: 4 }, { runGit: broken }));
    expect(r).toMatchObject({ kind: "ran", summary: { aborted: true } });
    expect((r as { summary: { errors: unknown[] } }).summary.errors).toHaveLength(3);
    expect(jobSucceeded(r)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });
});
