/**
 * Writing the trimmed copies guests read (src/publicView.ts, #18). Only the engine writes them (the Admin SDK);
 * firestore.rules closes the three collections to every client write.
 *
 * How a copy keeps up with its source:
 *   - a RUN EVENT is written once and never changed, so its copy is created in the SAME transaction as the event
 *     (`writePublicEventInTx`, called by src/agent/cycle.ts): an event never exists without its copy;
 *   - an INCIDENT or a CYCLE changes through field transforms (increments, deletes, dotted paths, array unions), so the
 *     document a write leaves behind is only known once it commits. Rather than re-implement Firestore's merge to guess
 *     it inside the writer's transaction, the engine REFRESHES the copy right after each of its writes: one transaction
 *     reads the committed source and sets (or removes) the copy (`refreshPublicIncident`, `refreshPublicCycle`). The
 *     copy is always a function of what is stored, and two refreshes cannot land out of order (each reads the source
 *     in its own transaction);
 *   - writes the engine does not make (an operator's triage in the UI, which may not touch these collections) reach
 *     the copy at the next sweep (`syncRecentPublicView`), which the ingest and agent jobs run after each run;
 *   - records stored before the copies existed are copied by `pnpm public-view` (a dry run unless `--apply`), which
 *     also removes copies whose source is gone, retired, or no longer in a public environment.
 *
 * A refresh never throws: the source write it follows has committed, and failing it now would undo nothing. A failed
 * refresh leaves the copy behind until the next refresh or sweep, and says so in its result.
 */
import { FieldPath, type DocumentData, type Firestore, type Transaction, type WriteBatch } from "firebase-admin/firestore";
import type { StarfishConfig } from "./config.js";
import { isPublicEnvironment, publicEventId, toPublicCycle, toPublicEvent, toPublicIncident, type PublicViewConfig } from "./publicView.js";

export type PublicSyncConfig = PublicViewConfig & Pick<StarfishConfig, "incidentCollection" | "cycleCollection">;

export type RefreshResult = "written" | "deleted" | "unchanged" | "not-public" | "off" | "failed";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** The subcollection src/agent/cycle.ts writes a cycle's events to. */
const EVENTS = "events";
/** Events copied for one cycle at most: a cycle is a handful of stages, so this is a ceiling (the UI reads 200). */
export const MAX_EVENTS_PER_CYCLE = 200;
/** What the sweep looks at per public environment: the newest incidents and cycles, as the UI's own lists show them. */
export const SWEEP_LIMIT = 50;
const PAGE_SIZE = 300;
const WRITES_PER_BATCH = 400;

/** Refresh one copy from its committed source, in one transaction. `environment`, when the caller knows it, saves a read for a private one. */
async function refresh(
  db: Firestore,
  pub: PublicViewConfig,
  sourceCollection: string,
  publicCollection: string,
  id: string,
  project: (d: DocumentData | undefined) => DocumentData | null,
  environment: unknown
): Promise<RefreshResult> {
  if (pub.publicEnvironments.length === 0) return "off";
  if (environment !== undefined && !isPublicEnvironment(pub, environment)) return "not-public";
  if (!ID_RE.test(id)) return "failed";
  try {
    return await db.runTransaction(async (tx): Promise<RefreshResult> => {
      const source = await tx.get(db.collection(sourceCollection).doc(id));
      const d = source.data();
      // A copy is never removed for a private source here: an environment label never changes on a record, and the
      // copies of an environment taken off the public list are removed by `pnpm public-view`.
      if (d !== undefined && !isPublicEnvironment(pub, d.environment)) return "not-public";
      const ref = db.collection(publicCollection).doc(id);
      const projected = project(d);
      if (projected) {
        tx.set(ref, projected);
        return "written";
      }
      // Gone, retired, or no longer a record the UI could show: no copy.
      const existing = await tx.get(ref);
      if (!existing.exists) return "unchanged";
      tx.delete(ref);
      return "deleted";
    });
  } catch {
    return "failed";
  }
}

