/**
 * Fast-revert (#9): the safety net auto-merge does not ship without. When the incident a Starfish merge was meant to fix
 * comes back soon after that merge, Starfish opens a revert of its OWN merge commit and merges it once the required
 * checks pass, and tells a person either way.
 *
 * The watch. Every merge autoMerge.ts records starts `summary.revert` in `watching`, until `fastRevertMinutes` after the
 * merge. The incident has come back (`recurredAfterMerge`, pure) when it was seen again later than
 * `fastRevertGraceMinutes` after the merge and within the window: its `lastOccurredAt`, a regression the ingest marked
 * (`recurred`, a higher `recurrenceCount`, `lastRecurredAt`), or an hour of its occurrence series that starts after the
 * grace and no later than the window's end (or the first such hour, for a window shorter than an hour), so an error that
 * keeps firing past the window is still seen (#201). HONESTLY: the window starts at the MERGE, not at the deployment, because Starfish cannot observe when the
 * target's CI/CD finishes deploying (#9 keeps "start at deployment completion" open). The grace stands in for the deploy:
 * an error seen during it is the old code still running, not the fix failing. A deploy slower than the grace would
 * look like a recurrence; set the grace above the target's deploy time.
 *
 * What it will not do:
 *   - Revert a revert. Only a merge recorded in `summary.merge` is ever watched; the revert's own merge is recorded in
 *     `summary.revert` and nothing watches that.
 *   - Overwrite someone else's change. If a later commit on the base branch touched any file the merge touched, it
 *     escalates instead (githubPr.ts `openRevertPullRequest`).
 *   - Merge a revert whose required checks did not pass, or whose head moved; or act while the switches forbid merging
 *     (then a person is told instead). Automation off pauses it, like everything else.
 *   - Retry a half-done step blindly: a claim left by a worker that stopped is handed to a person.
 *   - Read without bound: at most `maxPrChecksPerPass` watched or pending cycles a pass.
 *
 * Reverts are not counted against the daily merge cap: a cap must never keep a bad merge in place. Never run against
 * real GitHub: tested with a fake client and the Firestore emulator.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { redactPii } from "../ingest/redact.js";
import type { GithubClient } from "../integrations/githubPr.js";
import type { DeliveryResult, NotifyRequest } from "../integrations/slack.js";
import { CLAIM_STALE_MS, cyclesInState, escalate, millis, moveRecord } from "./autoMerge.js";
import type { CycleConfig } from "./cycle.js";
import { summarizeChecks } from "./reconcile.js";

export type FastRevertConfig = Pick<
  StarfishConfig,
  "environment" | "incidentCollection" | "verifyChecks" | "verifyCheckApp" | "maxPrChecksPerPass" | "fastRevertMinutes" | "fastRevertGraceMinutes" | "mergeCheckWaitMinutes"
> &
  CycleConfig;

export type RevertClient = Pick<GithubClient, "openRevertPullRequest" | "readPullRequest" | "listCheckRuns" | "mergePullRequest">;

export interface FastRevertDeps {
  db: Firestore;
  config: FastRevertConfig;
  client: RevertClient;
  now: () => Date;
  owner: string;
  /** The merge switches, read fresh (autoMerge.ts `mergeBlockedBy`). `automation-disabled` pauses. */
  blockedBy: () => Promise<string | null>;
  notify?: (req: NotifyRequest) => Promise<DeliveryResult>;
}

export interface FastRevertSummary {
  considered: number;
  /** Watches closed with no recurrence. */
  cleared: number;
  /** Revert pull requests opened. */
  opened: number;
  reverted: number;
  escalated: number;
  errors: { cycleId: string; message: string }[];
  paused?: boolean;
}

/**
 * After the last hour that counts has ended (`watchSpan`), the watch keeps reading this long, so an occurrence in it that
 * was ingested late still counts.
 */
export const WATCH_SETTLE_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});

/**
 * The times a watch works with, from the merge. `start`/`end`: the window, (merge + grace, merge + `fastRevertMinutes`].
 * `reach`: the latest clock hour whose bucket still counts (see `recurredAfterMerge`): the window's end, or the first
 * hour after `start` when no hour starts inside the window. `closesAt`: when a watch that saw nothing is cleared: an
 * occurrence in the hour starting at `reach` can be as late as `reach` + 1 h, and ingest needs the settle hour after it.
 */
