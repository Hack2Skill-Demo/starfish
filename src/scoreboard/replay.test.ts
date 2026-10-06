/**
 * The replay harness over the SYNTHETIC corpus in fixtures/replay-synthetic, with a stub model: real files, a real
 * `git apply` and real `node` processes for the gate and the evaluator, never a real model. Nothing here is a result.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PATCH_EXCLUDED_PATHS } from "../config.js";
import { FIX_SYSTEM } from "../agent/fixer.js";
import { REVIEW_SYSTEM } from "../agent/reviewer.js";
import { TRIAGE_SYSTEM, type AskJson } from "../agent/triage.js";
import { caseHashOf, CorpusError, loadCorpus } from "./corpus.js";
import { checkReproduces, evaluatePatch } from "./evaluate.js";
import { checkCorpus, ReplayError, runReplay, type ReplayAgentConfig } from "./replay.js";
import { metricsFor } from "./aggregate.js";
import { parseRun } from "./results.js";

const FIXTURE = new URL("../../fixtures/replay-synthetic", import.meta.url).pathname;
const GOOD = readFileSync(join(FIXTURE, "stub-model/good-fix.diff"), "utf8");
const BAD = readFileSync(join(FIXTURE, "patches/bad-drops-qty.diff"), "utf8");

const cfg: ReplayAgentConfig = {
  model: "stub-model",
  location: "nowhere",
  verifyTimeoutSeconds: 30,
  patchExcludedPaths: DEFAULT_PATCH_EXCLUDED_PATHS,
  reviewRequired: true,
  modelCallBudget: 6,
};

interface StubAnswers {
  triage?: (prompt: string) => unknown;
  fix?: (prompt: string) => unknown;
  review?: (prompt: string) => unknown;
}

/** A model that answers by stage, and records what it was shown. */
function stubModel(answers: StubAnswers = {}) {
  const prompts: string[] = [];
  const ask: AskJson = async <T,>(prompt: string, system: string): Promise<T> => {
    prompts.push(prompt);
    if (system === TRIAGE_SYSTEM) {
      if (answers.triage) return answers.triage(prompt) as T;
      const decision = prompt.includes("health-probe") ? "decline" : prompt.includes("mail-sendReceipt") ? "notify" : "act";
      return { decision, reasoning: "stub", suspectedCause: decision === "decline" ? null : "stub cause" } as T;
    }
    if (system === FIX_SYSTEM) {
      if (answers.fix) return answers.fix(prompt) as T;
      return { rootCause: "The loop starts at 1.", patch: GOOD, testAdded: false, risk: "low", rejectedAlternatives: [] } as T;
    }
    if (system === REVIEW_SYSTEM) {
      if (answers.review) return answers.review(prompt) as T;
      const bad = prompt.includes("total += items[i].price;");
      return { attacks: [{ attack: "two items with quantities", outcome: bad ? "broken" : "held", detail: bad ? "drops qty" : "ok" }] } as T;
    }
    throw new Error("unexpected stage");
  };
  return { ask, prompts };
}

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
/** A writable copy of the synthetic corpus, for the tests that change it. */
function corpusCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "replay-corpus-"));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const run = (ask: AskJson, corpusDir = FIXTURE, extra: Partial<Parameters<typeof runReplay>[0]> = {}) =>
  runReplay({ corpus: loadCorpus(corpusDir), cfg, ask, runId: "test-run", starfishRevision: "test", caseTimeoutMs: 60_000, now: () => new Date("2026-10-06T00:00:00Z"), ...extra });

