/**
 * What an incident's detail page shows, built from what is stored and nothing else: the incident
 * document, and the run record of its latest cycle (`summary.<stage>` on the cycle, written by
 * src/agent/loop.ts). Pure: it reads nothing. A stage without a record is "not reached" and carries
 * no result, so the page can never show a placeholder as if it were evidence.
 *
 * Not stored today, and said so on the page rather than faked: the independent log recount (the
 * engine does not keep it with the incident), and the patch text (only its SHA-256 is recorded).
 */
import type { IncidentRow } from "./incidents";
import { safeUrl, type CycleRow } from "./runsModel";

export type EvidenceStatus = "recorded" | "not-reached" | "not-stored";

export interface EvidenceField {
  label: string;
  value: string;
  /** A link target, shown as a link only when it is https. */
  href?: string;
  mono?: boolean;
}

export interface EvidenceStage {
  id: "detected" | "counter-check" | "triage" | "fix" | "verify" | "review" | "pr";
  title: string;
  status: EvidenceStatus;
  /** What to say when there is nothing to show. */
  note?: string;
  fields: EvidenceField[];
}

export interface Evidence {
  stages: EvidenceStage[];
  /** The run the stages come from, when there is one. */
  cycleId: string | null;
  /**
   * Whether the patch hash agrees wherever it is recorded (verify, review, pull request): the
   * evidence is about one patch. `null` when fewer than two stages recorded a hash.
   */
  samePatch: boolean | null;
}

/** The id of the cycle for an incident's current recurrence (src/agent/cycle.ts `cycleId`). */
export function currentCycleId(row: Pick<IncidentRow, "id" | "recurrenceCount">): string {
  return `${row.id}_r${row.recurrenceCount}`;
}

const show = (v: unknown): string | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  return String(v);
};

/** Fields for the keys that are present, in order; a missing key is left out, never filled in. */
function fieldsFrom(record: Record<string, string | number | boolean | null> | undefined, spec: [key: string, label: string, mono?: boolean][]): EvidenceField[] {
  if (!record) return [];
  const out: EvidenceField[] = [];
  for (const [key, label, mono] of spec) {
    const value = show(record[key]);
    if (value !== undefined) out.push({ label, value, ...(mono && { mono }) });
  }
  return out;
}

const NOT_REACHED = "Not reached: the agent has not recorded this step.";

export function buildEvidence(row: IncidentRow, cycle: CycleRow | null): Evidence {
  const rec = cycle?.summary ?? {};
  const noRun = cycle === null;
  const later = (id: EvidenceStage["id"], title: string, spec: [string, string, boolean?][], extra: EvidenceField[] = []): EvidenceStage => {
    const record = rec[id];
    if (!record) {
      return { id, title, status: "not-reached", note: noRun ? "Not reached: no agent run is recorded for this incident." : NOT_REACHED, fields: [] };
    }
    return { id, title, status: "recorded", fields: [...fieldsFrom(record, spec), ...extra] };
  };

  const prUrl = safeUrl(rec.pr?.url);
  const stages: EvidenceStage[] = [
    {
      id: "detected",
      title: "Detected",
      status: "recorded",
      fields: [
        { label: "Function", value: row.functionName },
        { label: "Service", value: row.service },
        { label: "Environment", value: row.environment },
        { label: "Error", value: row.errorType },
        { label: "Occurrences", value: String(row.occurrenceCount) },
        { label: "First seen", value: row.firstOccurredAt },
        { label: "Last seen", value: row.lastOccurredAt },
        ...(row.recurrenceCount > 0 ? [{ label: "Regressions", value: String(row.recurrenceCount) }] : []),
      ].filter((f) => f.value !== ""),
    },
    {
      id: "counter-check",
      title: "Counter-check",
      status: "not-stored",
      note: "Not stored: the engine recounts the raw logs, but does not keep the result with the incident yet.",
      fields: [],
    },
    later("triage", "Triage", [
      ["decision", "Decision"],
      ["rule", "Rule", true],
      ["reason", "Reason"],
      ["suspectedCause", "Suspected cause"],
    ]),
    {
      ...later("fix", "Fix draft", [
        ["outcome", "Outcome"],
        ["rule", "Rule", true],
        ["rootCause", "Root cause"],
        ["testAdded", "Test added"],
        ["risk", "Risk"],
        ["revisions", "Revisions"],
      ]),
    },
    later("verify", "Verify gate", [
      ["status", "Result"],
      ["rule", "Rule", true],
      ["files", "Files changed"],
      ["exitCode", "Exit code"],
      ["durationMs", "Duration (ms)"],
      ["baseRevision", "Tested against", true],
      ["patchSha256", "Patch SHA-256", true],
    ]),
    later("review", "Adversarial review", [
      ["verdict", "Verdict"],
      ["rule", "Rule", true],
      ["attacks", "Attacks tried"],
      ["held", "Held"],
      ["flagged", "Flagged"],
      ["broken", "Broken"],
      ["patchSha256", "Patch SHA-256", true],
    ]),
    later(
      "pr",
      "Pull request",
      [
        ["opened", "Opened"],
        ["reason", "Why not"],
        ["number", "Number"],
        ["patchSha256", "Patch SHA-256", true],
      ],
      prUrl ? [{ label: "Link", value: prUrl, href: prUrl }] : []
    ),
  ];

  const hashes = (["verify", "review", "pr"] as const)
    .map((k) => rec[k]?.patchSha256)
    .filter((h): h is string => typeof h === "string" && h !== "");

  // The patch text itself is not stored; say so where it would be, once a fix exists, and point at the
  // hash only if one was actually recorded.
  const fix = stages.find((s) => s.id === "fix")!;
  if (fix.status === "recorded") {
    fix.note = hashes.length > 0 ? "The patch text is not stored; its SHA-256 is recorded under the later stages." : "The patch text is not stored.";
  }
  const samePatch = hashes.length < 2 ? null : hashes.every((h) => h === hashes[0]);

  return { stages, cycleId: cycle?.id ?? null, samePatch };
}
