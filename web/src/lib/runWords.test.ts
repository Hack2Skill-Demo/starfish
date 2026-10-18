import { describe, expect, it } from "vitest";
import { buildWaterfall, parseCycle, type CycleRow, type EventRow } from "./runsModel";
import { runInWords, sentenceFor, stopSentence, type WordStep } from "./runWords";

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const HOUR = 3_600_000;

const cycle = (over: Partial<CycleRow> = {}): CycleRow => ({
  ...(parseCycle("inc-1_r0", {
    incidentId: "inc-1",
    environment: "demo",
    recurrence: 0,
    state: "waiting-human",
    attempts: 1,
    eventCount: 0,
    createdAt: ts(T0),
    updatedAt: ts(T0 + 10_000),
    leaseExpiresAt: null,
    deadlineAt: null,
  }) as CycleRow),
  ...over,
});

let seq = 0;
const ev = (stage: string, type: string, offsetMs: number, summary = "", data: EventRow["data"] = {}): EventRow => ({
  id: String(++seq).padStart(6, "0"),
  seq,
  stage,
  type,
  summary,
  at: new Date(T0 + offsetMs),
  data,
});

const words = (c: CycleRow, events: EventRow[]) => runInWords(c, buildWaterfall(c, events, T0 + 5 * HOUR), events);

describe("sentenceFor: one sentence per stage and outcome the engine records", () => {
  // Every (stage, outcome) the loop writes (src/agent/loop.ts, indexPath.ts): none may fall back to the bare outcome.
  const known: [string, string, WordStep["fields"]][] = [
    ["triage", "decision", { decision: "notify", level: "log", rule: "model-notify" }],
    ["fix", "proposed", {}],
    ["fix", "declined", {}],
    ["fix", "error", {}],
    ["verify", "passed", {}],
    ["verify", "failed", {}],
    ["verify", "rejected", {}],
    ["verify", "timeout", {}],
    ["review", "approve", {}],
    ["review", "approve-with-flags", {}],
    ["review", "block", {}],
    ["review", "error", {}],
    ["issue", "opened", { number: 60 }],
    ["issue", "dry-run", {}],
    ["issue", "failed", {}],
    ["alert", "sent", {}],
    ["alert", "failed", {}],
    ["alert", "dry-run", {}],
    ["alert", "pending", {}],
    ["notify", "sent", {}],
    ["notify", "failed", {}],
    ["notify", "dry-run", {}],
    ["notify", "pending", {}],
    ["pr", "opened", { number: 7 }],
    ["pr", "dry-run", {}],
    ["pr", "not-opened", { reason: "already-in-index-file" }],
    ["pr", "not-opened", {}],
    ["merge", "pending", {}],
    ["merge", "skipped", { reason: "floor-failed" }],
    ["merge", "merging", {}],
    ["merge", "merged", {}],
    // Each move of the auto-merge and fast-revert records is an event (#421, src/agent/autoMerge.ts `moveRecord`).
    ["revert", "clear", {}],
    ["revert", "opening", {}],
    ["revert", "pending", {}],
    ["revert", "merging", {}],
    ["revert", "reverted", {}],
    ["revert", "escalated", { reason: "later-change" }],
    ["index", "started", {}],
    ["index", "creating", {}],
    ["index", "building", {}],
    ["index", "waiting", {}],
    ["index", "ready", {}],
  ];

  it.each(known)("%s / %s has its own sentence", (stage, outcome, fields) => {
    const s = sentenceFor({ stage, outcome, fields });
    expect(s.templated).toBe(true);
    expect(s.text).toMatch(/[.]$/);
  });

  it("never invents: an unknown outcome is the engine's own line, else the bare outcome, and says it was not templated", () => {
    expect(sentenceFor({ stage: "escalation", outcome: "answered", summary: "The primary answered", fields: {} })).toEqual({ text: "The primary answered.", templated: false });
    expect(sentenceFor({ stage: "fix", outcome: "surprise", fields: {} })).toEqual({ text: "Draft a fix: surprise.", templated: false });
  });

  it("words triage from its own fields: the level, who decided, a cap and the recount", () => {
    expect(sentenceFor({ stage: "triage", outcome: "decision", fields: { decision: "notify", level: "log", rule: "model-notify", counterCount: 2, counterWindow: "24h" } }).text).toBe(
      "Gemini's triage chose to log it: an issue and an alert, and a person fixes it. The recount found 2 errors in 24h."
    );
    expect(sentenceFor({ stage: "triage", outcome: "decision", fields: { decision: "decline", level: "noise", rule: "counter-check-zero", counterCount: 0, counterWindow: "24h" } }).text).toBe(
      "The rule counter-check-zero recorded it as noise, with nothing filed, with no model call. The recount found 0 errors in 24h."
    );
    expect(sentenceFor({ stage: "triage", outcome: "decision", fields: { decision: "act", level: "fix", rule: "correction-cap", cap: "log", capBy: "correction" } }).text).toBe(
      "Triage chose log + fix: a verified pull request that a person merges, held to log by an operator's correction."
    );
    expect(sentenceFor({ stage: "triage", outcome: "decision", fields: { decision: "notify", rule: "model-notify", counterCount: null } }).text).toBe(
      "Gemini's triage decided a person should handle it. The recount was unavailable, which triage never reads as zero."
    );
  });
});