describe("runReplay over the synthetic corpus", { timeout: 60_000 }, () => {
  it("writes a results file the scoreboard's strict parser accepts, with every case's outcome", async () => {
    const result = await run(stubModel().ask);
    expect(parseRun(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(result.model).toBe("stub-model");
    expect(result.corpusVersion).toBe("synthetic-test-corpus-1");
    expect(result.configuration).toMatchObject({ harness: "replay", dryRun: true, syntheticCorpus: true, revisionBudget: 1 });
    const byId = Object.fromEntries(result.cases.map((c) => [c.caseId, c]));
    expect(byId["order-total"]!.outcome).toMatchObject({ status: "completed", triage: "act", openedPr: true, fixPassed: true });
    expect(byId["order-total"]!.caseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(byId["probe-noise"]!.outcome).toMatchObject({ status: "completed", triage: "decline", openedPr: false });
    expect(byId["mail-quota"]!.outcome).toMatchObject({ status: "completed", triage: "notify", openedPr: false });
    expect(byId["order-total-planted"]!.outcome).toMatchObject({ status: "completed", reviewerBlocked: true });
    for (const c of result.cases) expect(c.outcome.latencyMs).toBeGreaterThanOrEqual(0);
    // Cost is not measured, so it is absent: never a zero.
    for (const c of result.cases) expect(c.outcome.costUsd).toBeUndefined();
    expect(metricsFor(result, "held-out").patchPassRate).toEqual({ passed: 1, of: 1 });
  });

  it("never shows the fixer or the reviewer the private evaluator", async () => {
    const model = stubModel();
    await run(model.ask);
    for (const p of model.prompts) {
      expect(p).not.toContain("order-total.check");
      expect(p).not.toContain("expected 11");
    }
  });

  it("scores a patch that passes the target's own test but not the evaluator as a failed fix", async () => {
    // Plausible and green on the visible test, wrong on the hidden one: printing a diff is not a pass.
    const { ask } = stubModel({ fix: () => ({ rootCause: "x", patch: BAD, testAdded: false, risk: "low", rejectedAlternatives: [] }), review: () => ({ attacks: [{ attack: "a", outcome: "held", detail: "d" }] }) });
    const result = await run(ask);
    expect(result.cases.find((c) => c.caseId === "order-total")!.outcome).toMatchObject({ status: "completed", openedPr: true, fixPassed: false });
  });

  it("revises once after a blocking review, then gives up without crediting a fix", async () => {
    let fixes = 0;
    const { ask } = stubModel({
      fix: () => (fixes++, { rootCause: "x", patch: GOOD, testAdded: false, risk: "low", rejectedAlternatives: [] }),
      review: () => ({ attacks: [{ attack: "a", outcome: "broken", detail: "d" }] }),
    });
    const result = await run(ask);
    expect(fixes).toBe(2);
    expect(result.cases.find((c) => c.caseId === "order-total")!.outcome).toMatchObject({ status: "completed", openedPr: false, fixPassed: false });
  });

  it("leaves fixPassed out when the fixer declines: no fix was proposed", async () => {
    const { ask } = stubModel({ fix: () => ({ rootCause: "not enough source", patch: "", testAdded: false, risk: "", rejectedAlternatives: [] }) });
    const outcome = (await run(ask)).cases.find((c) => c.caseId === "order-total")!.outcome;
    expect(outcome).toMatchObject({ status: "completed", triage: "act", openedPr: false });
    expect(outcome.fixPassed).toBeUndefined();
  });

  it("records a failed model call as an error that claims no result, and carries on with the other cases", async () => {
    const { ask } = stubModel({
      triage: (p) => {
        if (p.includes("checkout-placeOrder")) throw new Error("quota");
        return { decision: "decline", reasoning: "r", suspectedCause: null };
      },
    });
    const result = await run(ask);
    const outcome = result.cases.find((c) => c.caseId === "order-total")!.outcome;
    expect(outcome.status).toBe("error");
    expect(outcome.fixPassed).toBeUndefined();
    expect(outcome.openedPr).toBeUndefined();
    expect(result.cases.find((c) => c.caseId === "probe-noise")!.outcome.status).toBe("completed");
    expect(metricsFor(result, "held-out").patchPassRate).toEqual({ passed: 0, of: 1 });
  });

  it("records a review that cannot be had as an error, not as a catch", async () => {
    const { ask } = stubModel({ review: () => ({ attacks: [] }) });
    const result = await run(ask);
    expect(result.cases.find((c) => c.caseId === "order-total-planted")!.outcome.status).toBe("error");
  });

  it("records a case over its time limit as a timeout", async () => {
    const { ask } = stubModel({ triage: () => new Promise(() => undefined) });
    const result = await run(ask, FIXTURE, { caseTimeoutMs: 50 });
    const outcome = result.cases.find((c) => c.caseId === "probe-noise")!.outcome;
    expect(outcome.status).toBe("timeout");
    expect(outcome.triage).toBeUndefined();
  });

  it("refuses to run, and asks the model nothing, when a held-out case changed since it was frozen", async () => {
    const dir = corpusCopy();
    writeFileSync(join(dir, "incidents/order-total.json"), readFileSync(join(dir, "incidents/order-total.json"), "utf8").replace("37", "38"));
    const model = stubModel();
    await expect(run(model.ask, dir)).rejects.toThrow(ReplayError);
    await expect(run(model.ask, dir)).rejects.toThrow(/no longer hashes to its frozen caseHash/);
    expect(model.prompts).toHaveLength(0);
  });
});

describe("checkCorpus", { timeout: 60_000 }, () => {
  it("passes the committed synthetic corpus", async () => {
    expect(await checkCorpus(loadCorpus(FIXTURE), cfg)).toEqual([]);
  });

  it("refuses an evaluator that passes before any fix: the defect must reproduce", async () => {
    const dir = corpusCopy();
    writeFileSync(join(dir, "evaluators/order-total/.evaluator/order-total.check.mjs"), "// passes always\n");
    const problems = await checkCorpus(loadCorpus(dir), cfg);
    expect(problems.join("\n")).toMatch(/order-total.*does not fail on the unpatched snapshot/);
    expect(problems.join("\n")).toMatch(/order-total-planted.*passes its evaluator, so it is not a bad patch/);
  });

  it("refuses a planted patch the target's own gate rejects", async () => {
    const dir = corpusCopy();
    writeFileSync(join(dir, "patches/bad-drops-qty.diff"), BAD.replace("-  for (let i = 1", "-  for (let j = 1"));
    expect((await checkCorpus(loadCorpus(dir), cfg)).join("\n")).toMatch(/planted patch does not pass the target's gate/);
  });

  it("refuses an evaluator file that shadows a snapshot file", async () => {
    const dir = corpusCopy();
    cpSync(join(dir, "snapshots/shop/src"), join(dir, "evaluators/order-total/src"), { recursive: true });
    expect((await checkCorpus(loadCorpus(dir), cfg)).join("\n")).toMatch(/also exists in the snapshot/);
  });
});

describe("the evaluator boundary", { timeout: 60_000 }, () => {
  const checkout = { repoDir: join(FIXTURE, "snapshots/shop"), evaluator: { dir: join(FIXTURE, "evaluators/order-total"), command: "node .evaluator/order-total.check.mjs" } };

  it("reproduces the defect before, and passes the real fix after", async () => {
    expect((await checkReproduces(checkout, cfg)).reproduces).toBe(true);
    expect((await evaluatePatch(checkout, GOOD, cfg)).passed).toBe(true);
    expect((await evaluatePatch(checkout, BAD, cfg)).passed).toBe(false);
  });

  it("refuses a patch that rewrites the evaluator to pass", async () => {
    const cheat = [
      "--- a/.evaluator/order-total.check.mjs",
      "+++ b/.evaluator/order-total.check.mjs",
      "@@ -1,8 +1 @@",
      ...readFileSync(join(checkout.evaluator.dir, ".evaluator/order-total.check.mjs"), "utf8").trimEnd().split("\n").map((l) => `-${l}`),
      "+// nothing to check",
      "",
    ].join("\n");
    const judged = await evaluatePatch(checkout, cheat, cfg);
    expect(judged.passed).toBe(false);
    expect(judged.result.rule).toBe("excluded-path");
  });

  it("refuses a patch that is not a diff, rather than repairing it", async () => {
    const judged = await evaluatePatch(checkout, "for (let i = 0; ...", cfg);
    expect(judged.passed).toBe(false);
    expect(judged.result.rule).toBe("patch-does-not-apply");
  });
});

describe("loadCorpus", () => {
  const withManifest = (mutate: (m: { cases: Record<string, unknown>[] } & Record<string, unknown>) => void): string => {
    const dir = corpusCopy();
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    mutate(m);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    return dir;
  };

  it.each([
    ["an index case", (m: { cases: Record<string, unknown>[] }) => (m.cases[1]!.path = "index"), /not run by the replay harness/],
    ["a path out of the corpus", (m: { cases: Record<string, unknown>[] }) => (m.cases[1]!.incident = "../../etc/passwd"), /stay inside the corpus|relative path/],
    ["an evaluator inside the snapshot", (m: { cases: Record<string, unknown>[] }) => (m.cases[0]!.evaluator = { dir: "snapshots/shop/test", command: "x" }), /outside the snapshot/],
    ["a code-fix with no evaluator", (m: { cases: Record<string, unknown>[] }) => delete m.cases[0]!.evaluator, /needs "repo", "verifyCommand" and "evaluator"/],
    ["a held-out case with no frozen hash", (m: { cases: Record<string, unknown>[] }) => delete m.cases[0]!.caseHash, /frozen with/],
    ["a bad patch with an expected triage", (m: { cases: Record<string, unknown>[] }) => (m.cases[3]!.expectedTriage = "act"), /no "expectedTriage"/],
    ["a corpus that does not say whether it is synthetic", (m: Record<string, unknown>) => delete m.synthetic, /"synthetic"/],
    ["a duplicate case id", (m: { cases: Record<string, unknown>[] }) => (m.cases[2]!.caseId = "probe-noise"), /duplicate/],
  ])("refuses %s", (_, mutate, message) => {
    const dir = withManifest(mutate as never);
    expect(() => loadCorpus(dir)).toThrow(CorpusError);
    expect(() => loadCorpus(dir)).toThrow(message);
  });

  it("hashes the files a case names, not only its manifest entry", async () => {
    const dir = corpusCopy();
    const before = await caseHashOf(loadCorpus(dir).cases[0]!);
    writeFileSync(join(dir, "snapshots/shop/test/visible.mjs"), "// changed\n");
    expect(await caseHashOf(loadCorpus(dir).cases[0]!)).not.toBe(before);
  });
});
