/**
 * A run in plain words: a few fixed sentences per round, composed from what the engine recorded and nothing else. Pure.
 *
 * Not model-written, on purpose. Every sentence here maps to a stored field (a step's outcome, its event data, the run
 * record), so it is true or absent, and a guest sees the same sentences from the fields their trimmed copy keeps
 * (src/publicView.ts never carries model text). The model's own words stay where they are: triage's reasoning, labelled
 * as the model's.
 *
 * One sentence-maker per stage, keyed by the outcome the stage recorded. An outcome with no sentence is never guessed:
 * it falls back to the engine's own one-line summary for the step, else to "<step>: <outcome>", and `templated` says it
 * did. The run record keeps only a stage's latest record, so a step's record fields are used only when no later round
 * ran that stage again (`recordIsTheStep`); its event data is its own and always usable.
 */
import { PATH_LABELS, stepLogOrder, titleOf, type CycleRow, type EventRow, type Step, type Waterfall } from "./runsModel";
import { recordIsTheStep } from "./runStepDetail";

type Fields = Record<string, string | number | boolean | null>;

/** One step as the sentence-makers read it: the outcome it ended in, the engine's line, and the fields recorded for it. */
export interface WordStep {
  stage: string;
  outcome?: string;
  summary?: string;
  /** Its event's data merged under the run record's entry for the stage, the record only when it is this step's own. */
  fields: Fields;
}

export interface Sentence {
  text: string;
  /** False when no sentence is written for this stage and outcome: the engine's own line, or the bare outcome. */
  templated: boolean;
}

/** A sentence and the stage it is about. */
export interface StageSentence extends Sentence {
  stage: string;
}

export interface WordsRound {
  round: number;
  /** Why the round began, in the engine's words; absent for the first round. */
  began?: string;
  sentences: StageSentence[];
}

export interface RunWords {
  rounds: WordsRound[];
  /** Where the run stands now, from its path; absent while it is running. */
  closing?: string;
  /**
   * Why the run ended where it did: the sentence of the latest round's last deciding step (triage, the fix, the gate, the
   * review, the index, the pull request, the merge), not a delivery such as the issue or a message. For the run's headline.
   */
  why?: string;
}

/** The steps that decide where a run goes, as against the ones that tell people (the issue, the alerts, the calls); a stop note (`cycle`) is the reason when the run was stopped with no step to blame. */
const DECIDING = new Set(["triage", "fix", "verify", "review", "index", "pr", "merge", "revert", "cycle"]);

const LEVEL_WORDS: Record<string, string> = {
  noise: "recorded it as noise, with nothing filed",
  log: "chose to log it: an issue and an alert, and a person fixes it",
  fix: "chose log + fix: a verified pull request that a person merges",
  merge: "chose log + fix + merge: a pull request Starfish may merge once the checks are green",
};