export function watchSpan(mergedAtMs: number, cfg: Pick<FastRevertConfig, "fastRevertMinutes" | "fastRevertGraceMinutes">): { start: number; end: number; reach: number; closesAt: number } {
  const start = mergedAtMs + cfg.fastRevertGraceMinutes * 60_000;
  const end = mergedAtMs + cfg.fastRevertMinutes * 60_000;
  const firstHourAfterStart = (Math.floor(start / HOUR_MS) + 1) * HOUR_MS;
  const reach = Math.max(end, firstHourAfterStart);
  return { start, end, reach, closesAt: reach + HOUR_MS + WATCH_SETTLE_MS };
}

/**
 * Whether the incident came back after Starfish's merge: an occurrence later than the grace after the merge, in the
 * window. Pure. A retired incident never has (its fingerprint was freed: a new occurrence is a new incident).
 *
 * What the store keeps is not every occurrence's time, so the evidence is read for what it proves (#201):
 *   - `lastOccurredAt` is the LATEST occurrence ever seen (store.ts never moves it backwards). In the window: proof.
 *     Past the window it proves nothing about the window, and an error that kept firing is past it by the time the
 *     hourly pass reads it.
 *   - a regression the ingest marked (`recurrenceCount` above the cycle's, `lastRecurredAt` in the window).
 *   - the hourly buckets. Each ingest window's occurrences are counted in the hour of that window's LATEST occurrence,
 *     so a bucket whose hour starts after `start` holds at least one occurrence after `start`: never an occurrence
 *     from before the merge or from the grace, however late it was ingested (a late batch of those lands in an hour
 *     that starts no later than `start`). Its hour may end after the window; the error that matters is one that keeps
 *     firing, so a bucket counts when its hour starts no later than `reach` (`watchSpan`): the window's end, or, when
 *     no hour starts inside the window (a window shorter than an hour), the first hour after `start`. Then an error
 *     that keeps firing through the window always leaves a counted bucket, once that hour is ingested.
 * So a recurrence counted here is always an occurrence after the grace, and less than an hour past the window's end
 * (two, when the window holds no hour boundary). What it can still miss: an ingest window longer than an hour (a catch-up
 * after an ingest outage, `ingestMaxWindowHours`) counts everything in its last hour, which can lie past `reach`.
 * A snapshot of `occurrenceCount` at the merge would add nothing: a late batch from before the merge grows it too.
 */
export function recurredAfterMerge(
  incident: Rec,
  merge: { mergedAtMs: number; recurrence: number },
  cfg: Pick<FastRevertConfig, "fastRevertMinutes" | "fastRevertGraceMinutes">
): boolean {
  if (incident.retired === true) return false;
  const { start, end, reach } = watchSpan(merge.mergedAtMs, cfg);
  if (start >= end) return false;
  const inWindow = (t: number | undefined) => t !== undefined && t > start && t <= end;
  if (inWindow(millis(incident.lastOccurredAt))) return true;
  const recurrences = incident.recurrenceCount;
  if (typeof recurrences === "number" && recurrences > merge.recurrence && inWindow(millis(incident.lastRecurredAt))) return true;
  for (const [key, count] of Object.entries(rec(incident.occurrencesByHour))) {
    const hourStart = Number(key) * HOUR_MS;
    if (Number.isFinite(hourStart) && typeof count === "number" && count > 0 && hourStart > start && hourStart <= reach) return true;
  }
  return false;
}

const describe = (err: unknown) => redactPii(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300);
const ruleOf = (err: unknown) => {
  const rule = (err as { rule?: unknown } | null)?.rule;
  return typeof rule === "string" ? rule : "error";
};

const SENTENCES: Record<string, string> = {
  "intervening-changes": "a later commit changed the same files, so Starfish will not overwrite it",
  "revert-not-possible": "the merge does not revert cleanly",
  "checks-failed": "a required check failed on the revert",
  "checks-timeout": "the revert's required checks did not finish in time",
  "no-required-checks": "no required check is named, so nothing proves the revert is green",
  "head-changed": "the revert's head moved",
  "wrong-base": "the revert pull request no longer targets the configured base branch",
  "revert-closed": "someone closed the revert pull request",
  interrupted: "an earlier attempt was interrupted, and a revert is never retried blindly",
};
const sentence = (reason: string) =>
  `The incident came back after Starfish merged a fix for it, and Starfish could not revert its merge: ${
    reason.startsWith("switch:") ? `merging is not allowed now (${reason.slice(7)})` : reason.startsWith("merge-refused:") ? `GitHub refused the merge (${reason.slice(14)})` : (SENTENCES[reason] ?? reason)
  }. A person needs to revert it or fix forward.`;

