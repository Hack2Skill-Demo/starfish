/**
 * The runtime settings schema: what an admin may override, and the check that a
 * settings document is acceptable. Pure, with no Firestore or Node dependency, so
 * the engine (which validates on read) and the operator UI (which validates
 * before it saves) run the same code and can't disagree about what is valid.
 */
import { validateClassRules, type ClassRule } from "./triageRules.js";

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
   * Auto-merge for this deployment's target (#9): a pull request for an incident Gemini named one of `mergeCases` for,
   * inside the safety floor and with every required check green, is merged. The engine's default is off, and it only
   * ever applies to a target the deployment lists in STARFISH_AUTO_MERGE_TARGETS (the demo).
   */
  autoMerge?: boolean;
  /** The global off switch for merging: true stops every automatic merge and revert, whatever `autoMerge` says. */
  mergeFreeze?: boolean;
  /**
   * The kinds of incident Starfish may merge a fix for by itself (docs/design/auto-merge-policy.md). Gemini decides
   * whether an incident is one of them; nothing merges for an incident it does not name one of these for. An empty list
   * (the engine's default) means nothing merges.
   */
  mergeCases?: MergeCase[];
  /**
   * The rules engine (src/triageRules.ts): incidents matching a rule go no further than its level (noise, log or fix),
   * whatever triage chose. Rules only hold Starfish back; an empty list (the engine's default) holds nothing back.
   */
  classRules?: ClassRule[];
  /** The most model calls one cycle may make. */
  modelCallBudget?: number;
  /** The Gemini model id the agent asks (triage, fix, review), e.g. gemini-3.1-pro-preview. */
  model?: string;
  /** The Vertex AI location those calls go to: a GCP region such as us-central1, or `global`. */
  location?: string;
  /**
   * The GCP project those calls run in and are billed to. The engine's accounts need `roles/aiplatform.user` there
   * and the Vertex AI API enabled; the deploy grants that only on its own VERTEX_PROJECT_ID.
   */
  vertexProjectId?: string;
}

/**
 * One kind of incident an admin lets Starfish merge a fix for with no person in the loop: Gemini reads the description
 * and must name the id to choose "merge" for an incident. Descriptions are written for the model, in plain words
 * ("a Firestore write fails because a field is undefined").
 */
export interface MergeCase {
  id: string;
  description: string;
}

/**
 * The reserved case of the missing-index path (#11), which asks no model: Google's error names the exact index. Listed,
 * it lets that path's evidence pull request merge once the required checks are green; not listed, a person merges it.
 */
export const INDEX_MERGE_CASE = "missing-index";
export const MAX_MERGE_CASES = 20;
export const MAX_MERGE_CASE_DESCRIPTION = 300;
/** A case id: lowercase letters, digits and '-', 2-40 characters, starting with a letter. firestore.rules caps the list's size. */
export const MERGE_CASE_ID = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * Check a list of merge cases (from the settings document or the environment). The problem names the rule, never a
 * value. Ids are unique; descriptions are 1-300 characters with no control characters, since they reach the model.
 */
export function validateMergeCases(raw: unknown): { ok: true; cases: MergeCase[] } | { ok: false; problem: string } {
  const rule = `mergeCases: a list of at most ${MAX_MERGE_CASES} cases, each { id, description }: a unique id of 2-40 lowercase letters, digits or '-' starting with a letter, and a description of 1-${MAX_MERGE_CASE_DESCRIPTION} characters with no control characters`;
  if (!Array.isArray(raw) || raw.length > MAX_MERGE_CASES) return { ok: false, problem: rule };
  const cases: MergeCase[] = [];
  const seen = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (!isPlainObject(entry) || Object.keys(entry).some((k) => k !== "id" && k !== "description")) return { ok: false, problem: rule };
    const { id, description } = entry;
    if (typeof id !== "string" || !MERGE_CASE_ID.test(id) || seen.has(id)) return { ok: false, problem: rule };
    if (typeof description !== "string") return { ok: false, problem: rule };
    const text = description.trim();
    if (text === "" || text.length > MAX_MERGE_CASE_DESCRIPTION || CONTROL.test(text)) return { ok: false, problem: rule };
    seen.add(id);
    cases.push({ id, description: text });
  }
  return { ok: true, cases };
}

/** The document's schema version. A document of another version is invalid to this engine. */
export const SETTINGS_VERSION = 1;
/** The admin-edited document, and the engine's copy of the last one that validated. */
export const SETTINGS_DOC = "current";
export const LAST_GOOD_DOC = "last_good";
/**
 * The `error` an ingest run records in `last_run` when it refused to run because the settings could not be used and
 * no last-good copy exists (src/ingest/run.ts). Here so both judges of that record (src/status.ts and the UI's
 * web/src/lib/engineStatus.ts) read the same label: such a record carries the env-default environment, not the one
 * an admin chose, and is a failure whatever environment it names (#223).
 */
export const SETTINGS_UNUSABLE = "settings-unusable";

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
  "mergeCases",
  "classRules",
  "modelCallBudget",
  "model",
  "location",
  "vertexProjectId",
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
// A GCP project id. firestore.rules repeats this pattern for watchedProjectId and vertexProjectId.
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

  if (raw.mergeCases !== undefined) {
    const checked = validateMergeCases(raw.mergeCases);
    if (checked.ok) settings.mergeCases = checked.cases;
    else problems.push(checked.problem);
  }

  if (raw.classRules !== undefined) {
    const checked = validateClassRules(raw.classRules);
    if (checked.ok) settings.classRules = checked.rules;
    else problems.push(checked.problem);
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

  if (raw.vertexProjectId !== undefined) {
    if (typeof raw.vertexProjectId === "string" && PROJECT_ID.test(raw.vertexProjectId)) {
      settings.vertexProjectId = raw.vertexProjectId;
    } else problems.push("vertexProjectId: not a GCP project id");
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

