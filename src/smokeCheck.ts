/**
 * The smoke test's check of its OWN planted incident (#91). `scripts/smoke-gcp.sh` plants one ERROR from a function
 * named `starfish-smoke`; this says whether the engine turned THAT entry into an incident, not merely whether it
 * read some log entry. On a project with real errors of its own, "the last run read an entry" proves nothing about
 * the planted one.
 *
 * `judgeSmoke` is pure; `readSmokeIncidents` is the bounded lookup, and the cleanup is in smokeCheckCli.ts.
 */
import type { Firestore } from "firebase-admin/firestore";

export const SMOKE_FUNCTION = "starfish-smoke";
/** The most smoke incidents one check reads. */
export const SMOKE_LOOKUP_LIMIT = 20;

export interface SmokeIncident {
  id: string;
  functionName: string;
  lastOccurredAt: Date | null;
  retired: boolean;
}

export type SmokeVerdict = { ok: true; incidentId: string } | { ok: false; reason: string };

/**
 * Passes only for a live (not retired) incident of the smoke function whose latest occurrence is at or after the
 * moment the entry was planted: an incident left by an earlier run, or one that was never updated by this plant, does
 * not pass.
 */
export function judgeSmoke(incidents: readonly SmokeIncident[], plantedAt: Date): SmokeVerdict {
  const mine = incidents.filter((i) => i.functionName === SMOKE_FUNCTION && !i.retired);
  if (mine.length === 0) return { ok: false, reason: `no ${SMOKE_FUNCTION} incident exists: the planted error was not read into the store` };
  const fresh = mine.filter((i) => i.lastOccurredAt !== null && i.lastOccurredAt.getTime() >= plantedAt.getTime());
  if (fresh.length === 0) {
    return { ok: false, reason: `a ${SMOKE_FUNCTION} incident exists but its last occurrence is before this plant (${plantedAt.toISOString()}): an earlier run left it, this entry was not read` };
  }
  return { ok: true, incidentId: fresh[0]!.id };
}

/**
 * The environment's smoke incidents, most recent occurrence first, at most `SMOKE_LOOKUP_LIMIT` (#224). Every smoke run
 * leaves a retired incident behind (a retire frees the fingerprint, so the next plant opens a new one), and an
 * unordered read of 20 could stop seeing the fresh one once 20 of those had piled up. Newest first, the incident this
 * plant touched is read unless 20 others occurred later still, and so is a live one an earlier cleanup left, unless
 * 20 newer ones came after it.
 * Needs the composite index (environment, functionName, lastOccurredAt desc) in firestore.indexes.json, which
 * scripts/deploy-gcp.sh deploys with the rules (not with SKIP_FIRESTORE_RULES=1). Until it has built, the query is
 * refused and the check exits non-zero: a failure, never a pass.
 */
export async function readSmokeIncidents(
  db: Firestore,
  config: { incidentCollection: string; environment: string }
): Promise<SmokeIncident[]> {
  const snap = await db
    .collection(config.incidentCollection)
    .where("environment", "==", config.environment)
    .where("functionName", "==", SMOKE_FUNCTION)
    .orderBy("lastOccurredAt", "desc")
    .limit(SMOKE_LOOKUP_LIMIT)
    .get();
  return snap.docs.map((d) => {
    const data = d.data();
    const last = (data.lastOccurredAt as { toDate?: () => Date } | undefined)?.toDate?.();
    return { id: d.id, functionName: String(data.functionName), lastOccurredAt: last ?? null, retired: data.retired === true };
  });
}
