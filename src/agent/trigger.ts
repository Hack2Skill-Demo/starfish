/**
 * Start one agent pass now, on an admin's request (#276): after an on-demand ingest the new incidents would
 * otherwise wait for the agent's next scheduled tick.
 *
 * It is the scheduled pass, not a lookalike: it starts the deployed agent job, the one Cloud Scheduler starts, so the
 * same switches (dry run, the kill switch, auto-merge), the same caps and the same leases apply, and a pass started
 * here next to a scheduled one does what two ticks together would. Nothing of the pass runs in the caller: the job
 * runs under the agent's own account, and whoever calls this needs only the right to start that job.
 *
 * What it adds is the gate and the record, as `triggerIngest` does: only an admin, checked from the operator record
 * (adminAuth.ts), and an audit entry written BEFORE the start, so a trigger is on record even if the start fails.
 * It returns once the start was accepted, not when the pass ends: the pass reports itself in its cycles. A start that
 * fails throws (`AgentJobStartError`); the caller decides what to tell the person.
 */
import { Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { isAdmin, isValidUid } from "../adminAuth.js";

export type AgentTriggerConfig = Pick<StarfishConfig, "usersCollection" | "auditCollection">;

export type AgentTriggerResult = { ok: true } | { ok: false; reason: "not-admin" | "invalid-id" };

export async function triggerAgentPass(
  db: Firestore,
  cfg: AgentTriggerConfig,
  startJob: () => Promise<void>,
  actorUid: string,
  now: Date = new Date()
): Promise<AgentTriggerResult> {
  if (!isValidUid(actorUid)) return { ok: false, reason: "invalid-id" };
  if (!(await isAdmin(db, cfg.usersCollection, actorUid))) return { ok: false, reason: "not-admin" };

  await db.collection(cfg.auditCollection).doc().create({
    action: "run-agent",
    actorUid,
    at: Timestamp.fromDate(now),
  });
  await startJob();
  return { ok: true };
}
