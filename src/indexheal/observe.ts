/**
 * Whether a missing-index heal held (#11): READY and a passing query are not "healed" on their own. A cycle whose index
 * path ended with `summary.index.runtime: "observing"` (src/agent/indexPath.ts) is looked at again once its quiet window
 * (`observeUntil`) has passed, by the agent job after its pass:
 *
 *   recurred        the incident occurred again after the index was READY (its `lastOccurredAt` is later);
 *   query-failing   it stayed quiet, but the configured query fails again asking for this index;
 *   unverified      no probe can be run for it now (the probe was removed from the configuration), the incident is gone
 *                   or retired (#425: its fingerprint was freed, so the error coming back opens a NEW incident this one
 *                   never records), ingest still had not read the logs through the window a day after it ended, or the
 *                   probe still could not run (inconclusive) a day after it ended;
 *   healed          no occurrence since READY, for the whole window, and the configured query passes at its end. Never
 *                   for a retired incident: its silence proves nothing.
 *
 * "Quiet" is the incident's own record: no occurrence since READY, and only once ingest's checkpoint for this target
 * (src/ingest/run.ts) is at or past the window's end. A stalled ingest records no occurrences either, so a window it
 * has not read through (or no checkpoint at all) is not covered, never quiet: the cycle keeps observing. Starfish does
 * not measure the traffic that would have run the query in that window; the replayed probe at the end is what stands
 * in for it, and the record says so.
 *
 * Only `summary.index.runtime` (and when it was decided) is written, on a cycle still `observing`, in a transaction: the
 * cycle's state and path are not changed, and the incident is never touched. Resolving it stays a person's decision.
 * A probe or read that fails leaves the cycle observing, to be tried at the next pass: that includes a probe that could
 * not run or say anything about this index (`inconclusive`: UNAVAILABLE, a permission, another index named), until the
 * same day-after bound as an uncovered window.
 */
import type { Firestore, Timestamp } from "firebase-admin/firestore";
import { readIngestCheckpoint } from "../ingest/run.js";
import { COLLECTION_RE, DATABASE_RE, FIELD_PATH_RE, PROJECT_RE, type IndexSpec } from "./createIndexUrl.js";
import type { ProbeVerdict } from "./probe.js";
import { GONE_BASIS, INCONCLUSIVE_BASIS, QUIET_BASIS, UNCOVERED_BASIS } from "./runtimeBasis.js";
import type { PublicViewConfig } from "../publicView.js";
import { refreshPublicCycle } from "../publicViewStore.js";

export type RuntimeVerdict = "healed" | "recurred" | "query-failing" | "unverified";

/** How long after its window a heal waits for ingest to read through it before it is recorded unverified. */
export const UNCOVERED_GIVE_UP_MS = 24 * 3600_000;


export interface ObserveDeps {
  db: Firestore;
  /**
   * `ingestLagMinutes`: an occurrence inside the window may reach the store this much later, so the decision waits for it.
   * `runCollection` and `watchedProjectId` name the ingest checkpoint that must cover the window.
   */
  config: {
    cycleCollection: string;
    incidentCollection: string;
    runCollection: string;
    watchedProjectId: string;
    environment: string;
    ingestLagMinutes: number;
  } & PublicViewConfig;
  probe: (spec: IndexSpec) => Promise<ProbeVerdict>;
  now: () => Date;
  /** The most cycles looked at in one go. */
  limit?: number;
}

export interface ObserveSummary {
  considered: number;
  /** Still inside their window. */
  waiting: number;
  /** Past their window, but ingest has not read the logs through it yet (or its checkpoint is unknown): still observing. */
  uncovered: number;
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
  const out: ObserveSummary = { considered: 0, waiting: 0, uncovered: 0, decided: [], errors: [] };
  // Read once per call, when a cycle first needs it; a failed read is that cycle's error, and is tried again for the next.
  let checkpoint: { at: Date | null } | undefined;
  const ingestedThrough = async (): Promise<Date | null> => {
    checkpoint ??= { at: await readIngestCheckpoint(db, cfg.runCollection, { watchedProjectId: cfg.watchedProjectId, environment: cfg.environment }) };
    return checkpoint.at;
  };
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
    let basis = QUIET_BASIS;
    try {
      const incident = typeof d.incidentId === "string" ? await db.collection(cfg.incidentCollection).doc(d.incidentId).get() : null;
      const data = incident?.exists ? incident.data() : undefined;
      const last = data ? tsMs(data.lastOccurredAt) : null;
      const spec = specFromRecord(rec);
      if (!data) {
        runtime = "unverified";
        basis = GONE_BASIS;
      } else if (spec === null) runtime = "unverified";
      // An occurrence after READY is a fact, retired or not: one dated before the retire still accrues onto it.
      else if (last !== null && last > readyAt) runtime = "recurred";
      else if (data.retired === true) {
        // Retired: the error coming back opens a NEW incident, so this record's silence proves nothing (#425).
        runtime = "unverified";
        basis = GONE_BASIS;
      } else {
        // No occurrence recorded is "quiet" only if ingest read the logs through the window (#188).
        const through = await ingestedThrough();
        if (through === null || through.getTime() < until) {
          if (now.getTime() < until + UNCOVERED_GIVE_UP_MS) {
            out.uncovered += 1;
            continue;
          }
          runtime = "unverified";
          basis = UNCOVERED_BASIS;
        } else {
          const probe = await deps.probe(spec);
          if (probe.state === "inconclusive") {
            // The replay could not run (UNAVAILABLE, a permission, the network): a failed read, never "the query fails"
            // (#232). Still observing, tried at the next pass; a day after the window it is given up as unverified.
            if (now.getTime() < until + UNCOVERED_GIVE_UP_MS) {
              out.errors.push({ cycleId: doc.id, message: `probe inconclusive: ${probe.reason}` });
              continue;
            }
            runtime = "unverified";
            basis = INCONCLUSIVE_BASIS;
          } else runtime = probe.state === "passed" ? "healed" : probe.state === "not-configured" ? "unverified" : "query-failing";
        }
      }
    } catch (err) {
      out.errors.push({ cycleId: doc.id, message: err instanceof Error ? err.name : "error" });
      continue;
    }
    const decided = runtime;
    const decidedBasis = basis;
    const applied = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const r = (fresh.data()?.summary as Record<string, { runtime?: unknown } | undefined> | undefined)?.index;
      if (r?.runtime !== "observing") return false;
      tx.update(doc.ref, {
        "summary.index.runtime": decided,
        "summary.index.runtimeCheckedAt": now.toISOString(),
        "summary.index.runtimeBasis": decidedBasis,
      });
      return true;
    });
    if (applied) {
      out.decided.push({ cycleId: doc.id, runtime: decided });
      // The verdict is shown to guests too: the cycle's guest copy, from what was just stored (#18). Never throws.
      await refreshPublicCycle(db, cfg, doc.id, cfg.environment);
    }
  }
  return out;
}
