/**
 * The agent loop (#8): one cycle for one incident, from lease to pull request.
 *
 *   lease -> triage -> fixer -> verify gate -> adversarial review -> pull request
 *
 * It owns no judgment. Each stage is its own tested function (triage.ts, fixer.ts, verifyGate.ts,
 * reviewer.ts); this file orders them, and wraps them in the guarantees that make running them
 * unattended safe:
 *
 *   - ONE WORKER. The cycle is leased (cycle.ts). Every event and the final state are written under
 *     that lease, so a worker that lost it stops at once and can record or open nothing.
 *   - KEPT ALIVE. The lease is renewed about every third of its length while the cycle works, and before verify;
 *     the verifiers that wait call a heartbeat on every poll, which stops them once the lease is lost (#132).
 *   - RECHECKED BEFORE ACTING. Before each stage, before verify, and again before the pull request, the
 *     incident's status is read fresh and the automation switch is asked: an operator who resolved or ignored
 *     the incident settles the cycle at the next step; automation turned off releases it, uncounted, to be
 *     taken up again when it is back on (#133).
 *   - BOUNDED. At most `modelCallBudget` model calls; at most ONE revision, shared between a failed
 *     verify and a blocking review (a second failure goes to a person); the cycle's own deadline and
 *     attempt cap (cycle.ts) bound the rest, and a person is told when either gives a cycle up. A failure
 *     worth retrying (a missing counter-check, a model call that failed) releases the lease so the next run
 *     tries again, counted against the cap; a patch unfit to verify goes to a person.
 *   - ONE PULL REQUEST. An attempt that finds one already opened for its cycle (recorded, or found by the
 *     opener) records it and stops (#134).
 *   - DRY RUN BY DEFAULT. With `dryRun` (the default) or no opener, a verified, reviewed patch ends the
 *     cycle waiting for a person and nothing is opened. Opening is an interface (`openPullRequest`)
 *     keyed by the cycle id so a retry after a timeout cannot open a second one; the loop itself never merges
 *     and never deploys.
 *   - AUTO-MERGE EVIDENCE (#9). Only where auto-merge could apply (`autoMergeAllowed`, dry run off), the loop runs
 *     gate 1 on the proposed patch (blastRadius.ts), and, when it passes, runs the patch's TESTS ALONE on the base
 *     revision through the same verifier, so the run record shows the test failing before the fix (`summary.before`).
 *     When it opens the pull request it records the candidate (`summary.merge`); merging is the agent pass's
 *     separate step (autoMerge.ts). A candidate that fails gate 1 is handed to a person at once.
 *
 * Infrastructure errors (the store, the opener) throw, as in cycle.ts: a worker that cannot reach what it
 * needs must not carry on. The lease then expires and the cycle is resumed.
 *
 * Events hold rule names, counts and hashes, never the patch, a log line or model text beyond the
 * short redacted reasons the stages already produce. Run by the agent job (`pnpm agent`), and not on the Agent
 * Development Kit: the stage ordering here is plain code, which an ADK workflow can wrap.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import type { IncidentStatus, LogCounterCheck } from "../types.js";
import { OPEN_INCIDENT_STATUSES } from "../types.js";
import { redactPii } from "../ingest/redact.js";
import {
  acquireLease,
  cycleId,
  finishCycle,
  recordEvent,
  releaseLease,
  renewLease,
  type CycleConfig,
  LONG_VALUE_KEYS,
  type CycleKey,
  type CyclePath,
  type CycleState,
  type DeclineDecision,
  type RunEvent,
} from "./cycle.js";
import type { IssueRequest } from "../integrations/githubPr.js";
import type { AlertRequest, DeliveryResult, NotifyRequest } from "../integrations/slack.js";
import { proposeFix, type FixRequest, type FixRule, type SourceFile } from "./fixer.js";
import { reviewPatch, type Attack, type ReviewVerdict } from "./reviewer.js";
import { triageIncident, type AskJson, type TriageSubject } from "./triage.js";
import { verifyPatch, type VerifyConfig, type VerifyRequest, type VerifyResult } from "./verifyGate.js";
import { causeClass, type ReconsiderPolicy } from "./reconsider.js";
import { isIndexIncident, runIndexPath, type IndexHealWiring } from "./indexPath.js";
import { assessBlastRadius, testOnlyPatch, type BlastRadius } from "./blastRadius.js";
import { mergeRecordAtOpen } from "./autoMerge.js";
import { sha256 } from "./reviewer.js";

/** Everything about the incident the stages need, assembled by the caller (it owns the repo checkout). */
export interface LoopSubject {
  subject: TriageSubject;
  /** The files shown to the fixer and the reviewer. */
  files: SourceFile[];
  /** A checkout of the target repo at `baseRevision`, never modified. */
  sourceDir: string;
  baseRevision: string;
}