describe("runInWords", () => {
  it("says a single round's steps in the order they happened, then where the run stands", () => {
    const events = [
      ev("triage", "decision", 1000, "a reason", { decision: "notify", level: "log", rule: "model-notify" }),
      ev("issue", "opened", 2000, "Issue #60 filed", { number: 60 }),
      ev("notify", "sent", 3000, "A person was told"),
    ];
    const w = words(cycle({ path: "human" }), events)!;
    expect(w.rounds).toHaveLength(1);
    expect(w.rounds[0]!.began).toBeUndefined();
    expect(w.rounds[0]!.sentences.map((s) => s.text)).toEqual([
      "Gemini's triage chose to log it: an issue and an alert, and a person fixes it.",
      "Issue #60 was filed.",
      "A person was told in Slack.",
    ]);
    expect(w.closing).toBe("Handed to a person.");
  });

  it("keeps the first round's words after a retry, and says why the second round began", () => {
    const events = [
      ev("triage", "decision", 1000, "x", { decision: "notify", level: "log", rule: "model-notify" }),
      ev("issue", "opened", 2000, "Issue #60 filed", { number: 60 }),
      ev("notify", "sent", 3000),
      ev("cycle", "reconsidered", HOUR, "Handed to a person earlier; retried: an operator asked for a retriage"),
      ev("triage", "decision", HOUR + 1000, "x", { decision: "decline", level: "noise", rule: "counter-check-zero" }),
    ];
    const c = cycle({ path: "decline", summary: { triage: { decision: "decline", level: "noise", rule: "counter-check-zero", counterCount: 0, counterWindow: "24h" } } });
    const w = words(c, events)!;
    expect(w.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(w.rounds[0]!.sentences.map((s) => s.text)).toEqual([
      "Gemini's triage chose to log it: an issue and an alert, and a person fixes it.",
      "Issue #60 was filed.",
      "A person was told in Slack.",
    ]);
    expect(w.rounds[1]!.began).toBe("Handed to a person earlier; retried: an operator asked for a retriage");
    // Round 2's triage ran last, so the record's recount is its own and round 1's is not given it.
    expect(w.rounds[1]!.sentences.map((s) => s.text)).toEqual(["The rule counter-check-zero recorded it as noise, with nothing filed, with no model call. The recount found 0 errors in 24h."]);
    expect(w.rounds[0]!.sentences[0]!.text).not.toContain("recount");
  });

  it("says a revision in the order it happened, and why a run stopped when no step is to blame (the model-call budget)", () => {
    const events = [
      ev("triage", "decision", 1000, "", { decision: "act", level: "merge", rule: "model-act" }),
      ev("fix", "proposed", 2000),
      ev("verify", "passed", 3000),
      ev("review", "block", 4000),
      ev("fix", "proposed", 5000),
      ev("verify", "passed", 6000),
      ev("cycle", "budget", 7000, "Model-call budget used up"),
      ev("notify", "sent", 8000),
    ];
    const w = words(cycle({ path: "human" }), events)!;
    expect(w.rounds[0]!.sentences.map((s) => s.text)).toEqual([
      "Gemini's triage chose log + fix + merge: a pull request Starfish may merge once the checks are green.",
      "Gemini drafted a patch.",
      "The verify gate passed the patch.",
      "The adversarial review blocked the patch.",
      "Gemini drafted a patch.",
      "The verify gate passed the patch.",
      "The run used up its model-call budget, the most Gemini calls one run may spend, so a person decides.",
      "A person was told in Slack.",
    ]);
    expect(w.why).toBe("The run used up its model-call budget, the most Gemini calls one run may spend, so a person decides.");
  });

  it("says how much of the model-call budget was used when the note carries it, and never guesses when it does not", () => {
    expect(stopSentence({ type: "budget", summary: "Model-call budget used up", data: { used: 6, budget: 6 } }).text).toBe(
      "The run used up its model-call budget (6 of 6 Gemini calls), the most Gemini calls one run may spend, so a person decides."
    );
    expect(stopSentence({ type: "budget", summary: "Model-call budget used up", data: {} }).text).toBe("The run used up its model-call budget, the most Gemini calls one run may spend, so a person decides.");
    expect(stopSentence({ type: "stopped", summary: "Stopped before acting: incident-ignored", data: {} })).toEqual({ text: "Stopped before acting: incident-ignored.", templated: false });
  });

  it("reads a guest's trimmed copy: no event data, only the record's enumerated fields", () => {
    const events = [ev("triage", "decision", 1000), ev("notify", "sent", 2000)];
    const c = cycle({ path: "human", trimmed: true, summary: { triage: { decision: "notify", rule: "model-notify", level: "log", counterCount: 2, counterWindow: "24h" } } });
    expect(words(c, events)!.rounds[0]!.sentences.map((s) => s.text)).toEqual([
      "Gemini's triage chose to log it: an issue and an alert, and a person fixes it. The recount found 2 errors in 24h.",
      "A person was told in Slack.",
    ]);
  });

  it("gives the run's headline reason: the last deciding step of the latest round, never a delivery", () => {
    const events = [
      ev("triage", "decision", 1000, "", { decision: "notify", level: "log", rule: "model-notify" }),
      ev("issue", "opened", 2000, "Issue #60 filed", { number: 60 }),
      ev("notify", "sent", 3000),
      ev("cycle", "reconsidered", HOUR, "Handed to a person earlier; retried: an operator asked for a retriage"),
      ev("triage", "decision", HOUR + 1000, "x", { decision: "decline", level: "noise", rule: "counter-check-zero" }),
    ];
    const c = cycle({ state: "declined", path: "decline", summary: { triage: { decision: "decline", level: "noise", rule: "counter-check-zero", counterCount: 0, counterWindow: "24h" } } });
    expect(words(c, events)!.why).toBe("The rule counter-check-zero recorded it as noise, with nothing filed, with no model call. The recount found 0 errors in 24h.");
    // One round ending on a person being told: the reason is the decision before the delivery.
    const told = [ev("triage", "decision", 1000, "", { decision: "notify", level: "log", rule: "model-notify" }), ev("notify", "sent", 2000)];
    expect(words(cycle({ path: "human" }), told)!.why).toBe("Gemini's triage chose to log it: an issue and an alert, and a person fixes it.");
    // The fix declined: that is why, not the message after it.
    const fix = [ev("triage", "decision", 1000, "", { decision: "act", level: "fix", rule: "model-act" }), ev("fix", "declined", 2000), ev("notify", "sent", 3000)];
    expect(words(cycle({ path: "human" }), fix)!.why).toBe("Gemini declined to draft a fix.");
  });

  it("has no closing line while a worker holds the run, and nothing to say before any step", () => {
    const running = words(cycle({ state: "running", path: undefined }), [ev("triage", "decision", 1000, "", { decision: "act", level: "fix" })])!;
    expect(running.closing).toBeUndefined();
    expect(running.why).toBeUndefined();
    expect(words(cycle(), [])).toBeNull();
  });
});
