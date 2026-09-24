/**
 * Everything that makes Starfish specific to one deployment lives here.
 *
 * This is the only file in src/ allowed to read process.env — enforced by
 * .claude/hooks/config-boundary-guard.sh. Anywhere else, take a StarfishConfig.
 *
 * This is the whole point of the project: the engine itself knows nothing about
 * any particular product. Point it at a different GCP project, give it different
 * service patterns, and it works there.
 */

export interface StarfishConfig {
  /** GCP project whose logs are read and whose incidents are stored. */
  projectId: string;
  /** Vertex AI region. */
  location: string;
  /** Gemini model used for triage, fix drafting and adversarial review. */
  model: string;
  /** Label attached to every incident, so environments can never mix. */
  environment: string;
  /** Firestore collection holding incidents. */
  incidentCollection: string;
  /**
   * Firestore database id. Defaults to a dedicated named database, "starfish",
   * so Starfish's rules and indexes never touch the watched app's own database.
   * "(default)" opts back into the default database.
   */
  databaseId: string;
  /**
   * Substring → service-name map for attributing a function to a part of the
   * system. A name matching nothing resolves to null, which is stored as
   * "platform" — never silently attributed to whichever service happens to be
   * first in the list.
   */
  servicePatterns: Record<string, string>;
  /** How far back the first aggregation run looks when no checkpoint exists. */
  defaultLookbackHours: number;
  /** Cloud Logging `resource.type` values whose ERROR entries count as incidents. */
  logResourceTypes: string[];
  /**
   * Message fragments that appear at ERROR severity but are framework noise, not
   * application faults. Excluded at query time and again at parse time.
   */
  ignoredMessages: string[];
}

/** Firebase gen1 functions log as cloud_function; gen2 and plain Cloud Run as cloud_run_revision. */
export const DEFAULT_LOG_RESOURCE_TYPES = ["cloud_function", "cloud_run_revision"];

export const DEFAULT_IGNORED_MESSAGES = [
  // Callable frameworks accept POST only. On every revision rollout something
  // (a console, a health probe) issues a GET, producing this at ERROR severity.
  "Invalid request, unable to process",
  "Request has invalid method",
];

/**
 * Load `.env` when present. `pnpm spike` runs under plain tsx, which does not
 * read it — without this, following the README's `cp .env.example .env` step
 * would still fail on an unset GOOGLE_CLOUD_PROJECT.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the ambient environment.
  }
}

export function loadConfig(): StarfishConfig {
  loadDotEnv();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error("GOOGLE_CLOUD_PROJECT is not set — copy .env.example to .env");
  }
  return {
    projectId,
    location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    model: process.env.STARFISH_MODEL ?? "gemini-3.1-pro-preview",
    environment: process.env.STARFISH_ENV ?? "dev",
    incidentCollection: process.env.STARFISH_INCIDENT_COLLECTION ?? "incidents",
    databaseId: process.env.STARFISH_DATABASE_ID || "starfish",
    servicePatterns: parseServicePatterns(process.env.STARFISH_SERVICE_PATTERNS),
    defaultLookbackHours: Number(process.env.STARFISH_LOOKBACK_HOURS ?? 24),
    logResourceTypes: requireNonEmpty(
      parseList(process.env.STARFISH_LOG_RESOURCE_TYPES, ",") ?? DEFAULT_LOG_RESOURCE_TYPES,
      "STARFISH_LOG_RESOURCE_TYPES"
    ),
    ignoredMessages:
      parseList(process.env.STARFISH_IGNORED_MESSAGES, "|") ?? DEFAULT_IGNORED_MESSAGES,
  };
}

/** `"api:api,worker:jobs"` → `{ api: "api", worker: "jobs" }`. Empty is valid. */
function parseServicePatterns(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [pattern, service] = pair.split(":").map((s) => s.trim());
    if (pattern && service) out[pattern.toLowerCase()] = service;
  }
  return out;
}

/**
 * An empty resource-type list would build the filter `()`, which Cloud Logging
 * rejects — every ingest run would fail. Fail at startup, where it's legible.
 */
function requireNonEmpty(list: string[], name: string): string[] {
  if (list.length === 0) {
    throw new Error(`${name} is set but empty — unset it for the defaults, or list at least one type`);
  }
  return list;
}

/** Unset means "use the defaults"; set-but-empty means "none". */
function parseList(raw: string | undefined, separator: string): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}