export interface PullRequestRequest {
  /** Idempotency key: the same cycle must never produce two pull requests. */
  cycleId: string;
  incidentId: string;
  baseRevision: string;
  patch: string;
  patchSha256: string;
  rootCause: string;
  risk: string;
  /** The verify gate's result for a code fix. Absent for the index path's evidence PR, which has `index` instead. */
  verify?: Pick<VerifyResult, "status" | "rule" | "changedFiles" | "output">;
  /** The incident's GitHub issue, when one was filed (#17): the pull request then says it closes it. */
  issueNumber?: number;
  review?: { verdict: ReviewVerdict; attacks: Attack[] };
  /** Auto-merge could apply to this pull request (#9): its text then says Starfish may merge it itself. */
  autoMerge?: boolean;
  /**
   * Set for the missing-index heal's evidence pull request (#11): the index that already exists in production and the
   * entry the patch adds to the repository's index file. The body is then a fixed template (no model text).
   */
  index?: IndexEvidence;
}

export interface IndexEvidence {
  project: string;
  database: string;
  collectionGroup: string;
  queryScope: string;
  fields: { fieldPath: string; order: string }[];
  /** True when this cycle created the index; false when it was found already there (and is only recorded). */
  created: boolean;
  operation?: string;
  /** The repository's index file, and whether the patch creates it. */
  indexFile: string;
  fileCreated: boolean;
  /** When the index was READY and the configured query passed again (ISO). */
  readyAt: string;
}

export interface LoopDeps {
  db: Firestore;
  config: Pick<StarfishConfig, "dryRun" | "reviewRequired" | "modelCallBudget" | "uiBaseUrl" | "model" | "incidentCollection" | "autoMergeExcludedPaths"> &
    CycleConfig &
    VerifyConfig;
  /** This worker's identity, for the lease. */
  owner: string;
  now: () => Date;
  /**
   * The model client, bound to the same snapshot as `config` (`createAskJson` in vertex.ts). Required, so a cycle
   * can't fall back to the environment's model and region and record `config.model` for a call it didn't make (#7).
   */
  ask: AskJson;
  load: (incidentId: string) => Promise<LoopSubject | null>;
  /** The incident's status right now, read fresh. null if it is gone. */
  incidentStatus: (incidentId: string) => Promise<IncidentStatus | null>;
  /** The kill switch, asked before each stage and before anything is opened. */
  automationEnabled: () => Promise<boolean>;
  /**
   * Where the verify command runs. Absent: `verifyPatch`, in THIS process (the `in-process` isolation). The agent
   * entrypoint passes a remote verifier for `cloud-run-job` (verifyRemote.ts), so this process never runs the
   * target's code. A failure of the infrastructure throws; a command that failed is a result.
   */
  verify?: (req: VerifyRequest) => Promise<VerifyResult>;
  /** Opens (or finds, by `cycleId`) the pull request. Absent means nothing can be opened. */
  openPullRequest?: (req: PullRequestRequest) => Promise<{ number: number; url: string; headSha?: string }>;
  /**
   * Auto-merge (#9): whether it could apply to this deployment's target right now, read fresh (the switches in
   * autoMerge.ts `mergeBlockedBy`). Absent, or false: nothing about merging is prepared and the pull request is the end.
   */
  autoMergeAllowed?: () => Promise<boolean>;
  /**
   * The pull request this cycle already opened, or null (#134). Asked once at the start of an attempt that has none
   * recorded, so an attempt resumed after the open succeeded but its record did not stops there instead of redoing
   * the work. Absent: only the recorded `summary.pr` is consulted.
   */
  findPullRequest?: (cycleId: string) => Promise<{ number: number; url: string } | null>;
  /**
   * Files (or finds, by `cycleId`) the incident's GitHub issue (#17). Absent means none is filed. A failure is recorded
   * on the cycle and the cycle goes on: the issue is the incident's history, not a step the fix depends on. In a dry run
   * nothing is filed and the record says so.
   */
  openIssue?: (req: IssueRequest) => Promise<{ number: number; url: string }>;
  /**
   * Tells a person (Slack, src/integrations/slack.ts) that this cycle needs them. Absent means nobody is told. It
   * never throws: a failed delivery is a result, recorded on the cycle (`summary.notify`) so it is visible. In a dry
   * run nothing is sent and the record says so.
   */
  notify?: (req: NotifyRequest) => Promise<DeliveryResult>;
  /**
   * Posts the "new incident" message (the `#ops-alerts` channel, src/integrations/slack.ts) once for a cycle Starfish
   * acts on or escalates. Absent means no such channel. Never throws; recorded like `notify` (`summary.alert`); in a
   * dry run nothing is sent and the record says so.
   */
  alert?: (req: AlertRequest) => Promise<DeliveryResult>;
  /**
   * Reconsider a declined cycle when new evidence arrived since its decision (#8, reconsider.ts): the lease acquire
   * reopens it in its own transaction. Absent: a declined cycle stays closed.
   */
  reconsider?: ReconsiderPolicy;
  /**
   * The missing-index heal (#11, indexPath.ts). Present: a `MissingIndexError` incident skips triage and the model and
   * takes the index path. Absent (the default, and whenever no index target is allowed): it is triaged like any other.
   */
  indexHeal?: IndexHealWiring;
}

export type LoopResult =
  | { kind: "not-acquired"; reason: string }
  | { kind: "lease-lost" }
  | { kind: "released"; reason: string }
  | { kind: "finished"; state: Exclude<CycleState, "running">; outcome: string };

