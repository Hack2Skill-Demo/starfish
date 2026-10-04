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
 *   - RECHECKED BEFORE ACTING. Before each stage, and again before the pull request, the incident's
 *     status is read fresh and the automation switch is asked: an operator who resolved or ignored the
 *     incident, or turned automation off, stops the cycle at the next step.
 *   - BOUNDED. At most `modelCallBudget` model calls; at most ONE revision, shared between a failed
 *     verify and a blocking review (a second failure goes to a person); the cycle's own deadline and
 *     attempt cap (cycle.ts) bound the rest. A failure worth retrying (a missing counter-check, a
 *     model that errored) releases the lease so the next run tries again, counted against the cap.
 *   - DRY RUN BY DEFAULT. With `dryRun` (the default) or no opener, a verified, reviewed patch ends the
 *     cycle waiting for a person and nothing is opened. Opening is an interface (`openPullRequest`)
 *     keyed by the cycle id so a retry after a timeout cannot open a second one; the loop never merges
 *     and never deploys.
 *
 * Infrastructure errors (the store, the opener) throw, as in cycle.ts: a worker that cannot reach what it
 * needs must not carry on. The lease then expires and the cycle is resumed.
 *
 * Events hold rule names, counts and hashes, never the patch, a log line or model text beyond the
 * short redacted reasons the stages already produce. Not run by any job yet, and not on the Agent
 * Development Kit: the stage ordering here is plain code, which an ADK workflow can wrap.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import type { IncidentStatus } from "../types.js";
import { OPEN_INCIDENT_STATUSES } from "../types.js";
import {
  acquireLease,
  finishCycle,
  recordEvent,
  releaseLease,
  renewLease,
  type CycleConfig,
  type CycleKey,
  type CyclePath,
  type CycleState,
  type RunEvent,
} from "./cycle.js";
import { proposeFix, type FixRequest, type SourceFile } from "./fixer.js";
import { reviewPatch, type Attack, type ReviewVerdict } from "./reviewer.js";
import { triageIncident, type AskJson, type TriageSubject } from "./triage.js";
import { verifyPatch, type VerifyConfig, type VerifyResult } from "./verifyGate.js";

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
  verify: Pick<VerifyResult, "status" | "rule" | "changedFiles" | "output">;
  review?: { verdict: ReviewVerdict; attacks: Attack[] };
}

export interface LoopDeps {
  db: Firestore;
  config: Pick<StarfishConfig, "dryRun" | "reviewRequired" | "modelCallBudget"> & CycleConfig & VerifyConfig;
  /** This worker's identity, for the lease. */
  owner: string;
  now: () => Date;
  ask?: AskJson;
  load: (incidentId: string) => Promise<LoopSubject | null>;
  /** The incident's status right now, read fresh. null if it is gone. */
  incidentStatus: (incidentId: string) => Promise<IncidentStatus | null>;
  /** The kill switch, asked before each stage and before anything is opened. */
  automationEnabled: () => Promise<boolean>;
  /** Opens (or finds, by `cycleId`) the pull request. Absent means nothing can be opened. */
  openPullRequest?: (req: PullRequestRequest) => Promise<{ number: number; url: string }>;
}

export type LoopResult =
  | { kind: "not-acquired"; reason: string }
  | { kind: "lease-lost" }
  | { kind: "released"; reason: string }
  | { kind: "finished"; state: Exclude<CycleState, "running">; outcome: string };

/** Thrown inside the loop when a fenced write is refused; turned into `lease-lost` at the top. */
class LeaseLost extends Error {}

const MAX_REVISIONS = 1;

export async function runCycle(deps: LoopDeps, key: CycleKey): Promise<LoopResult> {
  const { db, config: cfg, owner } = deps;
  const lease = await acquireLease(db, cfg, key, owner, deps.now());
  if (!lease.acquired) return { kind: "not-acquired", reason: lease.reason };
  const id = lease.cycleId;

  const note = async (event: RunEvent) => {
    const r = await recordEvent(db, cfg, id, owner, deps.now(), event);
    if (!r.ok) throw new LeaseLost();
  };
  const finish = async (state: Exclude<CycleState, "running">, outcome: string, path?: CyclePath): Promise<LoopResult> => {
    const r = await finishCycle(db, cfg, id, owner, deps.now(), state, outcome, path);
    if (!r.ok) throw new LeaseLost();
    return { kind: "finished", state, outcome };
  };
  const release = async (reason: string): Promise<LoopResult> => {
    const r = await releaseLease(db, cfg, id, owner, deps.now(), reason);
    if (!r.ok) throw new LeaseLost();
    return { kind: "released", reason };
  };

  try {
    await note({ stage: "cycle", type: "started", summary: `Attempt ${lease.attempt}${lease.resumed ? " (resumed)" : ""}`, data: { attempt: lease.attempt, resumed: lease.resumed } });

    // Asked before every stage and before anything is opened: a cycle stops at the next step after an
    // operator resolves or ignores the incident, or automation is switched off.
    const stopReason = async (): Promise<string | null> => {
      const status = await deps.incidentStatus(key.incidentId);
      if (status === null) return "incident-gone";
      if (!(OPEN_INCIDENT_STATUSES as readonly string[]).includes(status)) return `incident-${status}`;
      if (!(await deps.automationEnabled())) return "automation-disabled";
      return null;
    };
    const halted = async (): Promise<LoopResult | null> => {
      const why = await stopReason();
      if (why === null) return null;
      await note({ stage: "cycle", type: "stopped", summary: `Stopped before acting: ${why}`, data: { rule: why } });
      return finish("declined", why, "decline");
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
      record: { decision: triage.decision, rule: triage.rule, reason: triage.reason, suspectedCause: triage.suspectedCause ?? null },
    });
    switch (triage.decision) {
      case "skip":
      case "decline":
        return await finish("declined", triage.rule, "decline");
      case "notify":
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
        record: { outcome: fix.outcome, rule: fix.rule, rootCause: fix.rootCause, testAdded: fix.testAdded ?? null, risk: fix.risk ?? null, revisions },
      });
      if (fix.outcome === "error") return await release(fix.rule);
      if (fix.outcome === "declined" || fix.patch === undefined) return await finish("waiting-human", fix.rule, "human");

      const verified = await verifyPatch({ sourceDir: loaded.sourceDir, patch: fix.patch, baseRevision: loaded.baseRevision, config: cfg });
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
      const renewed = await renewLease(db, cfg, id, owner, deps.now());
      if (!renewed.ok) throw new LeaseLost();
      const pr = await deps.openPullRequest({
        cycleId: id,
        incidentId: key.incidentId,
        baseRevision: loaded.baseRevision,
        patch: fix.patch,
        patchSha256: verified.patchSha256,
        rootCause: fix.rootCause,
        risk: fix.risk ?? "",
        verify: { status: verified.status, rule: verified.rule, changedFiles: verified.changedFiles, output: verified.output },
        ...(review && { review }),
      });
      await note({
        stage: "pr",
        type: "opened",
        summary: "Pull request opened",
        data: { number: pr.number, patchSha256: verified.patchSha256 },
        record: { opened: true, number: pr.number, url: pr.url, patchSha256: verified.patchSha256 },
      });
      return await finish("done", "pr-opened", "pr");
    }
  } catch (err) {
    if (err instanceof LeaseLost) return { kind: "lease-lost" };
    throw err;
  }
}
