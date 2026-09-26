import type { Timestamp } from "firebase-admin/firestore";

/**
 * The incident shape Starfish reasons over.
 *
 * Deliberately generic: a connector maps a source (Cloud Logging aggregation, an
 * error tracker, a support queue) onto this. Nothing here is specific to one
 * codebase — that is what makes Starfish pointable at any Firebase/GCP project.
 */
export interface Incident {
  id: string;
  environment: string;
  /** Stable hash of the error identity — the same bug recurring keeps one fingerprint. */
  fingerprint?: string;
  functionName?: string;
  /** Attributed part of the system, or "platform" when unattributable. */
  service?: string;
  errorType?: string;
  errorCode?: string;
  errorName?: string;
  /** The underlying cause when the log carried one beyond its title. PII-redacted. */
  errorDetail?: string;
  httpStatus?: number;
  occurrenceCount?: number;
  firstOccurredAt?: string;
  lastOccurredAt?: string;
  /**
   * Independent re-count straight from the log source. Guards against acting on a
   * metric that disagrees with the underlying logs — a real failure mode, not a
   * hypothetical one.
   */
  logCounterCheck?: LogCounterCheck;
  /** PII-redacted and length-bounded. */
  message?: string;
  /** PII-redacted and length-bounded. */
  stackTrace?: string;
}

/** An independent raw-log count for one function over a fixed window. */
export interface LogCounterCheck {
  window: string;
  count: number;
  /** True when counting stopped at the cap — the real figure is at least `count`. */
  capped?: boolean;
  /** The exact filter counted, so a human can re-run it. PII-free by construction. */
  filter?: string;
  checkedAt?: string;
}

/**
 * Operator-facing lifecycle of an incident:
 *
 * - `new`          just aggregated, nobody has looked at it
 * - `acknowledged` an operator is aware of it
 * - `logged`       tracked in an external issue (set automatically once one is filed)
 * - `resolved`     fixed; manually, or automatically when the linked issue closes
 * - `recurred`     a REGRESSION: it was `resolved` and its fingerprint fired again,
 *                  so the fix didn't hold. Set by the engine on the resolved document
 *                  itself (src/ingest/store.ts), which keeps the broken resolution in
 *                  `lastResolution`. Open until it is resolved again.
 * - `ignored`      deliberately not actioned
 */
export const INCIDENT_STATUSES = ["new", "acknowledged", "logged", "resolved", "recurred", "ignored"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/**
 * Statuses that count as OPEN. A recurrence accrues onto an open incident.
 * `recurred` is open: a regression is live work. Of the closed statuses, a
 * `resolved` incident that fires again is re-opened as `recurred`, while an
 * `ignored` one is left alone and the recurrence opens a fresh incident.
 *
 * Every query that means "open" must use this constant. Adding a status to one
 * query and not another is how a single incident forks into several documents.
 */
export const OPEN_INCIDENT_STATUSES = [
  "new",
  "acknowledged",
  "logged",
  "recurred",
] as const satisfies readonly IncidentStatus[];

/** Where an incident sits in the engine's own workflow. */
export type TriageState = "pending" | "acting" | "declined" | "resolved";

/** How an incident is persisted. Timestamps are Firestore-native. */
export interface StoredIncident {
  functionName: string;
  service: string;
  environment: string;
  errorType: string;
  errorMessage: string;
  occurrenceCount: number;
  /** Epoch-hour key → count, giving a rolling series instead of a flat total. */
  occurrencesByHour: Record<string, number>;
  firstOccurredAt: Timestamp;
  lastOccurredAt: Timestamp;
  /**
   * Operator-owned once the incident exists: the UI changes it (firestore.rules
   * governs how). The engine only ever creates "new" and matches open ones. The
   * triage agent must select on an open status, not on triageState alone, or it
   * will act on incidents an operator already resolved or ignored.
   */
  status: IncidentStatus;
  fingerprint: string;
  triageState: TriageState;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  errorCode?: string;
  errorName?: string;
  errorDetail?: string;
  httpStatus?: number;
  stackTrace?: string;
  tenantId?: string;
  requestId?: string;
  sourceProjectId?: string;
  /** Uid of the operator who last changed `status` from the UI. */
  statusChangedBy?: string;
  /** Set when an operator resolves the incident; cleared on any other status. */
  resolvedAt?: Timestamp;
  /** The linked issue and fix PR. Read by the UI; nothing writes them yet (GitHub integration isn't built). */
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  githubPrNumber?: number;
  githubPrUrl?: string;
  /** How many times a resolved incident has come back. Absent until the first regression. */
  recurrenceCount?: number;
  /** When the latest regression was seen. */
  lastRecurredAt?: Timestamp;
  /** The resolution the latest regression broke, so an operator can see what didn't hold. */
  lastResolution?: IncidentResolution;
}

/**
 * A snapshot of how an incident was resolved, kept when it regresses. Absent
 * fields are omitted, since Firestore rejects undefined. `resolvedBy` is an
 * operator uid: it is for the UI, and must never be sent to the model.
 */
export interface IncidentResolution {
  resolvedAt?: Timestamp;
  resolvedBy?: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  githubPrNumber?: number;
  githubPrUrl?: string;
}

/** What the triage step has to decide before anything else happens. */
export interface TriageVerdict {
  urgent: boolean;
  /** Which signals drove the call — this is the auditable part. */
  reasoning: string;
  /** Present only when urgent: where the model believes the fault lives. */
  suspectedCause?: string | null;
}

/** A fixture pairs an incident with the fix that actually shipped for it. */
export interface SpikeFixture {
  name: string;
  /** What this fixture is testing — fix quality, or the judgment to decline. */
  measures: "fix-quality" | "declines-correctly";
  incident: Incident;
  /** Source excerpts the model is allowed to see. */
  context: { path: string; excerpt: string }[];
  /** Ground truth: what a human actually did, and where. */
  groundTruth: {
    wasUrgent: boolean;
    summary: string;
    reference?: string;
  };
}