/** Thrown inside the loop when a fenced write is refused; turned into `lease-lost` at the top. */
class LeaseLost extends Error {}

/** How many revisions one cycle may make, shared between a failed verify and a blocking review. */
export const MAX_REVISIONS = 1;

const RECONSIDER_SUMMARY = {
  operator: "an operator asked for a retriage",
  burst: "the occurrences grew past the burst threshold since the decline",
  cause: "the incident's structural cause changed since the decline",
} as const;

/** Fixer errors that are the model's patch, not a failed call: retrying would most likely repeat them (#137). */
export const UNFIT_PATCH_RULES: ReadonlySet<FixRule> = new Set<FixRule>(["patch-malformed", "patch-too-large", "patch-contains-secret-shape"]);

/** How many rejected alternatives and review attacks the run record keeps (each value is bounded by cycle.ts). */
export const MAX_RECORDED_ALTERNATIVES = 5;
export const MAX_RECORDED_ATTACKS = 10;
/** A counter-check filter longer than its record value (cycle.ts) is left out rather than cut: a cut filter would count something else. */
const MAX_RECORDED_FILTER = LONG_VALUE_KEYS.counterFilter ?? 0;

/** `alternative1`, `alternative2`...: the run record holds flat values only, so a list is numbered keys. */
function numbered(prefix: string, items: readonly string[], max: number): Record<string, string> {
  const out: Record<string, string> = {};
  items.slice(0, max).forEach((item, i) => {
    out[`${prefix}${i + 1}`] = item;
  });
  return out;
}

/**
 * The independent log recount triage judged on, kept with its decision (#39): the count, its window, whether
 * counting stopped at the cap, when it ran, and the exact filter so a person can run it again. A missing
 * check is recorded as missing (`counterCount: null`), never as zero.
 */
export function counterCheckRecord(check: LogCounterCheck | undefined): Record<string, string | number | boolean | null> {
  if (!check || !Number.isFinite(check.count)) return { counterCount: null };
  return {
    counterCount: check.count,
    counterWindow: check.window,
    counterCapped: check.capped === true,
    ...(check.checkedAt !== undefined && { counterCheckedAt: check.checkedAt }),
    ...(check.filter !== undefined && check.filter.length <= MAX_RECORDED_FILTER && { counterFilter: check.filter }),
  };
}

/**
 * Keeps the lease alive while the loop waits on something slow (a model call, a clone, above all a verify run that can
 * take far longer than one lease, #132). `beat` renews when a third of the lease has gone by since the last renewal,
 * and throws `LeaseLost` once a renewal is refused. A timer beats on its own for the waits that cannot (the in-process
 * gate, a model call); the CI and remote verifiers also beat on every poll, so they stop as soon as the lease is lost.
 * A renewal that fails on the store is not a refusal: it is tried again at the next beat, and the next fenced write
 * proves the lease either way.
 */
function leaseKeeper(renew: () => Promise<boolean>, now: () => number, everyMs: number) {
  let last = now();
  let lost = false;
  let pending: Promise<void> | undefined;
  const beat = async (): Promise<void> => {
    if (!lost && now() - last >= everyMs) {
      pending ??= renew()
        .then(
          (ok) => {
            if (ok) last = now();
            else lost = true;
          },
          () => undefined
        )
        .finally(() => {
          pending = undefined;
        });
      await pending;
    }
    if (lost) throw new LeaseLost();
  };
  const timer = setInterval(() => void beat().catch(() => undefined), everyMs);
  timer.unref();
  return { beat, stop: () => clearInterval(timer) };
}

