/**
 * The smoke test's check of its OWN planted incident (#91). `scripts/smoke-gcp.sh` plants one ERROR from a function
 * named `starfish-smoke`; this says whether the engine turned THAT entry into an incident, not merely whether it
 * read some log entry. On a project with real errors of its own, "the last run read an entry" proves nothing about
 * the planted one.
 *
 * Pure: the lookup and the cleanup are in smokeCheckCli.ts.
 */
export const SMOKE_FUNCTION = "starfish-smoke";

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
