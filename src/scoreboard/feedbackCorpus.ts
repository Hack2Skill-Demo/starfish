/**
 * The feedback engine's second half (src/triageRules.ts): an operator's correction becomes a replay case (#10's corpus
 * format, corpus.ts), so `pnpm replay` can measure whether Gemini's own triage now agrees with the person, without the
 * correction's cap to lean on. Pure: the CLI (`pnpm feedback-corpus`, src/feedbackCorpusCli.ts) reads the store and
 * writes what this returns.
 *
 * Only corrections a triage-only case can express become cases:
 *   noise  -> a `decline` case (expectedTriage decline)
 *   log    -> a `notify` case (expectedTriage notify)
 * A correction to `fix` or `merge` says how far a FIX may go, which only a `code-fix` case can judge, and that needs a
 * repository snapshot and a private evaluator nobody can derive from a correction: it is reported as skipped, for a
 * person to build. So is an incident with no recorded counter-check: without one, triage defers and decides nothing.
 *
 * The incident written is the stored one as the stages see it (assemble.ts `toIncident`: the ingest's redacted fields),
 * with the counter-check its latest run recorded. The correction's note and who made it are never written: a case is
 * the evidence and the expected call, not the person.
 */
import { createHash } from "node:crypto";
import { toIncident } from "../agent/assemble.js";
import { readCorrection } from "../triageRules.js";
import type { TriageCall } from "./results.js";

export interface CorrectedIncident {
  id: string;
  /** The stored incident document. */
  doc: Record<string, unknown>;
  /** `summary.triage` of the incident's current cycle, when there is one: where its counter-check was recorded. */
  triage?: Record<string, unknown>;
}

export interface FeedbackCorpus {
  manifest: Record<string, unknown>;
  /** Relative path inside the corpus directory -> content. */
  files: Record<string, string>;
  skipped: { incidentId: string; reason: string }[];
}

const EXPECTED: Partial<Record<string, { path: "decline" | "notify"; expectedTriage: TriageCall }>> = {
  noise: { path: "decline", expectedTriage: "decline" },
  log: { path: "notify", expectedTriage: "notify" },
};

/** A case id the corpus's path guard accepts, unique per incident id even when two ids clean to the same text. */
export function caseIdFor(incidentId: string): string {
  const clean = incidentId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
  return clean === incidentId ? `fb-${clean}` : `fb-${clean}-${createHash("sha256").update(incidentId).digest("hex").slice(0, 8)}`;
}

export function buildFeedbackCorpus(items: readonly CorrectedIncident[], opts: { corpusVersion: string; appRevision: string }): FeedbackCorpus {
  const cases: Record<string, unknown>[] = [];
  const files: Record<string, string> = {};
  const skipped: FeedbackCorpus["skipped"] = [];
  for (const item of items) {
    const correction = readCorrection(item.doc);
    if (!correction) {
      skipped.push({ incidentId: item.id, reason: "no correction" });
      continue;
    }
    const expected = EXPECTED[correction.level];
    if (!expected) {
      skipped.push({ incidentId: item.id, reason: `corrected to ${correction.level}: a code-fix case needs a repository snapshot and an evaluator, built by a person` });
      continue;
    }
    const count = item.triage?.counterCount;
    const window = item.triage?.counterWindow;
    if (typeof count !== "number" || !Number.isFinite(count) || typeof window !== "string" || window === "") {
      skipped.push({ incidentId: item.id, reason: "no counter-check recorded: triage would defer" });
      continue;
    }
    const caseId = caseIdFor(item.id);
    const file = `cases/${caseId}/incident.json`;
    const incident = { ...toIncident(item.id, item.doc), logCounterCheck: { window, count, ...(item.triage?.counterCapped === true && { capped: true }) } };
    files[file] = `${JSON.stringify(incident, null, 2)}\n`;
    cases.push({ caseId, split: "tuning", path: expected.path, expectedTriage: expected.expectedTriage, incident: file });
  }
  return {
    manifest: {
      corpusVersion: opts.corpusVersion,
      appRevision: opts.appRevision,
      synthetic: false,
      note: "Built by pnpm feedback-corpus from operators' corrections (src/triageRules.ts): each case expects the triage the person said it should have had. Triage-only cases (decline, notify); tuning split, not frozen.",
      cases,
    },
    files,
    skipped,
  };
}