/** Bring the guest copy of incident `id` up to date with the stored incident. Never throws. */
export function refreshPublicIncident(db: Firestore, cfg: PublicViewConfig & Pick<StarfishConfig, "incidentCollection">, id: string, environment?: unknown): Promise<RefreshResult> {
  return refresh(db, cfg, cfg.incidentCollection, cfg.publicIncidentCollection, id, (d) => toPublicIncident(d, cfg), environment);
}

/** Bring the guest copy of cycle `id` up to date with the stored cycle (not its events: those are copied as written). Never throws. */
export function refreshPublicCycle(db: Firestore, cfg: PublicViewConfig & Pick<StarfishConfig, "cycleCollection">, id: string, environment?: unknown): Promise<RefreshResult> {
  return refresh(db, cfg, cfg.cycleCollection, cfg.publicCycleCollection, id, (d) => toPublicCycle(d, cfg), environment);
}

/**
 * Inside the transaction that creates the event `{cycle}/events/{eventId}`: create its guest copy too, when the event's
 * environment is public. Writes only, so the caller's reads are already done. `pub` absent: no copy (a caller with no
 * public-view settings, such as a test).
 */
export function writePublicEventInTx(tx: Transaction, db: Firestore, pub: PublicViewConfig | undefined, cycleId: string, eventId: string, event: DocumentData): void {
  if (!pub) return;
  const projected = toPublicEvent(cycleId, event, pub);
  if (projected) tx.set(db.collection(pub.publicEventCollection).doc(publicEventId(cycleId, eventId)), projected);
}

/** The guest copy of an event inside a batch (the synthetic demo history writes its events that way). */
export function writePublicEventInBatch(b: WriteBatch, db: Firestore, pub: PublicViewConfig, cycleId: string, eventId: string, event: DocumentData): void {
  const projected = toPublicEvent(cycleId, event, pub);
  if (projected) b.set(db.collection(pub.publicEventCollection).doc(publicEventId(cycleId, eventId)), projected);
}

// ---- Comparing a copy with what it should be ---------------------------------------------------

