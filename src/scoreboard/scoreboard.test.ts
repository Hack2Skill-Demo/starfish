import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { metricsFor } from "./aggregate.js";
import { loadRuns } from "./load.js";
import { formatRatio, renderScoreboard, SMALL_SAMPLE } from "./render.js";
import { ResultsError, parseRun, type ScoreboardRun } from "./results.js";

const HASH = "a".repeat(64);

function raw(cases: unknown[] = [], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    runId: "r1",
    corpusVersion: "c1",
    appRevision: "app-abc",
    starfishRevision: "sf-def",
    model: "gemini-test",
    ranAt: "2026-10-11T09:00:00Z",
    configuration: { dryRun: true, retries: 1 },
    cases,
    ...over,
  };
}

const done = (extra: Record<string, unknown> = {}) => ({ status: "completed", ...extra });

const CASES = [
  { caseId: "fix-1", split: "held-out", path: "code-fix", expectedTriage: "act", caseHash: HASH, outcome: done({ triage: "act", fixPassed: true, openedPr: true, costUsd: 0.02, latencyMs: 40_000 }) },
  { caseId: "fix-2", split: "held-out", path: "code-fix", expectedTriage: "act", caseHash: HASH, outcome: done({ triage: "act", fixPassed: false, costUsd: 0.04, latencyMs: 60_000 }) },
  { caseId: "fix-3", split: "tuning", path: "code-fix", expectedTriage: "act", outcome: { status: "timeout", costUsd: 0.06, latencyMs: 300_000 } },
  { caseId: "idx-1", split: "tuning", path: "index", expectedTriage: "act", outcome: done({ triage: "act", fixPassed: true }) },
  { caseId: "dec-1", split: "held-out", path: "decline", expectedTriage: "decline", caseHash: HASH, outcome: done({ triage: "decline", latencyMs: 2_000 }) },
  { caseId: "dec-2", split: "tuning", path: "decline", expectedTriage: "decline", outcome: done({ triage: "decline", openedPr: true }) },
  { caseId: "not-1", split: "tuning", path: "notify", expectedTriage: "notify", outcome: done({ triage: "act" }) },
  { caseId: "bad-1", split: "held-out", path: "bad-patch", caseHash: HASH, outcome: done({ reviewerBlocked: true }) },
  { caseId: "bad-2", split: "tuning", path: "bad-patch", outcome: { status: "error", costUsd: 0.01 } },
];

describe("parseRun", () => {
  it("accepts a well-formed run", () => {
    const run = parseRun(raw(CASES));
    expect(run.cases).toHaveLength(9);
    expect(run.configuration).toEqual({ dryRun: true, retries: 1 });
  });

  const bad: [string, () => unknown, RegExp][] = [
    ["not an object", () => "x", /must be a JSON object/],
    ["wrong version", () => raw(CASES, { version: 2 }), /"version" must be 1/],
    ["empty cases", () => raw([]), /non-empty array/],
    ["no model", () => raw(CASES, { model: "" }), /"model"/],
    ["ranAt not UTC ISO", () => raw(CASES, { ranAt: "yesterday" }), /ISO 8601 UTC/],
    ["ranAt with an offset", () => raw(CASES, { ranAt: "2026-10-11T09:00:00+02:00" }), /ISO 8601 UTC/],
    ["configuration value of the wrong kind", () => raw(CASES, { configuration: { a: [1] } }), /configuration "a"/],
    ["duplicate case id", () => raw([CASES[0], CASES[0]]), /duplicate caseId "fix-1"/],
    ["unknown path", () => raw([{ ...CASES[0], path: "magic" }]), /"path" must be one of/],
    ["unknown split", () => raw([{ ...CASES[0], split: "dev" }]), /"split" must be one of/],
    ["held-out without a hash", () => raw([{ ...CASES[0], caseHash: undefined }]), /held-out case needs "caseHash"/],
    ["a hash that is not sha256", () => raw([{ ...CASES[0], caseHash: "abc" }]), /sha256/],
    ["no expected triage on a fix", () => raw([{ ...CASES[0], expectedTriage: undefined }]), /"expectedTriage" is required/],
    ["a negative cost", () => raw([{ ...CASES[0], outcome: done({ costUsd: -1 }) }]), /"costUsd"/],
    ["a NaN latency", () => raw([{ ...CASES[0], outcome: done({ latencyMs: Number.NaN }) }]), /"latencyMs"/],
    ["a string boolean", () => raw([{ ...CASES[0], outcome: done({ fixPassed: "yes" }) }]), /"fixPassed" must be true or false/],
    ["a timeout claiming a pass", () => raw([{ ...CASES[2], outcome: { status: "timeout", fixPassed: true } }]), /cannot claim a result/],
    ["an unknown status", () => raw([{ ...CASES[0], outcome: { status: "skipped" } }]), /"status" must be one of/],
  ];
  for (const [name, make, message] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => parseRun(make())).toThrow(ResultsError);
      expect(() => parseRun(make())).toThrow(message);
    });
  }

  it("lets a planted bad patch go without an expected triage", () => {
    expect(() => parseRun(raw([CASES[7]]))).not.toThrow();
  });
});

