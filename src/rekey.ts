/**
 * Re-key the stored incidents after the fingerprint changed (#362): `pnpm rekey`.
 *
 * The store finds an incident by fingerprint twice over: through its incident KEY,
 * `{incidentKeyCollection}/{hash(environment, fingerprint)}`, and, when there is none, by querying the stored
 * `fingerprint` field (store.ts `findUnkeyedIncident`). Both are keyed on the fingerprint the record was WRITTEN with.
 * When the fingerprint code changes (#318 took wrappers off, #361 took the stack trace off), the next occurrence of a
 * stored bug hashes to a fingerprint no key and no stored field holds: it opens a NEW incident, the old one freezes
 * with its history, triage and PR, a resolved one that fires again comes back as `new` instead of `recurred`, and the
 * old one's log samples match nothing (counterCheck.ts compares the current fingerprint of each entry).
 *
 * This recomputes, for every live (not retired) incident of one environment, the fingerprint its stored fields hash
 * to with the CURRENT code (`fingerprintOf`, the function the store checks content with, which takes a stored message's
 * stack trace off as ingest now does), and where that differs from the stored one:
 *   - sets the record's `fingerprint` to it (nothing else on the record changes: not its message, status or times);
 *   - points the key of the new fingerprint at the incident the store itself would converge on: the earliest open one
 *     (by first occurrence) when any is open, else the most recently resolved one, as `findUnkeyedIncident` chooses.
 *     Several records can come to share one fingerprint (the bug that #361 forked in two): none is merged or deleted,
 *     the key names one, and the others keep their history and stop accruing. With only ignored ones, no key is written:
 *     the store opens a fresh incident either way. The key keeps the ingest windows it, and the old keys of the
 *     records it now covers, had applied, so a window replayed after the re-key still counts once.
 * A key that is a TOMBSTONE (it names a retired incident that holds the fingerprint, retire.ts) is left as it is, as
 * are retired incidents and their keys, and every old key (a key whose incident no longer hashes to it is ignored by
 * the store: it re-checks content). Nothing is written for a record whose fingerprint did not move.
 *
 * Each fingerprint's records and key are re-read and written in ONE transaction (at most {@link MAX_GROUP_RECORDS}
 * records, well under Firestore's 500 writes), against the same documents an ingest upsert transacts on, so it can run
 * beside the scheduled ingest, and stopping halfway leaves every fingerprint either done or untouched. Running it
 * again finds nothing to do. Dry run by default (the CLI); it reports counts, never a message.
 */
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { fingerprintOf } from "./ingest/fingerprint.js";
import { abortIfClosed, APPLIED_WINDOWS_RETAINED, incidentKeyId, type IncidentStoreConfig } from "./ingest/store.js";
import { OPEN_INCIDENT_STATUSES } from "./types.js";

const PAGE_SIZE = 300;
/** Records re-keyed in one transaction: one update each, plus the key. A larger group is reported, never split. */
export const MAX_GROUP_RECORDS = 400;
/** The fields the re-key reads: what the fingerprint hashes, and what choosing the key's incident needs. */
const READ_FIELDS = [
  "functionName",
  "errorMessage",
  "signalSource",
  "fingerprint",
  "environment",
  "status",
  "retired",
  "firstOccurredAt",
  "resolvedAt",
  "lastOccurredAt",
] as const;

/** One live incident, as the re-key sees it. */
export interface RekeyRecord {
  id: string;
  /** The fingerprint the record holds (anything a legacy record holds). */
  stored: unknown;
  /** The fingerprint its content hashes to with the current code. */
  current: string;
  status: unknown;
  firstOccurredAtMs?: number;
  resolvedAtMs?: number;
  lastOccurredAtMs?: number;
}

const ms = (value: unknown): number | undefined => {
  const v = value as { toMillis?: unknown } | null | undefined;
  return typeof v?.toMillis === "function" ? (v.toMillis() as number) : undefined;
};

/**
 * The record of a stored incident of `environment`, or null when it is not one the re-key touches: another
 * environment, retired, or missing what the fingerprint hashes (the store's `holdsFingerprint` never matches those
 * either). Pure.
 */
export function rekeyRecord(id: string, data: Record<string, unknown> | undefined, environment: string): RekeyRecord | null {
  if (!data || data.environment !== environment || data.retired === true) return null;
  if (data.functionName == null || data.errorMessage == null) return null;
  const first = ms(data.firstOccurredAt);
  const resolved = ms(data.resolvedAt);
  const last = ms(data.lastOccurredAt);
  return {
    id,
    stored: data.fingerprint,
    current: fingerprintOf(data.functionName as string, data.errorMessage as string, data.signalSource),
    status: data.status,
    ...(first !== undefined && { firstOccurredAtMs: first }),
    ...(resolved !== undefined && { resolvedAtMs: resolved }),
    ...(last !== undefined && { lastOccurredAtMs: last }),
  };
}

