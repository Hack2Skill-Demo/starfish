/**
 * The incident store, read and triaged from the browser.
 *
 * Reads the collection the engine writes (src/ingest/store.ts) through the
 * Firebase client SDK; firestore.rules is what enforces who may do what. The
 * query is an equality on `environment` plus a range + order on `lastOccurredAt`,
 * served by the composite index in firestore.indexes.json (the environment filter
 * is also what lets the rules serve a guest's query). Status, service and function
 * filters apply client-side over that window.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  deleteField,
} from "firebase/firestore";
import { firestore } from "./firebase";
import { webConfig } from "./config";

export const INCIDENT_STATUSES = ["new", "acknowledged", "logged", "resolved", "recurred", "ignored"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type PrState = "open" | "merged" | "closed";

/** Rows read per query. The page says so when the window holds more. */
export const SCAN_LIMIT = 200;

/** One incident as the UI shows it. Mirrors StoredIncident in src/types.ts. */
export interface IncidentRow {
  id: string;
  functionName: string;
  service: string;
  environment: string;
  errorType: string;
  errorMessage: string;
  errorName?: string;
  errorCode?: string;
  errorDetail?: string;
  stackTrace?: string;
  occurrenceCount: number;
  /** Occurrences inside the selected window, from the hourly buckets. */
  windowedCount: number;
  /** The engine's hourly occurrence buckets (epoch hour → count), when the document has any. */
  occurrencesByHour?: Record<string, number>;
  firstOccurredAt: string;
  lastOccurredAt: string;
  status: IncidentStatus;
  triageState?: string;
  tenantId?: string;
  sourceProjectId?: string;
  /** Present once GitHub integration files an issue (not built yet). */
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  githubPrNumber?: number;
  githubPrUrl?: string;
  githubPrState?: PrState;
  /** Times a resolved incident has come back. 0 for one that never regressed. */
  recurrenceCount: number;
  /** When the latest regression was seen. */
  lastRecurredAt?: string;
  /** The issue that tracked the fix the latest regression broke, when there was one. */
  previousIssueNumber?: number;
  previousIssueUrl?: string;
  /** Written by `pnpm seed-demo` (src/seedDemo.ts), not by any real run: the UI must say so wherever it shows it. */
  synthetic?: true;
}

const MS_PER_HOUR = 3600_000;

/**
 * Sum the epoch-hour buckets of the last `hours` hours, the current one included: 24 buckets for 24h,
 * the same window as the Overview's hourlySeries (overviewModel.ts), so the two pages agree (#144).
 */
export function countInWindow(buckets: Record<string, number> | undefined, hours: number, nowMs = Date.now()): number {
  if (!buckets) return 0;
  const cutoff = Math.floor(nowMs / MS_PER_HOUR) - hours + 1;
  let total = 0;
  for (const [k, v] of Object.entries(buckets)) {
    const hour = Number(k);
    if (Number.isFinite(hour) && hour >= cutoff && typeof v === "number") total += v;
  }
  return total;
}