describe("metricsFor", () => {
  const run = parseRun(raw(CASES));
  const held = metricsFor(run, "held-out");
  const tuning = metricsFor(run, "tuning");

  it("keeps the splits apart", () => {
    expect(held.cases).toBe(4);
    expect(tuning.cases).toBe(5);
  });

  it("counts triage over every case with an expectation, matching on the call", () => {
    expect(held.triageAccuracy).toEqual({ passed: 3, of: 3 }); // fix-1, fix-2, dec-1; the bad patch has none
    expect(tuning.triageAccuracy).toEqual({ passed: 2, of: 4 }); // idx-1, dec-2 right; fix-3 timed out, not-1 wrong
  });

  it("counts a timeout and an error against the agent rather than leaving them out", () => {
    expect(tuning.errors).toBe(1);
    expect(tuning.timeouts).toBe(1);
    expect(tuning.patchPassRate).toEqual({ passed: 0, of: 1 }); // fix-3 timed out: in the denominator
    expect(tuning.reviewerCatchRate).toEqual({ passed: 0, of: 1 }); // bad-2 errored
  });

  it("does not count a decline that opened a pull request", () => {
    expect(tuning.correctDeclines).toEqual({ passed: 0, of: 1 });
    expect(held.correctDeclines).toEqual({ passed: 1, of: 1 });
  });

  it("reports the patch pass rate and the index heal apart", () => {
    expect(held.patchPassRate).toEqual({ passed: 1, of: 2 });
    expect(held.indexHeal).toEqual({ passed: 0, of: 0 });
    expect(tuning.indexHeal).toEqual({ passed: 1, of: 1 });
  });

  it("measures only cases that recorded the value: a missing one is not a zero", () => {
    expect(held.costUsd).toEqual({ n: 2, mean: 0.03, median: expect.closeTo(0.03, 6) });
    expect(held.latencyMs.n).toBe(3);
    expect(held.latencyMs.median).toBe(40_000);
    expect(held.detectionToPrMs).toEqual({ n: 0 });
  });

  // #141: a timed-out run is the slowest, and an errored one still spent; leaving them out made both figures read low.
  it("counts the cost and latency of a case that errored or timed out", () => {
    expect(tuning.costUsd).toEqual({ n: 2, mean: expect.closeTo(0.035, 6), median: expect.closeTo(0.035, 6) }); // fix-3 + bad-2
    expect(tuning.latencyMs).toEqual({ n: 1, mean: 300_000, median: 300_000 }); // fix-3, which timed out
  });

  it("measures detection to pull request over completed cases only", () => {
    const m = metricsFor(parseRun(raw([{ ...CASES[2], outcome: { status: "timeout", detectionToPrMs: 1_000 } }])), "tuning");
    expect(m.detectionToPrMs).toEqual({ n: 0 });
  });
});

describe("renderScoreboard", () => {
  const run: ScoreboardRun = parseRun(raw(CASES));

  it("says so when there are no runs, and shows no table", () => {
    const text = renderScoreboard([]);
    expect(text).toContain("No runs recorded yet.");
    expect(text).not.toContain("| Metric |");
  });

  it("shows the date, the model, numerators and denominators, and the failures", () => {
    const text = renderScoreboard([run]);
    expect(text).toContain("2026-10-11 · gemini-test · run r1");
    expect(text).toContain("| Patch pass rate (code fixes) | 1/2 (50%) |");
    expect(text).toContain("1 errored and 1 timed out: counted as failures above, not left out.");
    expect(text).toContain("Held-out cases (4)");
    expect(text.indexOf("Held-out cases")).toBeLessThan(text.indexOf("Tuning cases"));
  });

  it("calls a small sample a small sample", () => {
    expect(renderScoreboard([run])).toContain(`Small sample: fewer than ${SMALL_SAMPLE} cases`);
  });

  it("is deterministic, and lists the newest run first", () => {
    const older = parseRun(raw(CASES, { runId: "r0", ranAt: "2026-10-01T00:00:00Z" }));
    const text = renderScoreboard([older, run]);
    expect(text).toBe(renderScoreboard([run, older]));
    expect(text.indexOf("run r1")).toBeLessThan(text.indexOf("run r0"));
  });

  it("formats a ratio with no cases as such, never as 0%", () => {
    expect(formatRatio({ passed: 0, of: 0 })).toBe("n/a (no cases)");
    expect(formatRatio({ passed: 1, of: 3 })).toBe("1/3 (33%)");
  });
});

describe("loadRuns", () => {
  it("returns nothing for a directory that does not exist", () => {
    expect(loadRuns(join(tmpdir(), "no-such-scoreboard-dir"))).toEqual([]);
  });

  it("fails the whole load on one bad file, naming it, and on a reused run id", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify(raw(CASES)));
    writeFileSync(join(dir, "b.json"), JSON.stringify(raw(CASES)));
    expect(() => loadRuns(dir)).toThrow(/b\.json: runId "r1" is already used/);
    writeFileSync(join(dir, "b.json"), JSON.stringify(raw(CASES, { model: "" })));
    expect(() => loadRuns(dir)).toThrow(/b\.json: results: "model"/);
    writeFileSync(join(dir, "b.json"), "{not json");
    expect(() => loadRuns(dir)).toThrow(/b\.json/);
  });
});