/** A stable form for comparison: timestamps as their millis, keys sorted. */
function canonical(v: unknown): unknown {
  const ms = (v as { toMillis?: () => unknown } | null | undefined)?.toMillis?.();
  if (typeof ms === "number") return { $t: ms };
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function sameDocument(a: DocumentData | null | undefined, b: DocumentData | null | undefined): boolean {
  return JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
}

// ---- The sweep after each run ------------------------------------------------------------------

export interface SweepSummary {
  incidents: { checked: number; refreshed: number };
  cycles: { checked: number; refreshed: number };
  events: { written: number };
  /** Refreshes or reads that failed: the copy stays behind until the next sweep. */
  failures: number;
}

/**
 * Copy the events of one cycle that have no copy yet (a cycle written before the copies existed, or by a writer that
 * was given no public-view settings). Events never change, so a copy that exists is left alone.
 */
async function copyMissingEvents(db: Firestore, cfg: PublicSyncConfig, cycleId: string): Promise<number> {
  const events = await db.collection(cfg.cycleCollection).doc(cycleId).collection(EVENTS).orderBy(FieldPath.documentId()).limit(MAX_EVENTS_PER_CYCLE).get();
  if (events.empty) return 0;
  const copies = await db.getAll(...events.docs.map((e) => db.collection(cfg.publicEventCollection).doc(publicEventId(cycleId, e.id))));
  const batch = db.batch();
  let written = 0;
  events.docs.forEach((e, i) => {
    if (copies[i]!.exists) return;
    const projected = toPublicEvent(cycleId, e.data(), cfg);
    if (!projected) return;
    batch.set(copies[i]!.ref, projected);
    written += 1;
  });
  if (written > 0) await batch.commit();
  return written;
}

/**
 * Bring the copies of the newest incidents and cycles of each public environment up to date: the ones the UI's lists
 * show (`limit` each, newest first). Picks up what the engine's own refreshes cannot see: an operator's triage in the UI,
 * and a refresh that failed. Reads `limit` sources and their copies per kind and environment, and writes only the copies
 * that differ. Never throws.
 */
export async function syncRecentPublicView(db: Firestore, cfg: PublicSyncConfig, limit = SWEEP_LIMIT): Promise<SweepSummary> {
  const out: SweepSummary = { incidents: { checked: 0, refreshed: 0 }, cycles: { checked: 0, refreshed: 0 }, events: { written: 0 }, failures: 0 };
  for (const environment of cfg.publicEnvironments) {
    try {
      const incidents = await db.collection(cfg.incidentCollection).where("environment", "==", environment).orderBy("lastOccurredAt", "desc").limit(limit).get();
      if (!incidents.empty) {
        const copies = await db.getAll(...incidents.docs.map((d) => db.collection(cfg.publicIncidentCollection).doc(d.id)));
        for (const [i, d] of incidents.docs.entries()) {
          out.incidents.checked += 1;
          if (sameDocument(toPublicIncident(d.data(), cfg), copies[i]!.data())) continue;
          const r = await refreshPublicIncident(db, cfg, d.id, environment);
          if (r === "failed") out.failures += 1;
          else out.incidents.refreshed += 1;
        }
      }
    } catch {
      out.failures += 1;
    }
    try {
      const cycles = await db.collection(cfg.cycleCollection).where("environment", "==", environment).orderBy("updatedAt", "desc").limit(limit).get();
      if (!cycles.empty) {
        const copies = await db.getAll(...cycles.docs.map((d) => db.collection(cfg.publicCycleCollection).doc(d.id)));
        for (const [i, d] of cycles.docs.entries()) {
          out.cycles.checked += 1;
          if (sameDocument(toPublicCycle(d.data(), cfg), copies[i]!.data())) continue;
          const r = await refreshPublicCycle(db, cfg, d.id, environment);
          if (r === "failed") {
            out.failures += 1;
            continue;
          }
          out.cycles.refreshed += 1;
          // A cycle whose copy was behind may have events with none either.
          try {
            out.events.written += await copyMissingEvents(db, cfg, d.id);
          } catch {
            out.failures += 1;
          }
        }
      }
    } catch {
      out.failures += 1;
    }
  }
  return out;
}

// ---- The backfill: `pnpm public-view` ----------------------------------------------------------

export interface BackfillCounts {
  /** Copies that are missing or differ from what they should be. */
  write: number;
  /** Copies with no source that may be shown any more (gone, retired, private, or unusable). */
  remove: number;
  /** Copies already right. */
  same: number;
}

export interface BackfillReport {
  incidents: BackfillCounts;
  cycles: BackfillCounts;
  events: BackfillCounts;
  applied: boolean;
  /** Writes that did not go through (a refresh that failed): run it again. */
  failures: number;
}

const zero = (): BackfillCounts => ({ write: 0, remove: 0, same: 0 });

/** Every document of a collection, a page at a time, in id order. */
async function* pages(db: Firestore, collection: string) {
  let last: string | undefined;
  for (;;) {
    let q = db.collection(collection).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (last !== undefined) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) return;
    yield page.docs;
    last = page.docs[page.docs.length - 1]!.id;
  }
}

/**
 * Make every copy what it should be: one for each incident, cycle and event of a public environment, none for anything
 * else. A dry run (`apply` false) only counts. Applied, an incident or cycle copy is written through the same
 * transactional refresh the engine uses, an event copy in a batch (events never change), and a copy that must go is
 * deleted. Running it again on an unchanged store finds nothing to do.
 */
