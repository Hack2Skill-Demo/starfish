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
import { parseAllowedTargets } from "./indexheal/createIndexUrl.js";

export interface StarfishConfig {
  /** GCP project Starfish runs in: its Firestore store and its Vertex AI calls. */
  projectId: string;
  /**
   * GCP project whose Cloud Logging is read for errors. Defaults to `projectId`
   * (Starfish running inside the project it watches); set it to watch another
   * project. Single-target: one watched project per Starfish deployment, and
   * `environment` must change with it, or two projects' incidents share a label.
   */
  watchedProjectId: string;
  /**
   * GCP project Gemini runs in, and is billed to. Defaults to `projectId`; set it to run Gemini
   * in a different project from the one Starfish's store lives in. It is the project that needs
   * the Vertex AI API enabled and the caller's `roles/aiplatform.user`.
   */
  vertexProjectId: string;
  /** Vertex AI region. */
  location: string;
  /** Gemini model used for triage, fix drafting and adversarial review. */
  model: string;
  /** Label attached to every incident, so environments can never mix. */
  environment: string;
  /**
   * Firestore collection holding the runtime settings document an admin edits
   * from the UI (src/runtimeSettings.ts). Environment variables are the defaults;
   * a valid settings document overrides the operational ones.
   */
  settingsCollection: string;
  /**
   * The command that proves a patch is acceptable, run in a scratch copy of the target repo with
   * the patch applied (src/agent/verifyGate.ts). Exit 0 is the only thing that passes. Empty means
   * no gate is configured, and then no patch is ever accepted: nothing would have proved it.
   */
  verifyCommand: string;
  /** How long the verify command may run before it is killed and the patch is rejected. */
  verifyTimeoutSeconds: number;
  /**
   * Paths a proposed patch may never touch (`.github/`, `.env*`, the files that define the verify
   * command or the tests that judge it). A trailing `/` is a directory; `*` and `**` are globs; a
   * pattern with no `/` matches that name at any depth. Matching ignores case.
   */
  patchExcludedPaths: string[];
  /**
   * Firestore collection of agent cycles: one document per (incident, recurrence), holding the
   * lease that stops two workers acting on the same cycle, with the cycle's run events in a
   * subcollection (src/agent/cycle.ts).
   */
  cycleCollection: string;
  /** How long a worker's lease on a cycle lasts before another may take it over. */
  leaseSeconds: number;
  /** The most a cycle may take overall, however many times its lease is renewed or taken over. */
  cycleDeadlineMinutes: number;
  /** How many times a cycle may be started (the first try included) before it is given up on. */
  maxCycleAttempts: number;
  /**
   * Dry run: the agent loop drafts and verifies everything but opens nothing. On by default, so
   * nothing leaves Starfish until a deployment turns it off on purpose.
   */
  dryRun: boolean;
  /** Whether a patch must survive the adversarial review before it can become a pull request. */
  reviewRequired: boolean;
  /**
   * The kill switch: when false the agent loop stops at the next step (it is asked before every stage and
   * again before anything is opened). On by default because a dry run is the default guard; an admin turns it
   * off from Settings, and it is read fresh, not once per run (src/agent/automationSwitch.ts).
   */
  automationEnabled: boolean;
  /** The most model calls one cycle may make (triage, each fix attempt, each review): a spend cap. */
  modelCallBudget: number;
  /**
   * The one repository Starfish opens pull requests in, as `owner/name` (src/integrations/githubPr.ts).
   * Empty means none: nothing can be opened. It is also checked against what the API says the token
   * reaches, so a token for another repository cannot be used by mistake.
   */
  githubRepo: string;
  /** The branch pull requests target. Starfish never pushes to it. */
  githubBaseBranch: string;
  /** The GitHub REST API root. Only `https://`, or plain `http://` to localhost for tests. */
  githubApiUrl: string;
  /** Where the repository is fetched from and pushed to. Empty means `https://github.com/<githubRepo>.git`. */
  githubRemoteUrl: string;
  /**
   * `project/database` pairs a missing Firestore index may be created in (src/indexheal/createIndexUrl.ts),
   * e.g. `my-demo/(default)`. Empty by default: nothing is allowed. Starfish's own database is refused
   * even if listed.
   */
  indexAllowedTargets: string[];
  /** The author and committer on the commit Starfish pushes. */
  githubCommitName: string;
  githubCommitEmail: string;
  /**
   * Firestore collection of operator records ({uid} -> { roles }). The engine reads it to check that
   * whoever asks for an admin action is an admin, the same record firestore.rules reads. Must match
   * the web's VITE_STARFISH_USERS_COLLECTION and the rules, which hardcode `starfish_users`.
   */
  usersCollection: string;
  /** Firestore collection of audit entries for admin actions on the engine (src/ingest/retire.ts). */
  auditCollection: string;
  /**
   * Functions and services whose errors are never ingested, matched on the canonical spelling
   * (lowercased, `_` as `-`) against both the function and the service label. Starfish's own deployed
   * service goes here: when it shares a project with the app it watches (#32), reading its own errors
   * would turn its failures into incidents, and the fixer could then propose patches to Starfish itself.
   * Default `starfish`; set it to whatever the Cloud Run service or job is actually called.
   * Deliberately environment-only, not an admin-editable setting: it is a safety guard against a
   * feedback loop, not an operational preference.
   */
  excludedServices: string[];
  /** Firestore collection holding incidents. */
  incidentCollection: string;
  /**
   * Firestore collection of incident keys: one document per (environment,
   * fingerprint) naming the incident that fingerprint accrues onto. Every write
   * goes through it inside a transaction, which is what makes concurrent ingest
   * runs and operator triage converge on one incident (src/ingest/store.ts).
   * Engine-only: firestore.rules keeps clients out of it.
   */
  incidentKeyCollection: string;
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
  /**
   * How far behind real time an ingest window ends. Cloud Logging makes an entry searchable
   * some time after it happened; a window that ended at "now" would be closed before its last
   * entries arrived, and they would never be counted.
   */
  ingestLagMinutes: number;
  /** The longest span one ingest window may cover, so catching up after downtime is done in bounded reads. */
  ingestMaxWindowHours: number;
  /**
   * Firestore collection for the ingest run state: `state` (the checkpoint and the window in
   * flight; engine-only) and `last_run` (the outcome of the latest run, which the UI shows).
   */
  runCollection: string;
  /** Cloud Logging `resource.type` values whose ERROR entries count as incidents. */
  logResourceTypes: string[];
  /**
   * Message fragments that appear at ERROR severity but are framework noise, not
   * application faults. Excluded at query time and again at parse time.
   */
  ignoredMessages: string[];
}

