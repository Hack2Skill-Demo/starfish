/**
 * The kinds of incident the store holds, in ONE table (#435): what each folds together, the fingerprint namespace it
 * hashes into, how triage treats it, whether an admin's class rules may hold it back, and how the UI and the guests'
 * copy name it.
 *
 * Before this table each reader recognised the kinds its own way: triage checked `signalSource` for two of them, the
 * escalation for one, the guests' copy and the UI only for `monitoring` (by field or `mon-` prefix). So a consolidated
 * Cloud Run quota incident read as an ordinary log incident of "cloud-run-platform-quota" everywhere but triage, and an
 * admin's rule "QuotaError -> noise", written for an app's own 429s, silenced the project-wide quota event because the
 * class rules ran before triage's quota gate. Ingest (fingerprint.ts, aggregate.ts), triage, the rules engine, the
 * escalation, the guests' copy (publicView.ts) and the UI (web/src/lib/incidents.ts) all read this table now.
 *
 * Pure and dependency-free: the UI imports it.
 */

/** The `signalSource` a stored record carries; absent means `log`. */
export const INCIDENT_KIND_IDS = ["log", "monitoring", "overflow", "platform-quota"] as const;
export type IncidentKindId = (typeof INCIDENT_KIND_IDS)[number];

/**
 * What one incident of a kind folds together, which is what its fingerprint hashes (fingerprint.ts):
 *   - `error-core`: one function's one error: the canonical function name and the normalized core of the message
 *     (wrappers and a stack trace taken off, volatile tokens collapsed);
 *   - `message`: one function and a fixed message, normalized (the namespaced kinds whose message is fixed text);
 *   - `function-day`: one function and one UTC day, read from the fixed message.
 */
export type IncidentFold = "error-core" | "message" | "function-day";

/** A triage gate: the incident goes to a person, the model is not asked. */
export interface IncidentKindGate {
  rule: "high-cardinality-overflow" | "platform-quota";
  /** The reason a person reads. Fixed text: nothing of the incident in it. */
  reason: string;
}

export interface IncidentKind {
  id: IncidentKindId;
  /** The fingerprint namespace: a log fingerprint is 16 hex characters, so no prefixed one can ever equal it. */
  prefix: "" | "mon-" | "ovf-" | "pq-";
  fold: IncidentFold;
  /** The fixed `errorType` ingest gives an incident of this kind; undefined when the classifier decides (log). */
  errorType?: string;
  /** Present: triage hands the incident to a person without asking the model. */
  gate?: IncidentKindGate;
  /**
   * True when an admin's class rules never apply (src/triageRules.ts `levelCap`). A rule matches the fields a log
   * incident's classifier filled (`errorType`, `service`, ...); a kind whose fields are synthetic would be matched by a
   * rule meant for something else. An operator's correction of the incident itself still applies: a person looked at it.
   */
  overridesClassRules: boolean;
  /** True when the log counter-check recounts its evidence; false when there is no log entry behind it (zero by construction). */
  logRecount: boolean;
  /** True when its occurrence count may make it critical to the escalation (src/oncall/escalation.ts `isCritical`). */
  countMakesCritical: boolean;
  /** How the UI and the guests' copy name the kind; absent for a plain log incident. */
  label?: { badge: string; title: string };
}

export const INCIDENT_KINDS: Readonly<Record<IncidentKindId, IncidentKind>> = {
  log: {
    id: "log",
    prefix: "",
    fold: "error-core",
    overridesClassRules: false,
    logRecount: true,
    countMakesCritical: true,
  },
  monitoring: {
    id: "monitoring",
    prefix: "mon-",
    fold: "message",
    errorType: "UnloggedFailure",
    overridesClassRules: false,
    logRecount: false,
    countMakesCritical: true,
    label: {
      badge: "Monitoring only",
      title: "Opened from Cloud Monitoring alone: failed invocations counted with no ERROR log entry. There is no log message or stack trace.",
    },
  },
  overflow: {
    id: "overflow",
    prefix: "ovf-",
    fold: "function-day",
    errorType: "HighCardinalityOverflow",
    gate: {
      rule: "high-cardinality-overflow",
      reason:
        "This function logged more distinct errors in one day than the daily cap on new incidents allows, and the rest were folded into this one incident. That is a flood or an error that echoes its input, not one cause a fix can aim at: a human should look.",
    },
    overridesClassRules: true,
    logRecount: true,
    // Its count is every folded error added up (#303): anyone who can make a function log many distinct errors could
    // reach the threshold at will, so its occurrences never make it critical.
    countMakesCritical: false,
    label: {
      badge: "Overflow",
      title: "Many distinct errors of one function in one UTC day, past the daily cap on new incidents, counted together here.",
    },
  },
  "platform-quota": {
    id: "platform-quota",
    prefix: "pq-",
    fold: "message",
    // The classifier's quota class, kept so the incident reads as what it is. Class rules never apply to this kind,
    // so a rule on QuotaError written for an app's own 429s cannot hold the project-wide event back (#435).
    errorType: "QuotaError",
    gate: {
      rule: "platform-quota",
      reason:
        "The project exceeded a Cloud Run quota, and requests to its functions were rejected before any of them ran. That is one project-wide event, not a defect in a function: a human should look at the quota or at what spent it (often a deploy rolling many revisions at once).",
    },
    overridesClassRules: true,
    logRecount: true,
    countMakesCritical: true,
    label: {
      badge: "Platform quota",
      title: "Cloud Run rejected requests to the project's functions over its quota before any code ran: one project-wide event.",
    },
  },
};

const isKindId = (v: unknown): v is IncidentKindId => (INCIDENT_KIND_IDS as readonly unknown[]).includes(v);

/**
 * The kind of a stored record or an input: its `signalSource` when it names one, else the namespace its fingerprint
 * sits in, else a log incident (every record before #19 carries neither). Tolerates anything a legacy record holds.
 */
export function incidentKindOf(record: { signalSource?: unknown; fingerprint?: unknown } | null | undefined): IncidentKind {
  if (isKindId(record?.signalSource)) return INCIDENT_KINDS[record.signalSource];
  const fp = record?.fingerprint;
  if (typeof fp === "string") {
    for (const id of INCIDENT_KIND_IDS) {
      const kind = INCIDENT_KINDS[id];
      if (kind.prefix !== "" && fp.startsWith(kind.prefix)) return kind;
    }
  }
  return INCIDENT_KINDS.log;
}
