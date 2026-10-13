/**
 * What an incident's detail page shows, built from what is stored and nothing else: the incident
 * document, and the run record of its latest cycle (`summary.<stage>` on the cycle, written by
 * src/agent/loop.ts). Pure: it reads nothing. A stage without a record is "not reached" and carries
 * no result, so the page can never show a placeholder as if it were evidence.
 *
 * The independent log recount comes from the triage record (`counter*` keys, kept with the decision
 * it informed). The fixer's rejected alternatives and each review attack are numbered keys
 * (`alternative1`..., `attack1`...), since the record holds flat values only.
 *
 * Not stored, and said so on the page rather than faked: the patch text (only its SHA-256 is recorded); when a pull
 * request was opened, the fix stage links to its diff on GitHub instead (#39).
 */
import type { IncidentRow } from "./incidents";
import { indexRuntimeView, isIndexCycle, prStateView, safeUrl, type CycleRow } from "./runsModel";

export type EvidenceStatus = "recorded" | "not-reached" | "not-stored";

export interface EvidenceField {
  label: string;
  value: string;
  /** A link target, shown as a link only when it is https. */
  href?: string;
  mono?: boolean;
}

export interface EvidenceStage {
  id: "detected" | "counter-check" | "triage" | "fix" | "verify" | "review" | "pr" | "index";
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

/** `prefix1`, `prefix2`... in order, as fields labelled "<label> 1", "<label> 2"...; stops at the first gap. */
function numberedFields(record: Record<string, string | number | boolean | null> | undefined, prefix: string, label: string): EvidenceField[] {
  const out: EvidenceField[] = [];
  for (let i = 1; record && i <= 20; i++) {
    const value = show(record[`${prefix}${i}`]);
    if (value === undefined) break;
    out.push({ label: `${label} ${i}`, value });
  }
  return out;
}

/**
 * The recount triage judged on, from its record. Missing (`counterCount: null`) is said to be missing, never zero. A
 * guest's trimmed copy (#18) never carries the log filter, so its absence there says nothing about its length.
 */
function counterCheckStage(triage: Record<string, string | number | boolean | null> | undefined, storeCount: number, noRun: boolean, trimmed: boolean): EvidenceStage {
  const base = { id: "counter-check" as const, title: "Counter-check" };
  if (!triage) return { ...base, status: "not-reached", note: noRun ? "Not reached: no agent run is recorded for this incident." : NOT_REACHED, fields: [] };
  if (!("counterCount" in triage)) {
    return { ...base, status: "not-stored", note: "Not stored: this run was recorded before the engine kept its recount.", fields: [] };
  }
  if (triage.counterCount === null) {
    return { ...base, status: "recorded", note: "Missing: the independent recount was not available, so triage waited for it (missing is not zero).", fields: [] };
  }
  const capped = triage.counterCapped === true;
  const fields: EvidenceField[] = [
    { label: "Raw-log recount", value: `${capped ? "at least " : ""}${String(triage.counterCount)}` },
    // Side by side, as the issue asks; not the same window: the store counts every occurrence since first seen.
    { label: "Store's count (since first seen)", value: String(storeCount) },
    ...fieldsFrom(triage, [
      ["counterWindow", "Window"],
      ["counterCheckedAt", "Checked at"],
      ["counterFilter", "Filter counted", true],
    ]),
  ];
  return {
    ...base,
    status: "recorded",
    ...(!("counterFilter" in triage) && !trimmed && { note: "The filter was too long to store whole, so it is left out rather than cut." }),
    fields,
  };
}

/**
 * A Monitoring-only incident has no ERROR log, so a raw-log recount of it is zero by construction: say so beside
 * the recount, so a zero there is not read as "this was noise" (#19).
 */
function monitoringOnlyCounterCheck(stage: EvidenceStage, row: IncidentRow): EvidenceStage {
  if (!row.monitoringOnly || stage.status !== "recorded") return stage;
  const note = "Monitoring only: there is no ERROR log to recount, so the raw-log recount is zero by construction, not a sign of noise.";
  return { ...stage, note: stage.note ? `${note} ${stage.note}` : note };
}

/** The pull request as the engine last read it back from GitHub (#17), or that it never was. */
function prNowFields(cycle: CycleRow | null, nowMs: number): EvidenceField[] {
  const view = cycle ? prStateView(cycle, nowMs) : undefined;
  if (!view) return [];
  const headSha = cycle?.summary.prState?.headSha;
  return [
    { label: "State now", value: view.text },
    ...(view.checkedAt ? [{ label: "Read from GitHub", value: view.checkedAt.toISOString() }] : []),
    ...(view.checkedAt && typeof headSha === "string" && headSha !== "" ? [{ label: "Head commit", value: headSha, mono: true }] : []),
  ];
}

const MONITORING_ONLY_NOTE =
  "Monitoring only: Cloud Monitoring counted failed invocations of this function with no ERROR log entry behind them. There is no log message or stack trace, so the occurrences are those failures.";

/** What Cloud Monitoring recorded for the incident (#19): its total, and each reading of the latest window, as stored. */
function monitoringFields(row: IncidentRow): EvidenceField[] {
  return [
    ...(row.monitoringOnly ? [{ label: "Source", value: "Cloud Monitoring only (no ERROR log entry)" }] : []),
    ...(row.monitoringCount !== undefined ? [{ label: "Failed invocations (Cloud Monitoring)", value: String(row.monitoringCount) }] : []),
    ...(row.lastMonitoring ?? []).map((r, i) => ({
      label: `Monitoring reading ${i + 1}`,
      value: `${r.capped ? "at least " : ""}${r.failureCount} failed · ${r.metricType} on ${r.resourceType} in ${r.projectId} · ${r.windowStart} to ${r.windowEnd}`,
      mono: true,
    })),
  ];
}

export function buildEvidence(row: IncidentRow, cycle: CycleRow | null, nowMs = Date.now()): Evidence {
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
  const detected: EvidenceStage = {
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
      ...monitoringFields(row),
    ].filter((f) => f.value !== ""),
    ...(row.monitoringOnly && { note: MONITORING_ONLY_NOTE }),
  };
  const prStage = later(
    "pr",
    "Pull request",
    [
      ["opened", "Opened"],
      ["reason", "Why not"],
      ["number", "Number"],
      ["patchSha256", "Patch SHA-256", true],
    ],
    [...(prUrl ? [{ label: "Link", value: prUrl, href: prUrl }] : []), ...prNowFields(cycle, nowMs)]
  );