/** True when the record's stored fingerprint is not the one its content hashes to now. */
export function needsRekey(r: RekeyRecord): boolean {
  return r.stored !== r.current;
}

/** Every record that hashes to one fingerprint now, and which of them hold another. */
export interface RekeyGroup {
  fingerprint: string;
  members: RekeyRecord[];
  changed: RekeyRecord[];
}

/** The fingerprints with at least one record to re-key, in fingerprint order, each with every record that hashes to it. Pure. */
export function planRekey(records: readonly RekeyRecord[]): RekeyGroup[] {
  const byFingerprint = new Map<string, RekeyRecord[]>();
  for (const r of records) {
    const list = byFingerprint.get(r.current);
    if (list) list.push(r);
    else byFingerprint.set(r.current, [r]);
  }
  return [...byFingerprint.entries()]
    .map(([fingerprint, members]) => ({ fingerprint, members, changed: members.filter(needsRekey) }))
    .filter((g) => g.changed.length > 0)
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
}

const isOpen = (status: unknown) => (OPEN_INCIDENT_STATUSES as readonly unknown[]).includes(status);

/**
 * The incident the key of a group's fingerprint names, chosen as the store converges (store.ts `findUnkeyedIncident`):
 * the earliest open one by first occurrence, else the most recently resolved (by resolution, else last occurrence);
 * undefined when every one is ignored. Ties go to the smaller id, so the choice never depends on read order. Pure.
 */
