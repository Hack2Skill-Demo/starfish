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