export async function runCycle(deps: LoopDeps, key: CycleKey): Promise<LoopResult> {
  const { db, config: cfg, owner } = deps;
  const lease = await acquireLease(db, cfg, key, owner, deps.now(), deps.reconsider ? { reconsider: { ...deps.reconsider, incidentCollection: cfg.incidentCollection } } : {});
  if (!lease.acquired) {
    // This call is the one that just gave the cycle up (a later one sees it closed): tell a person, once (#137).
    if (lease.reason === "deadline-passed" || lease.reason === "retries-exhausted") await announceGivenUp(deps, key, lease.reason);
    return { kind: "not-acquired", reason: lease.reason };
  }
  const id = lease.cycleId;

  const note = async (event: RunEvent) => {
    const r = await recordEvent(db, cfg, id, owner, deps.now(), event);
    if (!r.ok) throw new LeaseLost();
  };
  const finish = async (state: Exclude<CycleState, "running">, outcome: string, path?: CyclePath, decision?: DeclineDecision): Promise<LoopResult> => {
    const r = await finishCycle(db, cfg, id, owner, deps.now(), state, outcome, path, decision);
    if (!r.ok) throw new LeaseLost();
    return { kind: "finished", state, outcome };
  };
  const release = async (reason: string, opts: { uncounted?: boolean } = {}): Promise<LoopResult> => {
    const r = await releaseLease(db, cfg, id, owner, deps.now(), reason, opts);
    if (!r.ok) throw new LeaseLost();
    return { kind: "released", reason };
  };
  const renew = async (): Promise<void> => {
    const r = await renewLease(db, cfg, id, owner, deps.now());
    if (!r.ok) throw new LeaseLost();
  };
  const keeper = leaseKeeper(
    async () => (await renewLease(db, cfg, id, owner, deps.now())).ok,
    () => deps.now().getTime(),
    Math.max(1000, (cfg.leaseSeconds * 1000) / 3)
  );

  try {
    await note({
      stage: "cycle",
      type: lease.reconsidered ? "reconsidered" : "started",
      summary: lease.reconsidered
        ? `Declined earlier; triaged again: ${RECONSIDER_SUMMARY[lease.reconsidered]}`
        : `Attempt ${lease.attempt}${lease.resumed ? " (resumed)" : ""}`,
      data: { attempt: lease.attempt, resumed: lease.resumed, ...(lease.reconsidered && { trigger: lease.reconsidered }) },
    });

    // A pull request already opened for this cycle ends it (#134): an attempt resumed after the open succeeded but its
    // record or the finish did not must not redo the pipeline (the CI verifier would rebuild the PR's own branch).
    const priorPr = await openedPullRequest(deps, id);
    if (priorPr) {
      await note({
        stage: "pr",
        type: "opened",
        summary: "Pull request already opened by an earlier attempt",
        data: { number: priorPr.number },
        record: { opened: true, number: priorPr.number, url: priorPr.url, ...(priorPr.patchSha256 !== undefined && { patchSha256: priorPr.patchSha256 }) },
      });
      return priorPr.index ? await finish("done", "index-pr-opened", "index") : await finish("done", "pr-opened", "pr");
    }

    // Asked before every stage and before anything is opened: a cycle stops at the next step after an
    // operator resolves or ignores the incident, or automation is switched off.
    const stopReason = async (): Promise<string | null> => {
      const status = await deps.incidentStatus(key.incidentId);
      if (status === null) return "incident-gone";
      if (!(OPEN_INCIDENT_STATUSES as readonly string[]).includes(status)) return `incident-${status}`;
      if (!(await deps.automationEnabled())) return "automation-disabled";
      return null;
    };
    // An operator who resolved or ignored the incident settles the cycle. The kill switch only pauses it (#133): the
    // lease is released, uncounted, so the cycle is taken up again once automation is back on. The switch also reads
    // "off" when the settings cannot be read, and one failed read must not decline an incident for good.
    const halted = async (): Promise<LoopResult | null> => {
      const why = await stopReason();
      if (why === null) return null;
      await note({ stage: "cycle", type: "stopped", summary: `Stopped before acting: ${why}`, data: { rule: why } });
      if (why === "automation-disabled") return release(why, { uncounted: true });
      return finish("declined", why, "decline");
    };

    // Auto-merge could apply right now (#9): never in a dry run, never without the switches.
    const autoMergeOn = async (): Promise<boolean> => !cfg.dryRun && deps.autoMergeAllowed !== undefined && (await deps.autoMergeAllowed());

    // The incident's GitHub issue: one per cycle Starfish acts on or escalates, none for a declined one. Recorded on the
    // cycle (`summary.issue`) so a resumed attempt reuses it, and so a failure is visible and not silent.
    let issue: { number: number; url: string } | undefined;
    const fileIssue = async (loaded: LoopSubject, path: IssueRequest["path"], reason: string, suspectedCause: string | undefined): Promise<void> => {
      if (!deps.openIssue) return;
      const snap = await db.collection(cfg.cycleCollection).doc(id).get();
      const prior = (snap.data()?.summary as { issue?: { state?: unknown; number?: unknown; url?: unknown } } | undefined)?.issue;
      if (prior?.state === "opened" && typeof prior.number === "number" && typeof prior.url === "string") {
        issue = { number: prior.number, url: prior.url };
        return;
      }
      if (cfg.dryRun) {
        await note({ stage: "issue", type: "dry-run", summary: "An issue would be filed here; nothing filed (dry run)", record: { state: "dry-run" } });
        return;
      }
      await renew();
      const incident = loaded.subject.incident;
      const counter = incident.logCounterCheck;
      let filed: { number: number; url: string };
      try {
        filed = await deps.openIssue({
          cycleId: id,
          incidentId: key.incidentId,
          functionName: incident.functionName ?? "unknown function",
          service: incident.service ?? "unknown",
          errorType: incident.errorType ?? "unknown",
          occurrenceCount: incident.occurrenceCount ?? null,
          fingerprint: incident.fingerprint ?? null,
          counterCheck: counter ? { window: counter.window, count: counter.count, capped: counter.capped === true } : null,
          path,
          reason,
          suspectedCause: suspectedCause ?? null,
          uiBaseUrl: cfg.uiBaseUrl,
          ...(path === "act" && (await autoMergeOn()) && { autoMerge: true }),
        });
      } catch (err) {
        const rule = typeof (err as { rule?: unknown })?.rule === "string" ? (err as { rule: string }).rule : "error";
        await note({ stage: "issue", type: "failed", summary: `The issue could not be filed: ${rule}`, record: { state: "failed", reason: rule } });
        return;
      }
      issue = filed;
      await note({
        stage: "issue",
        type: "opened",
        summary: `Issue #${filed.number} filed`,
        data: { number: filed.number },
        record: { state: "opened", number: filed.number, url: filed.url },
      });
    };

    // A cycle that ends waiting for a person says so, once. Recorded before and after the send, so a crash between the
    // two leaves `pending` and the next attempt posts again (at-least-once: a missed escalation is worse than a repeat),
    // while a recorded `sent` or `failed` is never sent again.
    // The same pattern serves the `#ops-alerts` "new incident" message (`summary.alert`).
    const deliverOnce = async (
      stage: "notify" | "alert",
      words: { dryRun: string; pending: string; sent: string; failed: string },
      send: () => Promise<DeliveryResult>
    ): Promise<void> => {
      if (cfg.dryRun) {
        await note({ stage, type: "dry-run", summary: words.dryRun, record: { state: "dry-run" } });
        return;
      }
      const snap = await db.collection(cfg.cycleCollection).doc(id).get();
      const prior = (snap.data()?.summary as Record<string, { state?: unknown } | undefined> | undefined)?.[stage]?.state;
      if (prior === "sent" || prior === "failed") return;
      if ((await stopReason()) !== null) return;
      await renew();
      await note({ stage, type: "pending", summary: words.pending, record: { state: "pending", attempts: 0 } });
      let result: DeliveryResult;
      try {
        result = await send();
      } catch {
        // The sender promises not to throw; if it does anyway, that is a failed delivery and not a lost cycle.
        result = { state: "failed", attempts: 1, reason: "notifier-error" };
      }
      await note({
        stage,
        type: result.state,
        summary: result.state === "sent" ? words.sent : `${words.failed}: ${result.reason ?? "unknown"}`,
        data: { attempts: result.attempts },
        record: { state: result.state, attempts: result.attempts, ...(result.reason !== undefined && { reason: result.reason }) },
      });
    };
    const about = (loaded: LoopSubject) => {
      const incident = loaded.subject.incident;
      return {
        cycleId: id,
        incidentId: key.incidentId,
        functionName: incident.functionName ?? "unknown function",
        service: incident.service ?? "unknown",
        errorType: incident.errorType ?? "unknown",
        occurrenceCount: incident.occurrenceCount ?? null,
        ...(issue && { issueUrl: issue.url }),
      };
    };
    const announce = async (loaded: LoopSubject, path: NotifyRequest["path"], rule: string, reason: string): Promise<void> => {
      const notify = deps.notify;
      if (!notify) return;
      await deliverOnce(
        "notify",
        { dryRun: "A person would be told here; nothing sent (dry run)", pending: "Telling a person", sent: "A person was told", failed: "A person could not be told" },
        () => notify({ ...about(loaded), path, rule, reason })
      );
    };
    // The `#ops-alerts` "new incident" message: once for every cycle Starfish acts on or escalates, after its issue is
    // filed so the message can link to it. A declined incident gets none, as it gets no issue.
    const alertTeam = async (loaded: LoopSubject, path: AlertRequest["path"], reason: string): Promise<void> => {
      const alert = deps.alert;
      if (!alert) return;
      await deliverOnce(
        "alert",
        { dryRun: "The team would be alerted here; nothing sent (dry run)", pending: "Alerting the team", sent: "The team was alerted", failed: "The team could not be alerted" },
        () => alert({ ...about(loaded), path, reason })
      );
    };

    let modelCalls = 0;
    const overBudget = async (): Promise<LoopResult | null> => {
      if (modelCalls < cfg.modelCallBudget) return null;
      await note({ stage: "cycle", type: "budget", summary: "Model-call budget used up", data: { budget: cfg.modelCallBudget } });
      return finish("failed", "budget-exceeded", "failed");
    };

    const loaded = await deps.load(key.incidentId);
    if (!loaded) {
      await note({ stage: "cycle", type: "stopped", summary: "The incident could not be loaded", data: { rule: "incident-gone" } });
      return await finish("failed", "incident-gone", "failed");
    }

    // ---- the index path (#11): Google's own error names the fix, so no model is asked anything ----------------
    if (deps.indexHeal && isIndexIncident(loaded.subject.incident)) {
      return await runIndexPath({
        db,
        cycleCollection: cfg.cycleCollection,
        dryRun: cfg.dryRun,
        cycleId: id,
        incidentId: key.incidentId,
        loaded,
        now: deps.now,
        wiring: deps.indexHeal,
        note,
        finish: (state, outcome, path) => finish(state, outcome, path),
        release: (reason) => release(reason),
        renew,
        halted,
        stopReason,
        announce: (rule, reason) => announce(loaded, "human", rule, reason),
        fileIssue: async (reason) => {
          await fileIssue(loaded, "index", reason, undefined);
          return issue?.number;
        },
        beat: keeper.beat,
        ...(!cfg.dryRun && deps.openPullRequest && { openPullRequest: deps.openPullRequest }),
      });
    }

    // ---- triage ---------------------------------------------------------------------------------
    let stop = (await halted()) ?? (await overBudget());
    if (stop) return stop;
    modelCalls += 1;
    const triage = await triageIncident(loaded.subject, deps.ask);
    await note({
      stage: "triage",
      type: "decision",
      summary: triage.reason,
      data: { decision: triage.decision, rule: triage.rule },
      record: {
        decision: triage.decision,
        rule: triage.rule,
        reason: triage.reason,
        suspectedCause: triage.suspectedCause ?? null,
        // The configured model, only when the decision was the model's: a gate (missing or zero recount) asked none.
        ...(triage.rule.startsWith("model-") && { model: cfg.model }),
        ...counterCheckRecord(loaded.subject.incident.logCounterCheck),
      },
    });
    // An issue for every incident Starfish acts on or escalates; a declined, skipped or deferred one gets none.
    if (triage.decision === "act" || triage.decision === "notify") {
      await fileIssue(loaded, triage.decision, triage.reason, triage.suspectedCause);
      await alertTeam(loaded, triage.decision, triage.reason);
    }
    switch (triage.decision) {
      case "skip":
      case "decline": {
        // What this decline saw, kept so a later pass can tell new evidence from the same logs read again (#8).
        const incident = loaded.subject.incident;
        const counter = incident.logCounterCheck;
        return await finish("declined", triage.rule, "decline", {
          rule: triage.rule,
          reason: triage.reason,
          suspectedCause: triage.suspectedCause ?? null,
          occurrenceCount: typeof incident.occurrenceCount === "number" ? incident.occurrenceCount : null,
          counterCount: counter && Number.isFinite(counter.count) ? counter.count : null,
          counterWindow: counter?.window ?? null,
          errorType: incident.errorType ?? null,
          causeClass: causeClass(incident),
        });
      }
      case "notify":
        await announce(loaded, "notify", triage.rule, triage.reason);
        return await finish("waiting-human", `notify:${triage.rule}`, "notify");
      case "defer":
      case "error":
        return await release(triage.rule);
      case "act":
        break;
    }

    // ---- fix, verify, review (one revision, shared) ----------------------------------------------
    let feedback: FixRequest["feedback"];
    let revisions = 0;
    for (;;) {
      stop = (await halted()) ?? (await overBudget());
      if (stop) return stop;
      modelCalls += 1;
      const fix = await proposeFix({ subject: loaded.subject, files: loaded.files, ...(feedback && { feedback }) }, deps.ask);
      await note({
        stage: "fix",
        type: fix.outcome,
        summary: fix.rootCause,
        data: { rule: fix.rule, testAdded: fix.testAdded ?? null },
        record: {
          outcome: fix.outcome,
          rule: fix.rule,
          rootCause: fix.rootCause,
          testAdded: fix.testAdded ?? null,
          risk: fix.risk ?? null,
          revisions,
          ...numbered("alternative", fix.rejectedAlternatives ?? [], MAX_RECORDED_ALTERNATIVES),
        },
      });
      // A model that failed, or answered in the wrong shape, may do better next time: released to retry. A patch that is
      // malformed, too large or carries a credential shape is the model's considered answer, and at temperature 0 the
      // next attempt would most likely repeat it: that goes to a person now (#137).
      if (fix.outcome === "error" && !UNFIT_PATCH_RULES.has(fix.rule)) return await release(fix.rule);
      if (fix.outcome !== "proposed" || fix.patch === undefined) {
        await announce(loaded, "human", fix.rule, fix.rootCause);
        return await finish("waiting-human", fix.rule, "human");
      }

      // ---- auto-merge evidence (#9): gate 1, then the patch's tests alone on the base revision -----------------
      let gate1: BlastRadius | undefined;
      if (await autoMergeOn()) {
        gate1 = assessBlastRadius(fix.patch, { excludedPaths: [...cfg.patchExcludedPaths, ...cfg.autoMergeExcludedPaths] });
        if (gate1.allowed) {
          stop = await halted();
          if (stop) return stop;
          await recordFailsBefore(deps, { id, loaded, heartbeat: keeper.beat, note, renew }, fix.patch);
        }
      }

      // The kill switch is asked again before verify: with `github-actions` verify pushes a branch to the target (#138).
      stop = await halted();
      if (stop) return stop;
      // Verify can take far longer than one lease: prove the lease is ours and extend it first; the keeper (and the
      // heartbeat the waiting verifiers call on every poll) keeps it alive while it runs (#132).
      await renew();
      const verified = await (deps.verify ?? verifyPatch)({
        cycleId: id,
        sourceDir: loaded.sourceDir,
        patch: fix.patch,
        baseRevision: loaded.baseRevision,
        config: cfg,
        heartbeat: keeper.beat,
      });
      await note({
        stage: "verify",
        type: verified.status,
        summary: verified.reason,
        data: { rule: verified.rule, patchSha256: verified.patchSha256, files: verified.changedFiles.length, exitCode: verified.exitCode ?? null },
        record: {
          status: verified.status,
          rule: verified.rule,
          patchSha256: verified.patchSha256,
          baseRevision: loaded.baseRevision,
          files: verified.changedFiles.length,
          exitCode: verified.exitCode ?? null,
          durationMs: verified.durationMs,
        },
      });
      if (verified.status !== "passed") {
        if (revisions < MAX_REVISIONS) {
          revisions += 1;
          feedback = { previousPatchSha256: verified.patchSha256, verifyOutput: verified.output || verified.reason };
          continue;
        }
        await announce(loaded, "human", `verify-${verified.rule}`, verified.reason);
        return await finish("waiting-human", `verify-${verified.rule}`, "human");
      }

      let review: { verdict: ReviewVerdict; attacks: Attack[] } | undefined;
      if (cfg.reviewRequired) {
        stop = (await halted()) ?? (await overBudget());
        if (stop) return stop;
        modelCalls += 1;
        const reviewed = await reviewPatch(
          { subject: loaded.subject, patch: fix.patch, verify: verified, files: loaded.files, claimed: { rootCause: fix.rootCause, risk: fix.risk ?? "" } },
          deps.ask
        );
        await note({
          stage: "review",
          type: reviewed.verdict ?? "error",
          summary: reviewed.reason ?? `${reviewed.attacks?.length ?? 0} attacks tried`,
          data: { rule: reviewed.rule, attacks: reviewed.attacks?.length ?? 0, broken: reviewed.attacks?.filter((a) => a.outcome === "broken").length ?? 0 },
          record: {
            verdict: reviewed.verdict ?? null,
            rule: reviewed.rule,
            attacks: reviewed.attacks?.length ?? 0,
            held: reviewed.attacks?.filter((a) => a.outcome === "held").length ?? 0,
            flagged: reviewed.attacks?.filter((a) => a.outcome === "flagged").length ?? 0,
            broken: reviewed.attacks?.filter((a) => a.outcome === "broken").length ?? 0,
            patchSha256: verified.patchSha256,
            ...numbered(
              "attack",
              (reviewed.attacks ?? []).map((a) => `${a.outcome}: ${a.attack} | ${a.detail}`),
              MAX_RECORDED_ATTACKS
            ),
          },
        });
        if (reviewed.verdict === undefined) return await release(reviewed.rule);
        if (reviewed.verdict === "block") {
          if (revisions < MAX_REVISIONS) {
            revisions += 1;
            const broken = (reviewed.attacks ?? []).filter((a) => a.outcome === "broken").map((a) => `${a.attack}: ${a.detail}`);
            feedback = { previousPatchSha256: verified.patchSha256, verifyOutput: `A reviewer broke this patch:\n${broken.join("\n")}` };
            continue;
          }
          await announce(loaded, "human", "review-blocked", "The adversarial review broke the patch, and the one revision did not fix it.");
          return await finish("waiting-human", "review-blocked", "human");
        }
        review = { verdict: reviewed.verdict, attacks: reviewed.attacks ?? [] };
      }

      // ---- the pull request ----------------------------------------------------------------------
      if (cfg.dryRun || !deps.openPullRequest) {
        await note({
          stage: "pr",
          type: "dry-run",
          summary: "Patch verified; nothing opened (dry run)",
          data: { patchSha256: verified.patchSha256 },
          record: { opened: false, reason: "dry-run", patchSha256: verified.patchSha256 },
        });
        return await finish("waiting-human", "dry-run", "draft");
      }
      stop = await halted();
      if (stop) return stop;
      // Opening may take a while: prove the lease is still ours, and extended, before and not after.
      await renew();
      const pr = await deps.openPullRequest({
        cycleId: id,
        incidentId: key.incidentId,
        baseRevision: loaded.baseRevision,
        patch: fix.patch,
        patchSha256: verified.patchSha256,
        rootCause: fix.rootCause,
        risk: fix.risk ?? "",
        verify: { status: verified.status, rule: verified.rule, changedFiles: verified.changedFiles, output: verified.output },
        ...(issue && { issueNumber: issue.number }),
        ...(review && { review }),
        ...(gate1?.allowed === true && { autoMerge: true }),
      });
      await note({
        stage: "pr",
        type: "opened",
        summary: "Pull request opened",
        data: { number: pr.number, patchSha256: verified.patchSha256 },
        record: { opened: true, number: pr.number, url: pr.url, patchSha256: verified.patchSha256 },
      });
      // The auto-merge candidate (#9): pending for the pass's merge step, or handed to a person now when gate 1 failed.
      if (gate1) {
        const record = mergeRecordAtOpen({ gate1, pr, patchSha256: verified.patchSha256, incident: loaded.subject.incident, now: deps.now() });
        const pending = record.state === "pending";
        await note({
          stage: "merge",
          type: String(record.state),
          summary: pending ? "Auto-merge candidate: waiting for the required checks" : `Not auto-merged: ${String(record.reason)}`,
          data: { gate1: gate1.allowed ? "pass" : "fail" },
          record,
        });
        if (!pending) {
          await announce(loaded, "human", "auto-merge-gate1", "The pull request is open, but Starfish may not merge it itself (gate 1, low blast radius, or its head is unknown). A person decides.");
        }
      }
      return await finish("done", "pr-opened", "pr");
    }
  } catch (err) {
    if (err instanceof LeaseLost) return { kind: "lease-lost" };
    throw err;
  } finally {
    keeper.stop();
  }
}