export function keyTarget(members: readonly RekeyRecord[]): string | undefined {
  const byId = (a: RekeyRecord, b: RekeyRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const open = members.filter((m) => isOpen(m.status));
  if (open.length > 0) {
    const first = (m: RekeyRecord) => m.firstOccurredAtMs ?? Infinity;
    return [...open].sort((a, b) => first(a) - first(b) || byId(a, b))[0]!.id;
  }
  const resolved = members.filter((m) => m.status === "resolved");
  if (resolved.length > 0) {
    const when = (m: RekeyRecord) => m.resolvedAtMs ?? m.lastOccurredAtMs ?? -Infinity;
    return [...resolved].sort((a, b) => when(b) - when(a) || byId(a, b))[0]!.id;
  }
  return undefined;
}

/** The applied windows of several keys as one list, each once, in the order first seen, the newest kept. Pure. */
export function mergeAppliedWindows(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  for (const list of lists) for (const w of list) seen.add(w);
  return [...seen].slice(-APPLIED_WINDOWS_RETAINED);
}

function appliedWindows(snap: DocumentSnapshot | undefined): string[] {
  const raw: unknown = snap?.exists ? snap.get("appliedWindows") : undefined;
  return Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string") : [];
}

export interface RekeyReport {
  environment: string;
  /** Incidents of the environment read, retired ones included. */
  scanned: number;
  /** Retired incidents, left as they are with their tombstone keys. */
  retired: number;
  /** Records whose fingerprint moved (dry run: would move). */
  refingerprinted: number;
  /** Fingerprints that several records now share (the forks a fingerprint change joins). */
  shared: number;
  /** Keys written or repointed (applied runs only). */
  keysWritten: number;
  /** Keys left alone because they are a retired incident's tombstone (applied runs only). */
  tombstonesKept: number;
  /** Fingerprints with more than {@link MAX_GROUP_RECORDS} records, left untouched. */
  tooLarge: number;
  applied: boolean;
}

/**
 * Re-key every live incident of `environment` (see the file comment). With `apply: false` it only reads and counts.
 * Infrastructure errors (a read or a commit that fails) throw: the run stops, and running it again finishes the job.
 */
export async function rekeyIncidents(
  db: Firestore,
  store: IncidentStoreConfig,
  opts: { environment: string; apply: boolean; now?: Timestamp }
): Promise<RekeyReport> {
  const { environment, apply } = opts;
  const report: RekeyReport = {
    environment,
    scanned: 0,
    retired: 0,
    refingerprinted: 0,
    shared: 0,
    keysWritten: 0,
    tombstonesKept: 0,
    tooLarge: 0,
    applied: apply,
  };
  const incidents = db.collection(store.incidentCollection);

  const records: RekeyRecord[] = [];
  let last: string | undefined;
  for (;;) {
    let query = incidents.select(...READ_FIELDS).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (last !== undefined) query = query.startAfter(last);
    const page = await query.get();
    if (page.empty) break;
    for (const doc of page.docs) {
      const data = doc.data();
      if (data.environment !== environment) continue;
      report.scanned += 1;
      if (data.retired === true) report.retired += 1;
      const record = rekeyRecord(doc.id, data, environment);
      if (record) records.push(record);
    }
    last = page.docs[page.docs.length - 1]!.id;
  }

  for (const group of planRekey(records)) {
    if (group.members.length > MAX_GROUP_RECORDS) {
      report.tooLarge += 1;
      continue;
    }
    if (!apply) {
      report.refingerprinted += group.changed.length;
      if (group.members.length > 1) report.shared += 1;
      continue;
    }
    const outcome = await rekeyGroup(db, store, environment, group, opts.now ?? Timestamp.now());
    report.refingerprinted += outcome.refingerprinted;
    if (outcome.members > 1) report.shared += 1;
    if (outcome.key === "written") report.keysWritten += 1;
    if (outcome.key === "tombstone") report.tombstonesKept += 1;
  }
  return report;
}

interface GroupOutcome {
  refingerprinted: number;
  members: number;
  key: "written" | "unchanged" | "tombstone" | "none";
}

/** One fingerprint's re-key, re-read and written in one transaction. */
async function rekeyGroup(
  db: Firestore,
  store: IncidentStoreConfig,
  environment: string,
  group: RekeyGroup,
  now: Timestamp
): Promise<GroupOutcome> {
  const incidents = db.collection(store.incidentCollection);
  const keys = db.collection(store.incidentKeyCollection);
  const fp = group.fingerprint;
  const keyRef = keys.doc(incidentKeyId(environment, fp));
  const oldFingerprints = [...new Set(group.changed.map((r) => r.stored).filter((s): s is string => typeof s === "string" && s !== fp))];
  const oldKeyRefs = oldFingerprints.map((old) => keys.doc(incidentKeyId(environment, old)));

  return db.runTransaction((tx) =>
    abortIfClosed(async () => {
      // Every read before any write. The records are read again: an ingest or an operator may have written since the walk.
      const snaps = await tx.getAll(...group.members.map((m) => incidents.doc(m.id)), keyRef, ...oldKeyRefs);
      const memberSnaps = snaps.slice(0, group.members.length);
      const keySnap = snaps[group.members.length]!;
      const oldKeySnaps = snaps.slice(group.members.length + 1);

      const fresh = new Map<string, RekeyRecord>();
      for (const s of memberSnaps) {
        const r = s.exists ? rekeyRecord(s.id, s.data(), environment) : null;
        if (r && r.current === fp) fresh.set(r.id, r);
      }

      // The incident the key names now, when it is not one of the records read: a tombstone, or one ingest opened since.
      const keyedId: unknown = keySnap.exists ? keySnap.get("incidentId") : undefined;
      let keyed: DocumentSnapshot | undefined =
        typeof keyedId === "string" && keyedId !== "" ? memberSnaps.find((s) => s.id === keyedId) : undefined;
      if (keyed === undefined && typeof keyedId === "string" && keyedId !== "") keyed = await tx.get(incidents.doc(keyedId));
      const keyedData = keyed?.exists ? keyed.data() : undefined;
      const keyedHolds =
        keyedData != null &&
        keyedData.functionName != null &&
        keyedData.errorMessage != null &&
        fingerprintOf(keyedData.functionName as string, keyedData.errorMessage as string, keyedData.signalSource) === fp;
      const tombstone = keyedHolds && keyedData.retired === true;
      if (keyedHolds && !tombstone && !fresh.has(keyed!.id)) {
        const r = rekeyRecord(keyed!.id, keyedData, environment);
        if (r) fresh.set(r.id, r);
      }

      const changed = [...fresh.values()].filter(needsRekey);
      for (const r of changed) tx.update(incidents.doc(r.id), { fingerprint: fp });
      const outcome = (key: GroupOutcome["key"]): GroupOutcome => ({ refingerprinted: changed.length, members: fresh.size, key });
      if (changed.length === 0) return outcome("none");
      if (tombstone) return outcome("tombstone");

      const target = keyTarget([...fresh.values()]);
      if (target === undefined) return outcome("none");
      // The windows this fingerprint's key applied, and those of the old keys that named one of these records.
      const covered = new Set(fresh.keys());
      const windows = mergeAppliedWindows([
        appliedWindows(keySnap),
        ...oldKeySnaps.filter((s) => s.exists && covered.has(s.get("incidentId") as string)).map(appliedWindows),
      ]);
      const unchanged =
        keyedId === target && keySnap.get("fingerprint") === fp && JSON.stringify(appliedWindows(keySnap)) === JSON.stringify(windows);
      if (unchanged) return outcome("unchanged");
      tx.set(keyRef, {
        incidentId: target,
        environment,
        fingerprint: fp,
        updatedAt: now,
        ...(windows.length > 0 && { appliedWindows: windows }),
      });
      return outcome("written");
    })
  );
}
