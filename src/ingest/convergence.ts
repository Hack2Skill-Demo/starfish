/**
 * Which incident one fingerprint's key names, when several stored records hash to it (#432): the ONE rule the store
 * (store.ts, on every upsert), `pnpm rekey` (src/rekey.ts) and `pnpm scrub` (src/scrub.ts) apply. They used to write
 * it each their own way: the store chose among the first 10 records a query returned and rekey among all, so with more
 * forks than that the two could choose different incidents, and rekey would then move the key off the one ingest was
 * accruing onto, freezing it with its cycle and PR.
 *
 * The rule, in order:
 *   1. The incident the key already names, when it holds the fingerprint: a retired one is a tombstone (retire.ts), an
 *      open or resolved one is where occurrences go. A decision once recorded is kept by every writer, so none of them
 *      moves the key from under the others. (One that is ignored is never reopened: the rule goes on.)
 *   2. The earliest open one, by first occurrence.
 *   3. Else the most recently resolved one (by resolution, else last occurrence): the fix that just failed.
 *   4. Else a retired one a key named, the latest retired: a tombstone, whose fingerprint was freed (store.ts).
 *   5. Else none: only ignored ones, or nothing. The store then opens a fresh incident.
 * Ties go to the smaller id, so the choice never depends on the order the records were read in.
 *
 * Pure: no Firestore.
 */
import { OPEN_INCIDENT_STATUSES } from "../types.js";

/** One record that hashes to the fingerprint, as the rule reads it. */
export interface ConvergenceCandidate {
  id: string;
  status: unknown;
  /** A retired record is a candidate only as a tombstone: pass it only when a key named it. */
  retired?: boolean;
  firstOccurredAtMs?: number;
  resolvedAtMs?: number;
  lastOccurredAtMs?: number;
  retiredAtMs?: number;
}

/** The chosen incident, and whether it is one occurrences accrue onto or a retired one's tombstone. */
export interface Convergence {
  id: string;
  as: "live" | "tombstone";
}

const isOpen = (status: unknown) => (OPEN_INCIDENT_STATUSES as readonly unknown[]).includes(status);
const byId = (a: ConvergenceCandidate, b: ConvergenceCandidate) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The incident the key of these records' fingerprint names (see the file comment), or undefined for none. */
export function convergeOn(candidates: readonly ConvergenceCandidate[], keyedId?: string): Convergence | undefined {
  const keyed = keyedId === undefined ? undefined : candidates.find((c) => c.id === keyedId);
  if (keyed?.retired === true) return { id: keyed.id, as: "tombstone" };
  if (keyed && (isOpen(keyed.status) || keyed.status === "resolved")) return { id: keyed.id, as: "live" };

  const live = candidates.filter((c) => c.retired !== true);
  const open = live.filter((c) => isOpen(c.status));
  if (open.length > 0) {
    const first = (c: ConvergenceCandidate) => c.firstOccurredAtMs ?? Infinity;
    return { id: [...open].sort((a, b) => first(a) - first(b) || byId(a, b))[0]!.id, as: "live" };
  }
  const resolved = live.filter((c) => c.status === "resolved");
  if (resolved.length > 0) {
    const when = (c: ConvergenceCandidate) => c.resolvedAtMs ?? c.lastOccurredAtMs ?? -Infinity;
    return { id: [...resolved].sort((a, b) => when(b) - when(a) || byId(a, b))[0]!.id, as: "live" };
  }
  const retired = candidates.filter((c) => c.retired === true);
  if (retired.length > 0) {
    const when = (c: ConvergenceCandidate) => c.retiredAtMs ?? c.lastOccurredAtMs ?? -Infinity;
    return { id: [...retired].sort((a, b) => when(b) - when(a) || byId(a, b))[0]!.id, as: "tombstone" };
  }
  return undefined;
}

/** Epoch ms of a Timestamp-ish field, or undefined. Tolerates partial and legacy documents. */
export function tsMillis(value: unknown): number | undefined {
  const v = value as { toMillis?: unknown } | null | undefined;
  return typeof v?.toMillis === "function" ? (v.toMillis() as number) : undefined;
}

/** A stored record as a candidate. */
export function candidateOf(id: string, data: Record<string, unknown> | undefined): ConvergenceCandidate {
  const first = tsMillis(data?.firstOccurredAt);
  const resolved = tsMillis(data?.resolvedAt);
  const last = tsMillis(data?.lastOccurredAt);
  const retiredAt = tsMillis(data?.retiredAt);
  return {
    id,
    status: data?.status,
    ...(data?.retired === true && { retired: true }),
    ...(first !== undefined && { firstOccurredAtMs: first }),
    ...(resolved !== undefined && { resolvedAtMs: resolved }),
    ...(last !== undefined && { lastOccurredAtMs: last }),
    ...(retiredAt !== undefined && { retiredAtMs: retiredAt }),
  };
}

/** Applied windows remembered per key. A retry only ever replays the latest window or two. */
export const APPLIED_WINDOWS_RETAINED = 32;

/**
 * The applied windows of several keys as one list, each once, oldest first, the newest kept. A window id is its
 * boundaries in ISO form (`ingest/window.ts`), so text order is time order; sorting keeps the newest whatever order the
 * keys were read in (the store drops from the front, {@link APPLIED_WINDOWS_RETAINED}).
 */
export function mergeAppliedWindows(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  for (const list of lists) for (const w of list) seen.add(w);
  return [...seen].sort().slice(-APPLIED_WINDOWS_RETAINED);
}

/** The windows a key document holds. Tolerates a missing or malformed field: nothing applied. */
export function appliedWindowsOf(key: { exists?: boolean; get(field: string): unknown } | undefined): string[] {
  if (!key || key.exists === false) return [];
  const raw = key.get("appliedWindows");
  return Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string") : [];
}