/**
 * The "fails before" half of gate 2 (#9), recorded as `summary.before`: the patch's TEST files alone, on the base revision,
 * through the same verifier the patch goes through. `failed` is the evidence wanted: the test fails without the fix. A
 * patch with no test file, or a verifier that broke, is recorded as such, and gate 2 then fails: missing is not a failure
 * of the test. With `github-actions` this is a commit on `starfish/<cycle>` that the target's CI judges, deleted again.
 */
async function recordFailsBefore(
  deps: LoopDeps,
  ctx: { id: string; loaded: LoopSubject; heartbeat: () => Promise<void>; note: (event: RunEvent) => Promise<void>; renew: () => Promise<void> },
  patch: string
): Promise<void> {
  const forPatchSha256 = sha256(patch);
  const tests = testOnlyPatch(patch);
  if (tests === null) {
    await ctx.note({ stage: "before", type: "unavailable", summary: "No test file in the patch: nothing can show it failing before the fix", record: { status: "unavailable", rule: "no-test-in-patch", forPatchSha256 } });
    return;
  }
  await ctx.renew();
  let ran: VerifyResult;
  try {
    ran = await (deps.verify ?? verifyPatch)({ cycleId: ctx.id, sourceDir: ctx.loaded.sourceDir, patch: tests, baseRevision: ctx.loaded.baseRevision, config: deps.config, heartbeat: ctx.heartbeat });
  } catch (err) {
    if (err instanceof LeaseLost) throw err;
    await ctx.note({ stage: "before", type: "error", summary: "The run of the tests before the fix could not be completed", record: { status: "error", rule: "verifier-error", forPatchSha256 } });
    return;
  }
  await ctx.note({
    stage: "before",
    type: ran.status,
    summary: ran.status === "failed" ? "The patch's tests fail without the fix, as they should" : `The patch's tests alone: ${ran.reason}`,
    data: { rule: ran.rule, exitCode: ran.exitCode ?? null },
    record: { status: ran.status, rule: ran.rule, patchSha256: ran.patchSha256, forPatchSha256, exitCode: ran.exitCode ?? null },
  });
}

