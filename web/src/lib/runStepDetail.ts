/**
 * What one step of a run shows under its line in the Runs page's timeline: the details the engine recorded for it, read
 * from the run record (`summary.<stage>`, src/agent/loop.ts) and the step's own last event, and nothing else. Pure.
 *
 * The run record keeps only a stage's LATEST record, so its details belong to a step only when that step is the stage's
 * latest event: a replay paused on an earlier attempt, or a step drawn from an earlier revision, gets none rather than a
 * later attempt's. A guest's trimmed copy (#18) keeps only enumerated, numeric and hash values, so the text fields are
 * simply absent there; a missing field is left out, never filled in.
 *
 * Not stored, so never shown: the patch text (only its SHA-256), the channel a Slack message went to.
 */
import { LEVEL_LABELS, safeUrl, type CycleRow, type EventRow, type Step } from "./runsModel";

/** How far Starfish may go (triage.ts `triageLevel`), lowest first: the choices triage picks one of. */
export const LEVELS = ["noise", "log", "fix", "merge"] as const;
export type Level = (typeof LEVELS)[number];

/** The short words for each level on the timeline; `LEVEL_LABELS` has the full sentence. */
export const LEVEL_SHORT: Record<Level, string> = { noise: "Noise", log: "Log", fix: "Log + fix", merge: "Log + fix + merge" };

export type AttackOutcome = "held" | "flagged" | "broken";

export interface ReviewAttack {
  outcome: AttackOutcome;
  attack: string;
  detail?: string;
}

export interface StepDetail {
  triage?: {
    level?: Level;
    levelLabel?: string;
    mergeCase?: string;
    /** The rules engine's cap: the level it held Starfish to, and whose it was. */
    cap?: { level: string; by?: "rule" | "correction"; rule?: string };
    /** The independent log recount triage judged on. `count` null = the recount failed: never read as zero. */
    recount?: { count: number | null; window?: string; capped: boolean };
  };
  fix?: { risk?: string; testAdded?: boolean; alternatives: string[]; source?: string; revisions?: number };
  verify?: { files?: number; exitCode?: number | null; rule?: string; patchSha256?: string; output?: string };
  review?: { held?: number; flagged?: number; broken?: number; attacks: ReviewAttack[] };
  /** An alert or a message to a person: how the delivery ended. */
  delivery?: { state?: string; attempts?: number; reason?: string };
  /** The pull request's diff on GitHub, when one was opened: the patch text itself is not stored. */
  diffUrl?: string;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** `prefix1`, `prefix2`... in order, stopping at the first gap: how a record keeps a list in flat values. */
export function numbered(record: Record<string, unknown> | undefined, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 1; record && i <= 50; i++) {
    const v = text(record[`${prefix}${i}`]);
    if (v === undefined) break;
    out.push(v);
  }
  return out;
}

/** "broken: the attack | the detail", as the loop records each review attack; null when it is not that shape. */
export function parseAttack(raw: string): ReviewAttack | null {
  const m = /^(held|flagged|broken):\s*([\s\S]*)$/.exec(raw.trim());
  if (!m) return null;
  const [attack = "", ...rest] = m[2]!.split(" | ");
  const detail = rest.join(" | ").trim();
  return { outcome: m[1] as AttackOutcome, attack: attack.trim(), ...(detail !== "" && { detail }) };
}

/**
 * Whether the run record's entry for the step's stage is the step's own: the step is the stage's latest event among all
 * the run's events. Not in a replay that has not got there, and not for a stage the record holds nothing for.
 */
export function recordIsTheStep(step: Pick<Step, "stage" | "at">, events: readonly Pick<EventRow, "stage" | "at">[]): boolean {
  if (!step.at) return false;
  const latest = Math.max(...events.filter((e) => e.stage === step.stage).map((e) => e.at.getTime()));
  return latest === step.at.getTime();
}

export function stepDetail(step: Step, cycle: CycleRow, events: readonly EventRow[]): StepDetail {
  if (step.status !== "done" && step.status !== "failed") return {};
  const own = recordIsTheStep(step, events);
  const rec = own ? cycle.summary[step.stage] : undefined;
  const out: StepDetail = {};

  if (step.stage === "triage" && rec) {
    const level = (LEVELS as readonly string[]).includes(String(rec.level)) ? (rec.level as Level) : undefined;
    const cap = text(rec.cap);
    const count = rec.counterCount;
    out.triage = {
      ...(level && { level, levelLabel: LEVEL_LABELS[level] }),
      ...(level === "merge" && text(rec.mergeCase) && { mergeCase: text(rec.mergeCase) }),
      ...(cap && {
        cap: {
          level: cap,
          ...((rec.capBy === "rule" || rec.capBy === "correction") && { by: rec.capBy }),
          ...(text(rec.capRule) && { rule: text(rec.capRule) }),
        },
      }),
      ...("counterCount" in rec && {
        recount: { count: num(count) ?? null, ...(text(rec.counterWindow) && { window: text(rec.counterWindow) }), capped: rec.counterCapped === true },
      }),
    };
  }

  if (step.stage === "fix" && rec) {
    out.fix = {
      ...(text(rec.risk) && { risk: text(rec.risk) }),
      ...(bool(rec.testAdded) !== undefined && { testAdded: bool(rec.testAdded) }),
      alternatives: numbered(rec, "alternative"),
      ...(text(rec.source) && { source: text(rec.source) }),
      ...(num(rec.revisions) !== undefined && { revisions: num(rec.revisions) }),
    };
    const pr = safeUrl(cycle.summary.pr?.url);
    if (pr) out.diffUrl = `${pr.replace(/\/+$/, "")}/files`;
  }

  if (step.stage === "verify") {
    // The refusal's own words travel on the event (#317), so they are the step's whatever the record holds.
    const output = text(step.data?.output);
    if (rec || output) {
      out.verify = {
        ...(num(rec?.files) !== undefined && { files: num(rec?.files) }),
        ...(rec && (rec.exitCode === null || num(rec.exitCode) !== undefined) && { exitCode: rec.exitCode as number | null }),
        ...(text(rec?.rule) && { rule: text(rec?.rule) }),
        ...(text(rec?.patchSha256) && { patchSha256: text(rec?.patchSha256) }),
        ...(output && { output }),
      };
    }
  }

  if (step.stage === "review" && rec) {
    out.review = {
      ...(num(rec.held) !== undefined && { held: num(rec.held) }),
      ...(num(rec.flagged) !== undefined && { flagged: num(rec.flagged) }),
      ...(num(rec.broken) !== undefined && { broken: num(rec.broken) }),
      attacks: numbered(rec, "attack")
        .map(parseAttack)
        .filter((a): a is ReviewAttack => a !== null),
    };
  }

  if ((step.stage === "alert" || step.stage === "notify") && rec) {
    out.delivery = {
      ...(text(rec.state) && { state: text(rec.state) }),
      ...(num(rec.attempts) !== undefined && { attempts: num(rec.attempts) }),
      ...(text(rec.reason) && { reason: text(rec.reason) }),
    };
  }

  return out;
}
