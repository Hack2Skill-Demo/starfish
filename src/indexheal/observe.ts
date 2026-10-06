/**
 * Whether a missing-index heal held (#11): READY and a passing query are not "healed" on their own. A cycle whose index
 * path ended with `summary.index.runtime: "observing"` (src/agent/indexPath.ts) is looked at again once its quiet window
 * (`observeUntil`) has passed, by the agent job after its pass:
 *
 *   recurred        the incident occurred again after the index was READY (its `lastOccurredAt` is later);
 *   query-failing   it stayed quiet, but the configured query does not pass any more;
 *   unverified      no probe can be run for it now (the probe was removed from the configuration), or the incident is gone;
 *   healed          no occurrence since READY, for the whole window, and the configured query passes at its end.
 *
 * "Quiet" is the incident's own record: no occurrence since READY. Starfish does not measure the traffic that would
 * have run the query in that window; the replayed probe at the end is what stands in for it, and the record says so.
 *
 * Only `summary.index.runtime` (and when it was decided) is written, on a cycle still `observing`, in a transaction: the
 * cycle's state and path are not changed, and the incident is never touched. Resolving it stays a person's decision.
 * A probe or read that fails leaves the cycle observing, to be tried at the next pass.
 */
import type { Firestore, Timestamp } from "firebase-admin/firestore";
import { COLLECTION_RE, DATABASE_RE, FIELD_PATH_RE, PROJECT_RE, type IndexSpec } from "./createIndexUrl.js";
import type { ProbeVerdict } from "./probe.js";

export type RuntimeVerdict = "healed" | "recurred" | "query-failing" | "unverified";

export interface ObserveDeps {
  db: Firestore;
  /** `ingestLagMinutes`: an occurrence inside the window may reach the store this much later, so the decision waits for it. */
  config: { cycleCollection: string; incidentCollection: string; environment: string; ingestLagMinutes: number };
  probe: (spec: IndexSpec) => Promise<ProbeVerdict>;
  now: () => Date;
  /** The most cycles looked at in one go. */
  limit?: number;
}

export interface ObserveSummary {
  considered: number;
  /** Still inside their window. */
  waiting: number;
  decided: { cycleId: string; runtime: RuntimeVerdict }[];
  /** Cycles left observing because a read or the probe failed. */
  errors: { cycleId: string; message: string }[];
}

const isoMs = (v: unknown): number | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const tsMs = (v: unknown): number | null => {
  const t = v as Timestamp | null | undefined;
  return typeof t?.toMillis === "function" ? t.toMillis() : isoMs(v);
};

/** The spec back from the run record's flat fields, or null when they are not one (then nothing can be replayed). */
export function specFromRecord(r: Record<string, unknown>): IndexSpec | null {
  const { project, database, collectionGroup, queryScope, fields } = r;
  if (typeof project !== "string" || !PROJECT_RE.test(project)) return null;
  if (typeof database !== "string" || !DATABASE_RE.test(database)) return null;
  if (typeof collectionGroup !== "string" || !COLLECTION_RE.test(collectionGroup)) return null;
  if (queryScope !== "COLLECTION" && queryScope !== "COLLECTION_GROUP") return null;
  if (typeof fields !== "string" || fields === "") return null;
  const parsed: IndexSpec["fields"] = [];
  for (const part of fields.split(", ")) {
    const [fieldPath, order, ...rest] = part.split(" ");
    if (rest.length > 0 || fieldPath === undefined || !FIELD_PATH_RE.test(fieldPath) || (order !== "ASCENDING" && order !== "DESCENDING")) return null;
    parsed.push({ fieldPath, order });
  }
  return { project, database, collectionGroup, queryScope, fields: parsed };
}

export async function observeIndexHeals(deps: ObserveDeps): Promise<ObserveSummary> {
  const { db, config: cfg } = deps;
  const now = deps.now();
  const snap = await db
    .collection(cfg.cycleCollection)
    .where("environment", "==", cfg.environment)
    .where("summary.index.runtime", "==", "observing")
    .limit(deps.limit ?? 20)
    .get();
  const out: ObserveSummary = { considered: 0, waiting: 0, decided: [], errors: [] };
  for (const doc of snap.docs) {
    const d = doc.data();
    out.considered += 1;
    const rec = ((d.summary as Record<string, unknown> | undefined)?.index ?? {}) as Record<string, unknown>;
    const readyAt = isoMs(rec.readyAt);
    const until = isoMs(rec.observeUntil);
    if (readyAt === null || until === null) {
      out.errors.push({ cycleId: doc.id, message: "the record has no readable window" });
      continue;
    }
    if (now.getTime() < until + cfg.ingestLagMinutes * 60_000) {
      out.waiting += 1;
      continue;
    }
    let runtime: RuntimeVerdict;
    try {
      const incident = typeof d.incidentId === "string" ? await db.collection(cfg.incidentCollection).doc(d.incidentId).get() : null;
      const last = incident?.exists ? tsMs(incident.data()?.lastOccurredAt) : null;
      const spec = specFromRecord(rec);
      if (!incident?.exists || spec === null) runtime = "unverified";
      else if (last !== null && last > readyAt) runtime = "recurred";
      else {
        const probe = await deps.probe(spec);
        runtime = probe.state === "passed" ? "healed" : probe.state === "not-configured" ? "unverified" : "query-failing";
      }
    } catch (err) {
      out.errors.push({ cycleId: doc.id, message: err instanceof Error ? err.name : "error" });
      continue;
    }
    const decided = runtime;
    const applied = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const r = (fresh.data()?.summary as Record<string, { runtime?: unknown } | undefined> | undefined)?.index;
      if (r?.runtime !== "observing") return false;
      tx.update(doc.ref, {
        "summary.index.runtime": decided,
        "summary.index.runtimeCheckedAt": now.toISOString(),
        "summary.index.runtimeBasis": "no occurrence since READY, and the configured query replayed at the end; traffic is not measured",
      });
      return true;
    });
    if (applied) out.decided.push({ cycleId: doc.id, runtime: decided });
  }
  return out;
}