/** Starfish's own service name: never ingested (see `excludedServices`). */
export const DEFAULT_EXCLUDED_SERVICES = ["starfish"];

/** Never editable by a proposed patch, on top of whatever the deployment lists. Secrets and CI, mainly. */
export const DEFAULT_PATCH_EXCLUDED_PATHS = [
  ".git/",
  ".github/",
  ".claude/",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  ".npmrc",
  ".netrc",
  "firebase-adminsdk*.json",
  "service-account*.json",
];

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
    watchedProjectId: process.env.STARFISH_WATCHED_PROJECT_ID || projectId,
    vertexProjectId: process.env.STARFISH_VERTEX_PROJECT_ID || projectId,
    location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    model: process.env.STARFISH_MODEL ?? "gemini-3.1-pro-preview",
    environment: process.env.STARFISH_ENV ?? "dev",
    settingsCollection: process.env.STARFISH_SETTINGS_COLLECTION ?? "starfish_settings",
    incidentCollection: process.env.STARFISH_INCIDENT_COLLECTION ?? "incidents",
    incidentKeyCollection: process.env.STARFISH_INCIDENT_KEY_COLLECTION ?? "incident_keys",
    databaseId: process.env.STARFISH_DATABASE_ID || "starfish",
    servicePatterns: parseServicePatterns(process.env.STARFISH_SERVICE_PATTERNS),
    verifyCommand: (process.env.STARFISH_VERIFY_COMMAND ?? "").trim(),
    verifyTimeoutSeconds: positiveNumber(
      process.env.STARFISH_VERIFY_TIMEOUT_SECONDS,
      600,
      "STARFISH_VERIFY_TIMEOUT_SECONDS"
    ),
    patchExcludedPaths: [
      ...DEFAULT_PATCH_EXCLUDED_PATHS,
      ...(parseList(process.env.STARFISH_PATCH_EXCLUDED_PATHS, ",") ?? []),
    ],
    defaultLookbackHours: Number(process.env.STARFISH_LOOKBACK_HOURS ?? 24),
    ingestLagMinutes: positiveNumber(process.env.STARFISH_INGEST_LAG_MINUTES, 5, "STARFISH_INGEST_LAG_MINUTES"),
    ingestMaxWindowHours: positiveNumber(
      process.env.STARFISH_INGEST_MAX_WINDOW_HOURS,
      6,
      "STARFISH_INGEST_MAX_WINDOW_HOURS"
    ),
    runCollection: process.env.STARFISH_RUN_COLLECTION || "starfish_runs",
    dryRun: parseBoolean(process.env.STARFISH_DRY_RUN, true, "STARFISH_DRY_RUN"),
    reviewRequired: parseBoolean(process.env.STARFISH_REVIEW_REQUIRED, true, "STARFISH_REVIEW_REQUIRED"),
    automationEnabled: parseBoolean(process.env.STARFISH_AUTOMATION_ENABLED, true, "STARFISH_AUTOMATION_ENABLED"),
    modelCallBudget: positiveNumber(process.env.STARFISH_MODEL_CALL_BUDGET, 6, "STARFISH_MODEL_CALL_BUDGET"),
    githubRepo: (process.env.STARFISH_GITHUB_REPO ?? "").trim(),
    githubBaseBranch: (process.env.STARFISH_GITHUB_BASE_BRANCH ?? "").trim() || "main",
    githubApiUrl: (process.env.STARFISH_GITHUB_API_URL ?? "").trim() || "https://api.github.com",
    githubRemoteUrl: (process.env.STARFISH_GITHUB_REMOTE_URL ?? "").trim(),
    indexAllowedTargets: validIndexTargets(parseList(process.env.STARFISH_INDEX_ALLOWED_TARGETS, ",") ?? []),
    githubCommitName: (process.env.STARFISH_GITHUB_COMMIT_NAME ?? "").trim() || "Starfish",
    githubCommitEmail: (process.env.STARFISH_GITHUB_COMMIT_EMAIL ?? "").trim() || "starfish@users.noreply.github.com",
    usersCollection: process.env.STARFISH_USERS_COLLECTION || "starfish_users",
    auditCollection: process.env.STARFISH_AUDIT_COLLECTION || "starfish_audit",
    excludedServices: parseList(process.env.STARFISH_EXCLUDED_SERVICES, ",") ?? DEFAULT_EXCLUDED_SERVICES,
    cycleCollection: process.env.STARFISH_CYCLE_COLLECTION || "starfish_cycles",
    leaseSeconds: positiveNumber(process.env.STARFISH_LEASE_SECONDS, 300, "STARFISH_LEASE_SECONDS"),
    cycleDeadlineMinutes: positiveNumber(process.env.STARFISH_CYCLE_DEADLINE_MINUTES, 60, "STARFISH_CYCLE_DEADLINE_MINUTES"),
    maxCycleAttempts: positiveNumber(process.env.STARFISH_MAX_CYCLE_ATTEMPTS, 3, "STARFISH_MAX_CYCLE_ATTEMPTS"),
    logResourceTypes: requireNonEmpty(
      parseList(process.env.STARFISH_LOG_RESOURCE_TYPES, ",") ?? DEFAULT_LOG_RESOURCE_TYPES,
      "STARFISH_LOG_RESOURCE_TYPES"
    ),
    ignoredMessages:
      parseList(process.env.STARFISH_IGNORED_MESSAGES, "|") ?? DEFAULT_IGNORED_MESSAGES,
  };
}

