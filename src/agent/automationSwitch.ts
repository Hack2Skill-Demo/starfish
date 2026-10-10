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
import { levelCap, readCorrection, type LevelCap, type RuleSubject } from "../triageRules.js";
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
 * (autoMerge.ts `mergeBlockedBy`: the kill switch, dry run, the merge freeze, `autoMerge`, the target allowlist, and with a
 * case, that the case is still listed). Fails closed: settings that cannot be read, or are unusable with nothing good
 * known, block merging.
 */
export function makeMergeSwitch(loader: Pick<RuntimeConfigLoader, "resolve">, db: Firestore): (mergeCase?: string) => Promise<string | null> {
  return async (mergeCase?: string) => {
    try {
      const resolved = await loader.resolve(db);
      if (!resolved.actionsAllowed) return "settings-unusable";
      return mergeBlockedBy(resolved.config, mergeCase);
    } catch {
      return "settings-unreadable";
    }
  };
}

/**
 * The rules engine's cap on one incident (src/triageRules.ts), read FRESH like the switches: the class rules of the
 * current runtime settings and the operator's correction on the incident as stored now. Null: nothing holds it back.
 * Fails closed: settings that can't be read or are unusable with nothing good known, or an incident that can't be read,
 * THROW, so the merge step leaves the candidate for the next pass instead of merging on a guess.
 */
export function makeCapReader(loader: Pick<RuntimeConfigLoader, "resolve">, db: Firestore, incidentCollection: string): (incidentId: string) => Promise<LevelCap | null> {
  return async (incidentId: string) => {
    const resolved = await loader.resolve(db);
    if (!resolved.actionsAllowed) throw new Error("settings unusable: the class rules are unknown");
    const snap = await db.collection(incidentCollection).doc(incidentId).get();
    const doc = snap.data();
    return levelCap(ruleSubjectOf(doc), resolved.config.classRules, readCorrection(doc));
  };
}

/** The fields of a stored incident a class rule matches on. */
export function ruleSubjectOf(doc: Record<string, unknown> | undefined): RuleSubject {
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  return { errorType: text(doc?.errorType), errorCode: text(doc?.errorCode), service: text(doc?.service), functionName: text(doc?.functionName) };
}
