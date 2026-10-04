/**
 * Run ingest now, on an admin's request (#65): for recording the demo, where the wait between "the
 * error happens" and "Starfish picks it up" has to be short, and for the scenario runner, which starts
 * two runs together to test overlapping ones.
 *
 * It is the scheduled run, not a lookalike: the same `runIngest` (same windows, same checkpoint, same
 * last-run record), so an on-demand run produces the result a scheduled one would, and two together
 * converge on the same windows (run.ts). What it adds is the gate and the record: only an admin, checked
 * from the operator record (adminAuth.ts), and an audit entry written BEFORE the run so a trigger is on
 * record even if the run fails or never finishes.
 *
 * This is the function behind the trigger. The endpoint or Settings action that calls it does not exist
 * (it needs the deploy path, #6): whoever builds it must authenticate the person and pass their uid.
 * The short schedule is not here either: the schedule lives in Cloud Scheduler, and a setting that
 * nothing reads would be a control that does nothing.
 */
import { Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { isAdmin, isValidUid } from "../adminAuth.js";
import { runIngest, type ConfigResolver, type RunDeps, type RunSummary } from "./run.js";

export type TriggerConfig = Pick<StarfishConfig, "usersCollection" | "auditCollection">;

export type TriggerResult = { ok: true; summary: RunSummary } | { ok: false; reason: "not-admin" | "invalid-id" };

export async function triggerIngest(
  db: Firestore,
  cfg: TriggerConfig,
  loader: ConfigResolver,
  actorUid: string,
  now: Date = new Date(),
  deps?: RunDeps
): Promise<TriggerResult> {
  if (!isValidUid(actorUid)) return { ok: false, reason: "invalid-id" };
  if (!(await isAdmin(db, cfg.usersCollection, actorUid))) return { ok: false, reason: "not-admin" };

  await db.collection(cfg.auditCollection).doc().create({
    action: "run-ingest",
    actorUid,
    at: Timestamp.fromDate(now),
  });
  return { ok: true, summary: await runIngest(db, loader, now, deps) };
}