/**
 * The GitHub token for the pull-request step, or undefined. Deliberately not a field of
 * StarfishConfig: a config object is copied into snapshots and test fixtures, and a secret
 * must not travel with it. Mounted from Secret Manager on Cloud Run (docs/deploy.md).
 */
export function loadGithubToken(): string | undefined {
  const token = (process.env.STARFISH_GITHUB_TOKEN ?? "").trim();
  return token === "" ? undefined : token;
}

/**
 * The two variables a child `git` needs to find itself and a home directory, and nothing else: a child
 * process must not inherit the engine's environment (the GitHub token is in it).
 */
export function loadChildProcessBasics(): { PATH?: string; HOME?: string } {
  return { PATH: process.env.PATH, HOME: process.env.HOME };
}

/** The entries unchanged if each is `project/database`; a typo throws at startup rather than widening what is allowed. */
function validIndexTargets(entries: string[]): string[] {
  parseAllowedTargets(entries);
  return entries;
}

/** A number above zero, or the default when unset. A window of zero or negative length would never advance. */
function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a number above zero, got "${raw}"`);
  return n;
}

/** true/false/1/0/yes/no, or the default when unset. Anything else is a mistake worth refusing at startup. */
function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes"].includes(v)) return true;
  if (["false", "0", "no"].includes(v)) return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
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
