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
import {
  LAST_GOOD_DOC,
  SETTINGS_DOC,
  SETTINGS_VERSION,
  validateSettings,
  type RuntimeSettings,
} from "./settingsSchema.js";

export {
  LAST_GOOD_DOC,
  SETTINGS_DOC,
  SETTINGS_VERSION,
  validateSettings,
  type RuntimeSettings,
  type Validation,
} from "./settingsSchema.js";

/**
 * A frozen copy of the config. Its arrays and maps are copied, so freezing them
 * can't touch the shared defaults in config.ts or another run's snapshot.
 */
function snapshot(config: StarfishConfig): StarfishConfig {
  return Object.freeze({
    ...config,
    logResourceTypes: Object.freeze([...config.logResourceTypes]) as string[],
    ignoredMessages: Object.freeze([...config.ignoredMessages]) as string[],
    excludedServices: Object.freeze([...config.excludedServices]) as string[],
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
    ...(settings.dryRun !== undefined && { dryRun: settings.dryRun }),
    ...(settings.reviewRequired !== undefined && { reviewRequired: settings.reviewRequired }),
    ...(settings.automationEnabled !== undefined && { automationEnabled: settings.automationEnabled }),
    ...(settings.modelCallBudget !== undefined && { modelCallBudget: settings.modelCallBudget }),
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
