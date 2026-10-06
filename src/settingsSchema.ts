/**
 * The runtime settings schema: what an admin may override, and the check that a
 * settings document is acceptable. Pure, with no Firestore or Node dependency, so
 * the engine (which validates on read) and the operator UI (which validates
 * before it saves) run the same code and can't disagree about what is valid.
 */

/** The settings an admin may override. Arrays and maps replace the default, never merge with it. */
export interface RuntimeSettings {
  watchedProjectId?: string;
  environment?: string;
  logResourceTypes?: string[];
  servicePatterns?: Record<string, string>;
  ignoredMessages?: string[];
  /** Draft, verify and review fixes but open nothing. The engine's default is on. */
  dryRun?: boolean;
  /** Whether a patch must survive the adversarial review before it can become a pull request. */
  reviewRequired?: boolean;
  /** The kill switch: false stops the agent loop at its next step. */
  automationEnabled?: boolean;
  /**
   * Auto-merge for this deployment's target (#9): a pull request whose gates all pass is merged. The engine's default
   * is off, and it only ever applies to a target the deployment lists in STARFISH_AUTO_MERGE_TARGETS (the demo).
   */
  autoMerge?: boolean;
  /** The global off switch for merging: true stops every automatic merge and revert, whatever `autoMerge` says. */
  mergeFreeze?: boolean;
  /** The most model calls one cycle may make. */
  modelCallBudget?: number;
  /** The Gemini model id the agent asks (triage, fix, review), e.g. gemini-3.1-pro-preview. */
  model?: string;
  /** The Vertex AI location those calls go to: a GCP region such as us-central1, or `global`. */
  location?: string;
}

/** The document's schema version. A document of another version is invalid to this engine. */
export const SETTINGS_VERSION = 1;
/** The admin-edited document, and the engine's copy of the last one that validated. */
export const SETTINGS_DOC = "current";
export const LAST_GOOD_DOC = "last_good";

const SETTINGS_KEYS = [
  "version",
  "watchedProjectId",
  "environment",
  "logResourceTypes",
  "servicePatterns",
  "ignoredMessages",
  "dryRun",
  "reviewRequired",
  "automationEnabled",
  "autoMerge",
  "mergeFreeze",
  "modelCallBudget",
  "model",
  "location",
  // Written with the document by whoever edited it (the rules require them);
  // carried, not used by the engine.
  "revision",
  "auditId",
  "updatedAt",
  "updatedBy",
] as const;

const MAX_LIST = 100;
/** A cycle needs at least triage, a fix and a review; fifty is far past any sensible spend cap. */
export const MODEL_CALL_BUDGET_MIN = 1;
export const MODEL_CALL_BUDGET_MAX = 50;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Cloud Logging `resource.type` values: cloud_function, cloud_run_revision, ...
const RESOURCE_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
// A Vertex model id as the API takes it: lowercase letters, digits, '.', '_' and '-' (gemini-3.1-pro-preview,
// gemini-2.5-flash-001). No '/', so a value can't name a resource path. firestore.rules repeats this pattern.
export const MODEL_ID = /^[a-z][a-z0-9._-]{0,63}$/;
// A GCP region (us-central1, europe-west4, northamerica-northeast1) or Vertex's `global` endpoint. It becomes part
// of the API host name, so nothing else is accepted. firestore.rules repeats this pattern.
export const VERTEX_LOCATION = /^(global|[a-z]{2,20}-[a-z]{2,20}[0-9]{1,2})$/;
// Control characters are rejected in every free-text value: the log filter is
// built line by line, and its quoting does not escape a newline.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