/** The pull request this cycle already opened: recorded on the cycle, or found by the opener's own lookup. */
async function openedPullRequest(deps: LoopDeps, id: string): Promise<{ number: number; url: string; patchSha256?: string; index: boolean } | null> {
  const snap = await deps.db.collection(deps.config.cycleCollection).doc(id).get();
  const summary = snap.data()?.summary as { pr?: { opened?: unknown; number?: unknown; url?: unknown; patchSha256?: unknown }; index?: unknown } | undefined;
  // An index cycle's PR is its evidence PR: the cycle keeps the index path (and its runtime record) when it is resumed.
  const index = summary?.index !== undefined;
  const pr = summary?.pr;
  if (pr?.opened === true && typeof pr.number === "number" && typeof pr.url === "string") {
    return { number: pr.number, url: pr.url, ...(typeof pr.patchSha256 === "string" && { patchSha256: pr.patchSha256 }), index };
  }
  if (deps.config.dryRun || !deps.openPullRequest || !deps.findPullRequest) return null;
  const found = await deps.findPullRequest(id);
  return found && { ...found, index };
}

/**
 * A cycle just given up on (its deadline passed, or its attempts ran out) is not left to fail silently (#137): a person
 * is told, once, and the delivery is recorded on the cycle (`summary.notify`). Only the worker whose acquire made that
 * transition gets here: every later one finds the cycle closed. No lease is held any more, so the record is written
 * straight to the (now failed) cycle. Never throws: the cycle is already settled, and a failure here must not read as
 * an infrastructure error of the pass.
 */
