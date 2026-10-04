/**
 * Runtime settings: the operational half of the configuration, edited by an
 * admin from the UI and read by the engine on every run.
 *
 * Three tiers (issue #7). Environment variables (src/config.ts) are the
 * bootstrap and the defaults: they say where the store is and what to use when
 * nothing else is set. A settings document in Starfish's own database overrides
 * the operational values below. Secrets belong to neither; they are not built.
 *
 * What a run does with the document:
 *   - missing            → the environment defaults (an admin deleting it resets);
 *   - valid              → the defaults with its values applied;
 *   - invalid or unread  → the last good document, else the defaults.
 * It never throws, and every run gets a frozen snapshot, so a settings edit
 * mid-run can't change what that run does.
 *
 * Only settings the engine consumes today are accepted. A setting with no
 * consumer would be a control on the Settings page that does nothing.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "./config.js";

/** The settings an admin may override. Arrays and maps replace the default, never merge with it. */
export interface RuntimeSettings {
  watchedProjectId?: string;
  environment?: string;
  logResourceTypes?: string[];
  servicePatterns?: Record<string, string>;
  ignoredMessages?: string[];
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
  // Written with the document by whoever edited it; carried, not used by the engine.
  "updatedAt",
  "updatedBy",
] as const;

const MAX_LIST = 100;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Cloud Logging `resource.type` values: cloud_function, cloud_run_revision, ...
const RESOURCE_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
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

  if (raw.updatedBy !== undefined && (typeof raw.updatedBy !== "string" || raw.updatedBy.length > 128)) {
    problems.push("updatedBy: a string of at most 128 characters");
  }
  if (raw.updatedAt !== undefined && typeof (raw.updatedAt as { toMillis?: unknown } | null)?.toMillis !== "function") {
    problems.push("updatedAt: not a timestamp");
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, settings };
}

/**
 * A frozen copy of the config. Its arrays and maps are copied, so freezing them
 * can't touch the shared defaults in config.ts or another run's snapshot.
 */
function snapshot(config: StarfishConfig): StarfishConfig {
  return Object.freeze({
    ...config,
    logResourceTypes: Object.freeze([...config.logResourceTypes]) as string[],
    ignoredMessages: Object.freeze([...config.ignoredMessages]) as string[],
    servicePatterns: Object.freeze({ ...config.servicePatterns }),
  });
}

/** The defaults with the settings applied, as a frozen snapshot. */
export function applySettings(base: StarfishConfig, settings: RuntimeSettings): StarfishConfig {
  return snapshot({
    ...base,
    ...(settings.watchedProjectId !== undefined && { watchedProjectId: settings.watchedProjectId }),
    ...(settings.environment !== undefined && { environment: settings.environment }),
    ...(settings.logResourceTypes !== undefined && { logResourceTypes: settings.logResourceTypes }),
    ...(settings.servicePatterns !== undefined && { servicePatterns: settings.servicePatterns }),
    ...(settings.ignoredMessages !== undefined && { ignoredMessages: settings.ignoredMessages }),
  });
}

/** Where a run's configuration came from. */
export type ConfigSource = "env" | "settings" | "last-good";

export interface ResolvedConfig {
  /** The frozen snapshot this run uses throughout. */
  config: StarfishConfig;
  source: ConfigSource;
  /** Why the settings document wasn't used, when it wasn't. Field names and rules only, never values. */
  problems: string[];
  /**
   * False when the settings document is unusable and no earlier one is known good,
   * so the run is on the defaults without knowing they are what the admin intends.
   * Reading logs and recording incidents in Starfish's own store are safe then;
   * anything that acts outside it (a pull request, an index, a deploy) must wait
   * for a valid document. Nothing acts yet: the agent loop (#8) must check this.
   */
  actionsAllowed: boolean;
}

/**
 * Resolves each run's configuration. Hold one per process: it remembers the last
 * valid document in memory, and keeps a copy in Firestore (LAST_GOOD_DOC) so a
 * fresh instance of a scheduled job still has one to fall back to.
 */
export class RuntimeConfigLoader {
  private lastGood: RuntimeSettings | undefined;
  /** The last settings (serialized) known to be saved as LAST_GOOD_DOC, so a failed save is retried. */
  private saved: string | undefined;

  constructor(private readonly base: StarfishConfig) {}

  /** Never throws. */
  async resolve(db: Firestore): Promise<ResolvedConfig> {
    const collection = db.collection(this.base.settingsCollection);

    let data: unknown;
    try {
      const snap = await collection.doc(SETTINGS_DOC).get();
      if (!snap.exists) {
        // Deleting the document is how an admin resets to the defaults, and a
        // reset supersedes what was good before it: a later bad edit must not
        // resurrect the settings the admin just removed.
        this.lastGood = undefined;
        this.saved = undefined;
        await this.discardPersistedLastGood(collection);
        return { config: snapshot(this.base), source: "env", problems: [], actionsAllowed: true };
      }
      data = snap.data();
    } catch (err) {
      return this.fallback(collection, [`settings read failed: ${errorLabel(err)}`]);
    }

    const checked = validateSettings(data);
    if (!checked.ok) return this.fallback(collection, checked.problems);

    this.lastGood = checked.settings;
    const serialized = JSON.stringify(checked.settings);
    if (serialized !== this.saved && (await this.persistLastGood(collection, checked.settings))) {
      this.saved = serialized;
    }
    return { config: applySettings(this.base, checked.settings), source: "settings", problems: [], actionsAllowed: true };
  }

  private async fallback(
    collection: ReturnType<Firestore["collection"]>,
    problems: string[]
  ): Promise<ResolvedConfig> {
    this.lastGood ??= await this.readPersistedLastGood(collection);
    if (this.lastGood) {
      return { config: applySettings(this.base, this.lastGood), source: "last-good", problems, actionsAllowed: true };
    }
    return { config: snapshot(this.base), source: "env", problems, actionsAllowed: false };
  }

  /** The copy a previous instance saved, if it still validates. Never throws. */
  private async readPersistedLastGood(
    collection: ReturnType<Firestore["collection"]>
  ): Promise<RuntimeSettings | undefined> {
    try {
      const snap = await collection.doc(LAST_GOOD_DOC).get();
      if (!snap.exists) return undefined;
      const checked = validateSettings(snap.data());
      return checked.ok ? checked.settings : undefined;
    } catch {
      return undefined;
    }
  }

  /** Best effort. One read per run while no settings exist; a write only when there is a copy to remove. */
  private async discardPersistedLastGood(collection: ReturnType<Firestore["collection"]>): Promise<void> {
    try {
      const ref = collection.doc(LAST_GOOD_DOC);
      if ((await ref.get()).exists) await ref.delete();
    } catch {
      // A copy that survives is only used if a later document is invalid.
    }
  }

  /**
   * Best effort, and retried on the next run while it keeps failing: a failed save
   * only means a fresh instance has nothing to fall back to yet. True when saved.
   */
  private async persistLastGood(
    collection: ReturnType<Firestore["collection"]>,
    settings: RuntimeSettings
  ): Promise<boolean> {
    try {
      await collection.doc(LAST_GOOD_DOC).set({ version: SETTINGS_VERSION, ...settings });
      return true;
    } catch {
      return false;
    }
  }
}

/** An error's code or name: enough to diagnose, and never its message, which can echo data. */
function errorLabel(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" || typeof code === "number") return String(code);
  return err instanceof Error ? err.name : "unknown error";
}