const DECISION_WORDS: Record<string, string> = {
  act: "decided to act on it",
  notify: "decided a person should handle it",
  decline: "declined to act on it",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const ok = (text: string): Sentence => ({ text, templated: true });

function triage(f: Fields): Sentence | undefined {
  const level = str(f.level);
  const decision = str(f.decision);
  const verb = (level && LEVEL_WORDS[level]) || (decision && DECISION_WORDS[decision]);
  if (!verb) return undefined;
  const rule = str(f.rule);
  const byModel = rule?.startsWith("model-") === true;
  const byRule = rule !== undefined && !byModel && !rule.endsWith("-cap");
  const subject = byModel ? "Gemini's triage" : byRule ? `The rule ${rule}` : "Triage";
  const cap = str(f.cap);
  const capBy = f.capBy === "rule" ? "the admin's class rule" : f.capBy === "correction" ? "an operator's correction" : undefined;
  const held = cap && capBy ? `, held to ${cap} by ${capBy}` : "";
  const count = f.counterCount;
  const recount =
    count === null
      ? " The recount was unavailable, which triage never reads as zero."
      : num(count) !== undefined
        ? ` The recount found ${num(count)} ${num(count) === 1 ? "error" : "errors"}${str(f.counterWindow) ? ` in ${str(f.counterWindow)}` : ""}.`
        : "";
  return ok(`${subject} ${verb}${held}${byRule ? ", with no model call" : ""}.${recount}`);
}

/** The sentence for one stage's outcome, or undefined when none is written (the caller falls back). */
function sentence(stage: string, outcome: string | undefined, f: Fields): Sentence | undefined {
  switch (stage) {
    case "triage":
      return outcome === "decision" ? triage(f) : undefined;
    case "fix":
      return outcome === "proposed"
        ? ok(f.testAdded === true ? "Gemini drafted a patch, with a test." : "Gemini drafted a patch.")
        : outcome === "declined"
          ? ok("Gemini declined to draft a fix.")
          : outcome === "error"
            ? ok("The fix step failed with an error.")
            : undefined;
    case "verify":
      return outcome === "passed"
        ? ok("The verify gate passed the patch.")
        : outcome === "failed"
          ? ok("The verify gate ran the checks and they failed.")
          : outcome === "rejected"
            ? ok("The verify gate rejected the patch before running anything.")
            : outcome === "timeout"
              ? ok("The verify gate timed out.")
              : undefined;
    case "review":
      return outcome === "approve"
        ? ok("The adversarial review approved the patch.")
        : outcome === "approve-with-flags"
          ? ok("The adversarial review approved the patch with flags.")
          : outcome === "block"
            ? ok("The adversarial review blocked the patch.")
            : outcome === "error"
              ? ok("The adversarial review failed with an error.")
              : undefined;
    case "issue": {
      const n = num(f.number);
      return outcome === "opened"
        ? ok(n !== undefined ? (f.reused === true ? `A recurrence was noted on the open issue #${n}.` : `Issue #${n} was filed.`) : "An issue was filed.")
        : outcome === "dry-run"
          ? ok("An issue would be filed; nothing was (dry run).")
          : outcome === "failed"
            ? ok("The issue could not be filed.")
            : undefined;
    }
    case "alert":
    case "notify": {
      const what = stage === "alert" ? "The team was alerted in Slack" : "A person was told in Slack";
      return outcome === "sent"
        ? ok(`${what}.`)
        : outcome === "failed"
          ? ok(`${stage === "alert" ? "Alerting the team" : "Telling a person"} failed.`)
          : outcome === "dry-run"
            ? ok(`${what.replace(/ was /, " would be ")} here; nothing was sent (dry run).`)
            : outcome === "pending"
              ? ok(`${stage === "alert" ? "Alerting the team" : "Telling a person"} had not finished.`)
              : undefined;
    }
    case "pr": {
      const n = num(f.number);
      return outcome === "opened"
        ? ok(n !== undefined ? `Pull request #${n} was opened.` : "A pull request was opened.")
        : outcome === "dry-run"
          ? ok("A patch was verified but nothing was opened (dry run).")
          : outcome === "not-opened" && f.reason === "already-in-index-file"
            ? ok("No pull request was needed: the repository's index file already has this index.")
            : outcome === "not-opened"
              ? ok("No pull request was opened.")
              : undefined;
    }
    case "merge": {
      const reason = str(f.reason);
      return outcome === "pending"
        ? ok("It is waiting for the required checks before an auto-merge.")
        : outcome === "skipped"
          ? ok(reason ? `It was not auto-merged (${reason}).` : "It was not auto-merged.")
          : outcome === "merging"
            ? ok("Its required checks passed, and Starfish began merging it.")
            : outcome === "merged"
              ? ok("Starfish merged it.")
              : undefined;
    }
    // Fast revert (#9): the watch every merge starts. Each move of its record is an event (#421).
    case "revert": {
      const reason = str(f.reason);
      return outcome === "clear"
        ? ok("The watch after the merge saw no recurrence, so the merge stands.")
        : outcome === "opening"
          ? ok("The incident came back after the merge, so Starfish began a revert.")
          : outcome === "pending"
            ? ok("The revert's pull request was opened and is waiting for its checks.")
            : outcome === "merging"
              ? ok("The revert's checks passed, and Starfish began merging it.")
              : outcome === "reverted"
                ? ok("The merge was reverted.")
                : outcome === "escalated"
                  ? ok(reason ? `The revert was handed to a person (${reason}).` : "The revert was handed to a person.")
                  : undefined;
    }
    case "index":
      return outcome === "started"
        ? ok("The missing-index path started checking its gates, with no model.")
        : outcome === "creating" || outcome === "building"
          ? ok("The index was created and is building.")
          : outcome === "waiting"
            ? ok("The index is still building; a later pass checks again.")
            : outcome === "ready"
              ? ok("The index is READY and the failing query passes again.")
              : undefined;
    default:
      return undefined;
  }
}

/** The step's sentence: written for it, else the engine's own line, else the bare outcome. Never invented. */
export function sentenceFor(step: WordStep): Sentence {
  const written = sentence(step.stage, step.outcome, step.fields);
  if (written) return written;
  const line = str(step.summary);
  const text = line ?? `${titleOf(step.stage)}${step.outcome ? `: ${step.outcome}` : ""}`;
  return { text: /[.!?]$/.test(text) ? text : `${text}.`, templated: false };
}

const withStage = (s: WordStep): StageSentence => ({ ...sentenceFor(s), stage: s.stage });

const wordStep = (s: Pick<Step, "stage" | "outcome" | "summary" | "data">, record: Fields | undefined): WordStep => ({
  stage: s.stage,
  ...(s.outcome && { outcome: s.outcome }),
  ...(s.summary && { summary: s.summary }),
  fields: { ...(s.data ?? {}), ...(record ?? {}) },
});

/**
 * The run in plain words: each round's steps in the order they happened, then where the run stands. Null when there is
 * nothing recorded to say.
 */
export function runInWords(cycle: CycleRow, water: Waterfall, events: readonly EventRow[]): RunWords | null {
  const recordOf = (stage: string, at: Date | undefined): Fields | undefined => (at && recordIsTheStep({ stage, at }, events) ? cycle.summary[stage] : undefined);
  const reopenings = water.notes.filter((n) => n.type === "reconsidered");
  const rounds: WordsRound[] = [];
  for (const r of water.earlier) {
    const steps = [...r.steps].reverse().map((s) => wordStep({ stage: s.stage, ...(s.outcome && { outcome: s.outcome }), ...(s.summary && { summary: s.summary }), ...(s.data && { data: s.data }) }, recordOf(s.stage, s.at)));
    // The reopening that began this round: by the round the engine stamped on it (#436), else by its place.
    const began = r.round > 1 ? (reopenings.find((n) => n.round === r.round) ?? reopenings[r.round - 2])?.summary : undefined;
    rounds.push({ round: r.round, ...(began && { began }), sentences: steps.map(withStage) });
  }
  // The latest round's steps in the order they happened, a repeated stage's earlier runs included (a draft, its gate, the
  // review that blocked it, the revision), and the engine's own stop notes (the model-call budget used up, a stop before
  // acting), which are why a run can end with no step to blame.
  const stopNotes = water.notes.filter((n) => (n.type === "budget" || n.type === "stopped") && (!water.reopened || n.at.getTime() >= water.reopened.at.getTime()));
  const timed: { at: number; s: StageSentence }[] = [
    ...stepLogOrder([...water.steps, ...water.attempts])
      .filter((s) => s.status === "done" || s.status === "failed")
      .map((s) => ({ at: s.at?.getTime() ?? 0, s: withStage(wordStep(s, recordOf(s.stage, s.at))) })),
    ...stopNotes.map((n) => ({ at: n.at.getTime(), s: { text: `${n.summary.replace(/[.\s]+$/, "")}.`, templated: false, stage: "cycle" } })),
  ].sort((a, b) => a.at - b.at);
  if (timed.length > 0 || rounds.length === 0) {
    const began = water.rounds > 1 ? water.reopened?.summary : undefined;
    rounds.push({ round: water.rounds, ...(began && { began }), sentences: timed.map((t) => t.s) });
  }
  const closing = cycle.state !== "running" && cycle.path ? `${PATH_LABELS[cycle.path]}.` : undefined;
  if (rounds.every((r) => r.sentences.length === 0)) return null;
  const last = rounds[rounds.length - 1]?.sentences ?? [];
  const why = cycle.state !== "running" ? [...last].reverse().find((x) => DECIDING.has(x.stage))?.text : undefined;
  return { rounds: rounds.filter((r) => r.sentences.length > 0), ...(closing && { closing }), ...(why && { why }) };
}