/** The bucket map with only numeric hours and finite counts, or undefined when nothing usable is left. */
function cleanBuckets(v: unknown): Record<string, number> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (Number.isFinite(Number(k)) && typeof n === "number" && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function iso(v: unknown): string {
  return v instanceof Timestamp ? v.toDate().toISOString() : typeof v === "string" ? v : "";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Map a stored document to a row. Defensive: a malformed field must not blank the page. */
export function toRow(id: string, d: Record<string, unknown>, windowHours: number, nowMs = Date.now()): IncidentRow {
  const status = INCIDENT_STATUSES.includes(d.status as IncidentStatus) ? (d.status as IncidentStatus) : "new";
  const prState = d.githubPrState;
  const last = (d.lastResolution ?? {}) as Record<string, unknown>;
  return {
    id,
    functionName: str(d.functionName) ?? "(unknown)",
    service: str(d.service) ?? "platform",
    environment: str(d.environment) ?? "",
    errorType: str(d.errorType) ?? "UnknownError",
    errorMessage: str(d.errorMessage) ?? "",
    errorName: str(d.errorName),
    errorCode: str(d.errorCode),
    errorDetail: str(d.errorDetail),
    stackTrace: str(d.stackTrace),
    occurrenceCount: typeof d.occurrenceCount === "number" ? d.occurrenceCount : 0,
    windowedCount: countInWindow(d.occurrencesByHour as Record<string, number> | undefined, windowHours, nowMs),
    ...(cleanBuckets(d.occurrencesByHour) && { occurrencesByHour: cleanBuckets(d.occurrencesByHour) }),
    firstOccurredAt: iso(d.firstOccurredAt),
    lastOccurredAt: iso(d.lastOccurredAt),
    status,
    triageState: str(d.triageState),
    tenantId: str(d.tenantId),
    sourceProjectId: str(d.sourceProjectId),
    githubIssueNumber: typeof d.githubIssueNumber === "number" ? d.githubIssueNumber : undefined,
    githubIssueUrl: str(d.githubIssueUrl),
    githubPrNumber: typeof d.githubPrNumber === "number" ? d.githubPrNumber : undefined,
    githubPrUrl: str(d.githubPrUrl),
    githubPrState: prState === "open" || prState === "merged" || prState === "closed" ? prState : undefined,
    recurrenceCount: typeof d.recurrenceCount === "number" ? d.recurrenceCount : 0,
    lastRecurredAt: str(iso(d.lastRecurredAt)),
    previousIssueNumber: typeof last.githubIssueNumber === "number" ? last.githubIssueNumber : undefined,
    previousIssueUrl: str(last.githubIssueUrl),
    ...(d.synthetic === true && { synthetic: true as const }),
  };
}

/**
 * `environment` is the label to filter by: the runtime settings' override when
 * there is one, else the build-time label (see useEnvironment).
 */
export async function listIncidents(
  windowHours: number,
  environment: string
): Promise<{ rows: IncidentRow[]; capped: boolean }> {
  const { incidentCollection } = webConfig();
  const since = Timestamp.fromMillis(Date.now() - windowHours * MS_PER_HOUR);
  const snap = await getDocs(
    query(
      collection(firestore(), incidentCollection),
      // Environments share a store but never mix on screen (the engine labels
      // every incident). Needs the composite index in firestore.indexes.json.
      where("environment", "==", environment),
      where("lastOccurredAt", ">=", since),
      orderBy("lastOccurredAt", "desc"),
      limit(SCAN_LIMIT)
    )
  );
  const now = Date.now();
  return {
    // A retired incident (src/ingest/retire.ts) is closed for good and gone from every list, as it is to the store.
    rows: snap.docs.filter((d) => d.data().retired !== true).map((d) => toRow(d.id, d.data(), windowHours, now)),
    capped: snap.size >= SCAN_LIMIT,
  };
}

/**
 * One incident by id, or null when there is none for this environment. A document of another
 * environment is "none": the list never mixes environments and neither does a link into it. A retired
 * incident (src/ingest/retire.ts) is gone to the UI the same way it is to the store.
 */
export async function getIncident(id: string, environment: string): Promise<IncidentRow | null> {
  const snap = await getDoc(doc(firestore(), webConfig().incidentCollection, id));
  if (!snap.exists()) return null;
  const data = snap.data();
  if (data.environment !== environment || data.retired === true) return null;
  return toRow(snap.id, data, 24);
}

export type IncidentAction = "acknowledge" | "resolve" | "ignore" | "reopen";

/**
 * The status an action moves to, or null when it doesn't apply from the current
 * status. firestore.rules enforces the same table against the stored status.
 *
 * Reopen applies only to an ignored incident. An operator never reopens a
 * resolved one: the engine does, as `recurred`, when its error actually fires
 * again (src/ingest/store.ts). `recurred` is open, so it can be resolved or
 * ignored like any other open incident.
 */
export function nextStatus(current: IncidentStatus, action: IncidentAction): IncidentStatus | null {
  const open = current === "new" || current === "acknowledged" || current === "logged" || current === "recurred";
  switch (action) {
    case "acknowledge":
      return current === "new" ? "acknowledged" : null;
    case "resolve":
      return open ? "resolved" : null;
    case "ignore":
      return open ? "ignored" : null;
    case "reopen":
      return current === "ignored" ? "new" : null;
  }
}

/**
 * Apply an operator action. The write touches only the fields firestore.rules
 * lets an operator change, and records who did it.
 */
export async function applyAction(row: IncidentRow, action: IncidentAction, uid: string): Promise<void> {
  const status = nextStatus(row.status, action);
  if (!status) throw new Error(`Can't ${action} an incident that is ${row.status}`);
  const ref = doc(firestore(), webConfig().incidentCollection, row.id);
  await updateDoc(ref, {
    status,
    updatedAt: serverTimestamp(),
    statusChangedBy: uid,
    ...(status === "resolved" ? { resolvedAt: serverTimestamp() } : { resolvedAt: deleteField() }),
  });
}