export async function backfillPublicView(db: Firestore, cfg: PublicSyncConfig, opts: { apply: boolean }): Promise<BackfillReport> {
  const report: BackfillReport = { incidents: zero(), cycles: zero(), events: zero(), applied: opts.apply, failures: 0 };
  let batch = db.batch();
  let pending = 0;
  const flush = async () => {
    if (pending > 0) await batch.commit();
    batch = db.batch();
    pending = 0;
  };
  const queue = async (op: (b: WriteBatch) => void) => {
    op(batch);
    pending += 1;
    if (pending >= WRITES_PER_BATCH) await flush();
  };

  // Sources: incidents.
  for await (const docs of pages(db, cfg.incidentCollection)) {
    const wanted = docs.map((d) => toPublicIncident(d.data(), cfg));
    const copies = await db.getAll(...docs.map((d) => db.collection(cfg.publicIncidentCollection).doc(d.id)));
    for (const [i, d] of docs.entries()) {
      const want = wanted[i];
      if (!want) continue; // its copy, if any, is handled with the copies below
      if (sameDocument(want, copies[i]!.data())) {
        report.incidents.same += 1;
        continue;
      }
      report.incidents.write += 1;
      if (opts.apply && (await refreshPublicIncident(db, cfg, d.id)) === "failed") report.failures += 1;
    }
  }

  // Sources: cycles and their events.
  for await (const docs of pages(db, cfg.cycleCollection)) {
    const copies = await db.getAll(...docs.map((d) => db.collection(cfg.publicCycleCollection).doc(d.id)));
    for (const [i, d] of docs.entries()) {
      const want = toPublicCycle(d.data(), cfg);
      if (!want) continue;
      if (sameDocument(want, copies[i]!.data())) report.cycles.same += 1;
      else {
        report.cycles.write += 1;
        if (opts.apply && (await refreshPublicCycle(db, cfg, d.id)) === "failed") report.failures += 1;
      }
      const events = await d.ref.collection(EVENTS).orderBy(FieldPath.documentId()).limit(MAX_EVENTS_PER_CYCLE).get();
      if (events.empty) continue;
      const eventCopies = await db.getAll(...events.docs.map((e) => db.collection(cfg.publicEventCollection).doc(publicEventId(d.id, e.id))));
      for (const [j, e] of events.docs.entries()) {
        const wantEvent = toPublicEvent(d.id, e.data(), cfg);
        if (!wantEvent) continue;
        if (sameDocument(wantEvent, eventCopies[j]!.data())) {
          report.events.same += 1;
          continue;
        }
        report.events.write += 1;
        if (opts.apply) await queue((b) => b.set(eventCopies[j]!.ref, wantEvent));
      }
    }
  }

  // Copies: anything whose source no longer gives one.
  for await (const docs of pages(db, cfg.publicIncidentCollection)) {
    const sources = await db.getAll(...docs.map((d) => db.collection(cfg.incidentCollection).doc(d.id)));
    for (const [i, d] of docs.entries()) {
      if (toPublicIncident(sources[i]!.data(), cfg)) continue;
      report.incidents.remove += 1;
      if (opts.apply) await queue((b) => b.delete(d.ref));
    }
  }
  for await (const docs of pages(db, cfg.publicCycleCollection)) {
    const sources = await db.getAll(...docs.map((d) => db.collection(cfg.cycleCollection).doc(d.id)));
    for (const [i, d] of docs.entries()) {
      if (toPublicCycle(sources[i]!.data(), cfg)) continue;
      report.cycles.remove += 1;
      if (opts.apply) await queue((b) => b.delete(d.ref));
    }
  }
  for await (const docs of pages(db, cfg.publicEventCollection)) {
    const sourceRefs = docs.map((d) => {
      const cycleId = d.get("cycleId") as unknown;
      const eventId = typeof cycleId === "string" && ID_RE.test(cycleId) && d.id.startsWith(`${cycleId}_`) ? d.id.slice(cycleId.length + 1) : "";
      return ID_RE.test(eventId) && typeof cycleId === "string" ? db.collection(cfg.cycleCollection).doc(cycleId).collection(EVENTS).doc(eventId) : null;
    });
    const present = sourceRefs.filter((r): r is NonNullable<typeof r> => r !== null);
    const found = present.length > 0 ? await db.getAll(...present) : [];
    const byPath = new Map(found.map((s) => [s.ref.path, s]));
    for (const [i, d] of docs.entries()) {
      const ref = sourceRefs[i];
      const source = ref ? byPath.get(ref.path) : undefined;
      if (ref && toPublicEvent(ref.parent.parent!.id, source?.data(), cfg)) continue;
      report.events.remove += 1;
      if (opts.apply) await queue((b) => b.delete(d.ref));
    }
  }

  await flush();
  return report;
}