  // The missing-index path (#11): no model, no draft, no verify gate or review; the index, then its evidence PR.
  if (cycle && isIndexCycle(cycle)) {
    const runtime = indexRuntimeView(cycle);
    const index = later(
      "index",
      "Missing index",
      [
        ["state", "State"],
        ["rule", "Rule", true],
        ["reason", "Reason"],
        ["project", "Project", true],
        ["database", "Database", true],
        ["collectionGroup", "Collection group", true],
        ["queryScope", "Scope", true],
        ["fields", "Fields", true],
        ["created", "Created by this run"],
        ["operation", "Create operation", true],
        ["live", "Live inventory (dry run)"],
        ["probe", "Configured query replayed"],
        ["repoFile", "In the repository's index file"],
        ["readyAt", "READY and the query passed at"],
        ["observeUntil", "Watched until"],
        ["runtimeCheckedAt", "Decided at"],
        ["runtimeBasis", "Decided on"],
      ],
      runtime ? [{ label: "Runtime", value: runtime.text }] : []
    );
    index.note = "No model wrote this fix: the index is the one Google's error named. Healed is decided only after the quiet window.";
    if (prStage.status === "recorded") prStage.note = "The pull request only records the index in the repository; the index already exists in production.";
    return { stages: [detected, index, prStage], cycleId: cycle.id, samePatch: null };
  }

  const stages: EvidenceStage[] = [
    detected,
    monitoringOnlyCounterCheck(counterCheckStage(rec.triage, row.occurrenceCount, noRun, cycle?.trimmed === true), row),
    later("triage", "Triage", [
      ["decision", "Decision"],
      ["rule", "Rule", true],
      ["reason", "Reason"],
      ["suspectedCause", "Suspected cause"],
      ["model", "Model", true],
    ]),
    later(
      "fix",
      "Fix draft",
      [
        ["outcome", "Outcome"],
        ["rule", "Rule", true],
        ["rootCause", "Root cause"],
        ["testAdded", "Test added"],
        ["risk", "Risk"],
        ["revisions", "Revisions"],
        ["source", "Source found by", true],
        ["sourceFiles", "Source files shown"],
        ["sourceSearch", "Function-name search", true],
      ],
      numberedFields(rec.fix, "alternative", "Rejected alternative")
    ),
    later("verify", "Verify gate", [
      ["status", "Result"],
      ["rule", "Rule", true],
      ["files", "Files changed"],
      ["exitCode", "Exit code"],
      ["durationMs", "Duration (ms)"],
      ["isolation", "Where it ran", true],
      ["baseRevision", "Tested against", true],
      ["patchSha256", "Patch SHA-256", true],
    ]),
    later(
      "review",
      "Adversarial review",
      [
        ["verdict", "Verdict"],
        ["rule", "Rule", true],
        ["attacks", "Attacks tried"],
        ["held", "Held"],
        ["flagged", "Flagged"],
        ["broken", "Broken"],
        ["patchSha256", "Patch SHA-256", true],
      ],
      numberedFields(rec.review, "attack", "Attack")
    ),
    prStage,
  ];
  // A merge is about the pull request, not the incident: say so wherever the PR's later state is shown.
  const pr = stages.find((s) => s.id === "pr")!;
  if (cycle && prStateView(cycle, nowMs)) pr.note = "A merged pull request is not proof the incident is healed: that needs the error to stop in production.";

  const hashes = (["verify", "review", "pr"] as const)
    .map((k) => rec[k]?.patchSha256)
    .filter((h): h is string => typeof h === "string" && h !== "");

  // The patch text itself is not stored; say so where it would be, once a fix exists, and point at the
  // hash only if one was actually recorded.
  const fix = stages.find((s) => s.id === "fix")!;
  if (fix.status === "recorded") {
    // The diff lives on GitHub, in the pull request (#39): link to it rather than store the patch text here.
    const diffUrl = prUrl ? `${prUrl.replace(/\/+$/, "")}/files` : undefined;
    if (diffUrl) fix.fields.push({ label: "Diff", value: "View the changes on GitHub", href: diffUrl });
    fix.note = diffUrl
      ? "The patch text is not stored here; the diff is in the pull request on GitHub."
      : hashes.length > 0
        ? "The patch text is not stored; its SHA-256 is recorded under the later stages. No pull request was opened, so there is no diff to link to."
        : "The patch text is not stored.";
  }
  const samePatch = hashes.length < 2 ? null : hashes.every((h) => h === hashes[0]);

  return { stages, cycleId: cycle?.id ?? null, samePatch };
}