/** One bounded round of the fast-revert watch. Never throws for one cycle. */
export async function runFastRevertStep(deps: FastRevertDeps): Promise<FastRevertSummary> {
  const { db, config: cfg, client } = deps;
  const out: FastRevertSummary = { considered: 0, cleared: 0, opened: 0, reverted: 0, escalated: 0, errors: [] };
  if ((await deps.blockedBy()) === "automation-disabled") return { ...out, paused: true };
  const cycles = await cyclesInState(db, cfg, "revert", ["watching", "opening", "pending", "merging"], cfg.maxPrChecksPerPass);
  out.considered = cycles.length;
  for (const cycle of cycles) {
    try {
      const r = await step(cycle);
      if (r === "paused") return { ...out, paused: true };
      if (r !== "unchanged" && r !== "waiting") out[r] += 1;
    } catch (err) {
      out.errors.push({ cycleId: cycle.id, message: describe(err) });
    }
  }
  return out;

  async function step(cycle: { id: string; data: Rec }): Promise<"cleared" | "opened" | "reverted" | "escalated" | "waiting" | "unchanged" | "paused"> {
    const summary = rec(cycle.data.summary);
    const merge = rec(summary.merge);
    const revert = rec(summary.revert);
    const now = deps.now();
    const nowIso = now.toISOString();
    const same = (state: unknown, extra: (r: Rec) => boolean = () => true) => (r: Rec) => r.state === state && r.mergeSha === revert.mergeSha && extra(r);

    const giveUp = async (reason: string, from: (r: Rec) => boolean): Promise<"escalated" | "unchanged"> => {
      const escalation = await escalate(deps, cycle, `fast-revert-${reason.split(":")[0]}`, sentence(reason));
      return (await moveRecord(db, cfg, cycle.id, "revert", from, { ...revert, state: "escalated", reason, escalation, decidedAt: nowIso })) ? "escalated" : "unchanged";
    };

    // Only what a Starfish merge started is ever here; anything else is left alone.
    const mergeSha = revert.mergeSha;
    if (merge.state !== "merged" || typeof mergeSha !== "string" || merge.mergeSha !== mergeSha) return "unchanged";

    if (revert.state === "opening" || revert.state === "merging") {
      const claimedAt = Date.parse(String(revert.claimedAt ?? ""));
      if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < CLAIM_STALE_MS) return "unchanged";
      return giveUp("interrupted", same(revert.state, (r) => r.claimedAt === revert.claimedAt));
    }

    if (revert.state === "watching") {
      const mergedAtMs = millis(revert.mergedAt);
      if (mergedAtMs === undefined) return giveUp("merge-time-unknown", same("watching"));
      const incidentId = String(cycle.data.incidentId ?? "");
      const incident = incidentId ? ((await db.collection(cfg.incidentCollection).doc(incidentId).get()).data() ?? {}) : {};
      const recurrence = typeof cycle.data.recurrence === "number" ? cycle.data.recurrence : 0;
      if (!recurredAfterMerge(incident, { mergedAtMs, recurrence }, cfg)) {
        if (now.getTime() > watchSpan(mergedAtMs, cfg).closesAt) {
          return (await moveRecord(db, cfg, cycle.id, "revert", same("watching"), { ...revert, state: "clear", decidedAt: nowIso })) ? "cleared" : "unchanged";
        }
        return "waiting";
      }
      const blocked = await deps.blockedBy();
      if (blocked === "automation-disabled") return "paused";
      if (blocked !== null) return giveUp(`switch:${blocked}`, same("watching"));
      const claimedAt = nowIso;
      if (!(await moveRecord(db, cfg, cycle.id, "revert", same("watching"), { ...revert, state: "opening", claimedBy: deps.owner, claimedAt, detectedAt: nowIso }))) return "unchanged";
      const mine = same("opening", (r) => r.claimedAt === claimedAt && r.claimedBy === deps.owner);
      const opening = { ...revert, claimedBy: deps.owner, claimedAt, detectedAt: nowIso };
      let pr: { number: number; url: string; headSha: string };
      try {
        pr = await client.openRevertPullRequest({
          cycleId: cycle.id,
          mergeSha,
          mergedPr: Number(merge.number),
          reason: `The same incident was seen again after Starfish merged #${Number(merge.number)} at ${String(revert.mergedAt)}, within the ${cfg.fastRevertMinutes}-minute fast-revert window.`,
        });
      } catch (err) {
        const escalation = await escalate(deps, cycle, `fast-revert-${ruleOf(err)}`, sentence(ruleOf(err)));
        return (await moveRecord(db, cfg, cycle.id, "revert", mine, { ...opening, state: "escalated", reason: ruleOf(err), escalation, decidedAt: nowIso })) ? "escalated" : "unchanged";
      }
      // A person is told now, whatever happens next: Starfish's fix did not hold.
      const escalation = await escalate(deps, cycle, "fast-revert-opened", `The incident came back after Starfish merged a fix for it. Starfish opened revert #${pr.number} and merges it once the required checks pass.`);
      return (await moveRecord(db, cfg, cycle.id, "revert", mine, { ...opening, state: "pending", number: pr.number, headSha: pr.headSha, openedAt: nowIso, escalation })) ? "opened" : "unchanged";
    }

    // pending: the revert pull request is open; merge it once its required checks pass.
    const number = revert.number;
    const headSha = revert.headSha;
    if (typeof number !== "number" || typeof headSha !== "string") return giveUp("revert-unknown", same("pending"));
    const revertId = `revert-${cycle.id}`;
    let pr: Awaited<ReturnType<RevertClient["readPullRequest"]>>;
    try {
      pr = await client.readPullRequest(revertId, number);
    } catch (err) {
      // A revert retargeted to another base is refused by the client (#186): a person decides, it is not retried.
      if (ruleOf(err) === "wrong-base") return giveUp("wrong-base", same("pending"));
      throw err;
    }
    if (pr.state === "merged") {
      return (await moveRecord(db, cfg, cycle.id, "revert", same("pending"), { ...revert, state: "reverted", by: "person", revertSha: pr.mergeCommitSha ?? null, decidedAt: nowIso })) ? "reverted" : "unchanged";
    }
    if (pr.state === "closed") return giveUp("revert-closed", same("pending"));
    if (pr.headSha !== headSha) return giveUp("head-changed", same("pending"));
    const checks = summarizeChecks(cfg.verifyChecks.length > 0 ? await client.listCheckRuns(headSha) : [], cfg.verifyChecks, cfg.verifyCheckApp);
    if (checks.checks === "not-configured") return giveUp("no-required-checks", same("pending"));
    if (checks.checks === "failed") return giveUp("checks-failed", same("pending"));
    if (checks.checks !== "passed") {
      const opened = Date.parse(String(revert.openedAt ?? ""));
      if (!Number.isFinite(opened) || now.getTime() - opened > cfg.mergeCheckWaitMinutes * 60_000) return giveUp("checks-timeout", same("pending"));
      return "waiting";
    }
    const blocked = await deps.blockedBy();
    if (blocked === "automation-disabled") return "paused";
    if (blocked !== null) return giveUp(`switch:${blocked}`, same("pending"));
    const claimedAt = nowIso;
    if (!(await moveRecord(db, cfg, cycle.id, "revert", same("pending"), { ...revert, state: "merging", claimedBy: deps.owner, claimedAt }))) return "unchanged";
    const mine = same("merging", (r) => r.claimedAt === claimedAt && r.claimedBy === deps.owner);
    const merging = { ...revert, claimedBy: deps.owner, claimedAt };
    let merged: { sha: string };
    try {
      merged = await client.mergePullRequest(revertId, number, headSha, {
        title: `Starfish: revert its merge of #${Number(merge.number)}`,
        body: `Fast-revert: the incident came back after the merge.\n\nRun: ${cycle.id}\nReverts: ${mergeSha}`,
      });
    } catch (err) {
      const reason = `merge-refused:${ruleOf(err)}`;
      const escalation = await escalate(deps, cycle, "fast-revert-merge-refused", sentence(reason));
      return (await moveRecord(db, cfg, cycle.id, "revert", mine, { ...merging, state: "escalated", reason, escalation, decidedAt: nowIso })) ? "escalated" : "unchanged";
    }
    return (await moveRecord(db, cfg, cycle.id, "revert", mine, { ...merging, state: "reverted", by: "starfish", revertSha: merged.sha, decidedAt: nowIso })) ? "reverted" : "unchanged";
  }
}