async function announceGivenUp(deps: LoopDeps, key: CycleKey, rule: "deadline-passed" | "retries-exhausted"): Promise<void> {
  if (!deps.notify) return;
  const id = cycleId(key);
  if (id === null) return;
  const { db, config: cfg } = deps;
  try {
    const ref = db.collection(cfg.cycleCollection).doc(id);
    if (cfg.dryRun) {
      await ref.update({ "summary.notify": { state: "dry-run" } });
      return;
    }
    const incident = (await db.collection(cfg.incidentCollection).doc(key.incidentId).get()).data() ?? {};
    const text = (v: unknown, fallback: string) => (typeof v === "string" && v !== "" ? v : fallback);
    let result: DeliveryResult;
    try {
      result = await deps.notify({
        cycleId: id,
        incidentId: key.incidentId,
        functionName: text(incident.functionName, "unknown function"),
        service: text(incident.service, "unknown"),
        errorType: text(incident.errorType, "unknown"),
        occurrenceCount: typeof incident.occurrenceCount === "number" && Number.isFinite(incident.occurrenceCount) ? incident.occurrenceCount : null,
        path: "human",
        rule,
        reason:
          rule === "deadline-passed"
            ? "Starfish ran out of time on this incident before it could finish with it, so it has stopped trying."
            : "Starfish tried this incident as many times as it may and could not finish, so it has stopped trying.",
      });
    } catch {
      result = { state: "failed", attempts: 1, reason: "notifier-error" };
    }
    await ref.update({
      "summary.notify": { state: result.state, attempts: result.attempts, ...(result.reason !== undefined && { reason: redactPii(result.reason).slice(0, 300) }) },
    });
  } catch {
    // The store or the incident read failed: nothing more can be done for a cycle that is already settled.
  }
}