export type Validation = { ok: true; settings: RuntimeSettings } | { ok: false; problems: string[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check a settings document read from Firestore. Problems name the field and the
 * rule, never the value: a bad value may be a pasted credential, and these
 * messages end up in logs and on the Settings page.
 */
export function validateSettings(raw: unknown): Validation {
  if (!isPlainObject(raw)) return { ok: false, problems: ["settings: not an object"] };
  const problems: string[] = [];
  const settings: RuntimeSettings = {};

  for (const key of Object.keys(raw)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) problems.push(`${key.slice(0, 40)}: unknown setting`);
  }
  if (raw.version !== SETTINGS_VERSION) problems.push(`version: must be ${SETTINGS_VERSION}`);

  if (raw.watchedProjectId !== undefined) {
    if (typeof raw.watchedProjectId === "string" && PROJECT_ID.test(raw.watchedProjectId)) {
      settings.watchedProjectId = raw.watchedProjectId;
    } else problems.push("watchedProjectId: not a GCP project id");
  }

  if (raw.environment !== undefined) {
    if (typeof raw.environment === "string" && ENVIRONMENT.test(raw.environment)) {
      settings.environment = raw.environment;
    } else problems.push("environment: 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit");
  }

  if (raw.logResourceTypes !== undefined) {
    const list = raw.logResourceTypes;
    if (!Array.isArray(list) || list.length < 1 || list.length > 20) {
      problems.push("logResourceTypes: a list of 1-20 resource types");
    } else if (!list.every((t) => typeof t === "string" && RESOURCE_TYPE.test(t))) {
      problems.push("logResourceTypes: each entry must be a lowercase resource type such as cloud_function");
    } else settings.logResourceTypes = [...(list as string[])];
  }

  if (raw.servicePatterns !== undefined) {
    const map = raw.servicePatterns;
    if (!isPlainObject(map) || Object.keys(map).length > MAX_LIST) {
      problems.push(`servicePatterns: an object of at most ${MAX_LIST} pattern → service entries`);
    } else {
      const patterns: Record<string, string> = {};
      let valid = true;
      for (const [pattern, service] of Object.entries(map)) {
        const key = pattern.trim().toLowerCase();
        // `__proto__` can't be an own key of a plain object: assigning it would be silently dropped.
        if (key === "" || key === "__proto__" || key.length > 100 || CONTROL.test(key)) valid = false;
        else if (typeof service !== "string") valid = false;
        else if (service.trim() === "" || service.length > 100 || CONTROL.test(service)) valid = false;
        else patterns[key] = service.trim();
      }
      if (valid) settings.servicePatterns = patterns;
      else problems.push("servicePatterns: patterns and services must be 1-100 characters, no control characters");
    }
  }

  if (raw.ignoredMessages !== undefined) {
    const list = raw.ignoredMessages;
    if (!Array.isArray(list) || list.length > MAX_LIST) {
      problems.push(`ignoredMessages: a list of at most ${MAX_LIST} message fragments`);
    } else if (!list.every((m) => typeof m === "string" && m.length >= 1 && m.length <= 300 && !CONTROL.test(m))) {
      problems.push("ignoredMessages: each entry must be 1-300 characters, no control characters");
    } else settings.ignoredMessages = [...(list as string[])];
  }

  for (const flag of ["dryRun", "reviewRequired", "automationEnabled", "autoMerge", "mergeFreeze"] as const) {
    if (raw[flag] !== undefined) {
      if (typeof raw[flag] === "boolean") settings[flag] = raw[flag] as boolean;
      else problems.push(`${flag}: true or false`);
    }
  }

  if (raw.modelCallBudget !== undefined) {
    const n = raw.modelCallBudget;
    if (typeof n === "number" && Number.isInteger(n) && n >= MODEL_CALL_BUDGET_MIN && n <= MODEL_CALL_BUDGET_MAX) {
      settings.modelCallBudget = n;
    } else problems.push(`modelCallBudget: a whole number from ${MODEL_CALL_BUDGET_MIN} to ${MODEL_CALL_BUDGET_MAX}`);
  }

  if (raw.model !== undefined) {
    if (typeof raw.model === "string" && MODEL_ID.test(raw.model)) settings.model = raw.model;
    else problems.push("model: 1-64 lowercase letters, digits, '.', '_' or '-', starting with a letter");
  }

  if (raw.location !== undefined) {
    if (typeof raw.location === "string" && VERTEX_LOCATION.test(raw.location)) settings.location = raw.location;
    else problems.push("location: a GCP region such as us-central1, or global");
  }

  if (raw.revision !== undefined && !(Number.isInteger(raw.revision) && (raw.revision as number) >= 0)) {
    problems.push("revision: a non-negative integer");
  }
  if (raw.auditId !== undefined && (typeof raw.auditId !== "string" || raw.auditId.length > 64)) {
    problems.push("auditId: a string of at most 64 characters");
  }
  if (raw.updatedBy !== undefined && (typeof raw.updatedBy !== "string" || raw.updatedBy.length > 128)) {
    problems.push("updatedBy: a string of at most 128 characters");
  }
  if (raw.updatedAt !== undefined && typeof (raw.updatedAt as { toMillis?: unknown } | null)?.toMillis !== "function") {
    problems.push("updatedAt: not a timestamp");
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, settings };
}

