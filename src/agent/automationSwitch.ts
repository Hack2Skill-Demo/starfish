/**
 * The kill switch the agent loop asks before every stage and again before anything is opened
 * (`LoopDeps.automationEnabled`, loop.ts). It reads the runtime settings FRESH each time it is asked, not
 * once per run, so an admin who turns automation off on the Settings page stops a cycle that is already
 * running at its next step.
 *
 * It fails closed: if the settings cannot be resolved, or they are unusable and nothing good is known
 * (`actionsAllowed` false), the answer is "off". A switch that defaults to "on" when it cannot be read is
 * not a kill switch.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { RuntimeConfigLoader } from "./../runtimeSettings.js";
import { mergeBlockedBy } from "./autoMerge.js";

export function makeAutomationSwitch(loader: Pick<RuntimeConfigLoader, "resolve">, db: Firestore): () => Promise<boolean> {
  return async () => {
    try {
      const resolved = await loader.resolve(db);
      return resolved.actionsAllowed && resolved.config.automationEnabled;
    } catch {
      return false;
    }
  };
}

/**
 * The merge switches (#9), read FRESH each time like the kill switch: null when merging is allowed now, else why not
 * (autoMerge.ts `mergeBlockedBy`: the kill switch, dry run, the merge freeze, `autoMerge`, the target allowlist). Fails
 * closed: settings that cannot be read, or are unusable with nothing good known, block merging.
 */
export function makeMergeSwitch(loader: Pick<RuntimeConfigLoader, "resolve">, db: Firestore): () => Promise<string | null> {
  return async () => {
    try {
      const resolved = await loader.resolve(db);
      if (!resolved.actionsAllowed) return "settings-unusable";
      return mergeBlockedBy(resolved.config);
    } catch {
      return "settings-unreadable";
    }
  };
}
