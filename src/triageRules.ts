/**
 * The rules engine and the feedback engine (docs/design/auto-merge-policy.md): how far Starfish may go with an incident,
 * decided by people and applied by code, never by the model.
 *
 *   rules engine     an admin's class rules (runtime settings `classRules`, env `STARFISH_CLASS_RULES`): incidents whose
 *                    error type, error code, service or function match a rule go no further than its `maxLevel`
 *                    (noise, log or fix).
 *   feedback engine  an operator's correction of ONE incident (the `corrected*` fields on the incident, written from the
 *                    UI under firestore.rules): "this should have gone no further than X". It caps that incident the
 *                    same way, and `pnpm feedback-corpus` turns corrections into replay cases (#10's corpus format).
 *
 * Both only ever HOLD STARFISH BACK. A cap lowers the level triage chose (merge > fix > log > noise); nothing here raises
 * it, lists a merge case or turns on a switch. The most restrictive cap wins, so an operator's correction can't lift an
 * admin's rule. Widening what Starfish merges stays the admin's merge-case list and switches (autoMerge.ts).
 *
 * Pure, with no Firestore or Node dependency: the engine (triage, the merge step) and the operator UI (which shows the
 * cap and validates before it saves) run the same code.
 */
import { incidentKindOf } from "./incidentKinds.js";

/** How far Starfish goes, lowest first: decline as noise, log it (an issue, a person fixes it), a fix PR, a merged fix. */
export const LEVELS = ["noise", "log", "fix", "merge"] as const;
export type Level = (typeof LEVELS)[number];
/** What a cap can hold an incident to. A cap of `merge` would hold nothing back, so it is not one. */
export type CapLevel = Exclude<Level, "merge">;
export const CAP_LEVELS: readonly CapLevel[] = ["noise", "log", "fix"];

/** The incident fields a class rule can match on, exactly (case-sensitive). */
export const RULE_MATCH_KEYS = ["errorType", "errorCode", "service", "functionName"] as const;
export type RuleMatchKey = (typeof RULE_MATCH_KEYS)[number];
export type RuleMatch = Partial<Record<RuleMatchKey, string>>;

/** One admin rule: incidents matching every field in `match` go no further than `maxLevel`. */
export interface ClassRule {
  id: string;
  match: RuleMatch;
  maxLevel: CapLevel;
  /** Why, for people. Never sent to the model. */
  note?: string;
}

/** An operator's correction of one incident, as stored on it. `merge` means "nothing held back". */
export interface IncidentCorrection {
  level: Level;
  /** Uid of the operator. For the UI and the audit; never sent to the model. */
  by: string;
  /** When, ISO. Absent when the stored value was not a timestamp. */
  at?: string;
  note?: string;
}

/** The cap that applies to an incident, and where it came from. */
export interface LevelCap {
  level: CapLevel;
  by: "rule" | "correction";
  /** The class rule's id, when `by` is `rule`. */
  ruleId?: string;
}

export const MAX_CLASS_RULES = 50;
export const MAX_RULE_VALUE = 200;
export const MAX_NOTE = 300;
/** A rule id: lowercase letters, digits and '-', 2-40 characters, starting with a letter (as a merge case id). */
export const CLASS_RULE_ID = /^[a-z][a-z0-9-]{1,39}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const levelRank = (level: Level): number => LEVELS.indexOf(level);
export const isLevel = (v: unknown): v is Level => typeof v === "string" && (LEVELS as readonly string[]).includes(v);
export const isCapLevel = (v: unknown): v is CapLevel => typeof v === "string" && (CAP_LEVELS as readonly string[]).includes(v);

/** A free-text value a rule or correction may hold: trimmed, 1..max characters, no control characters; else null. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" || t.length > max || CONTROL.test(t) ? null : t;
}

/**
 * Check a list of class rules (from the settings document or the environment). The problem names the rule, never a
 * value: a bad value may be a pasted credential, and the message reaches logs and the Settings page.
 */
export function validateClassRules(raw: unknown): { ok: true; rules: ClassRule[] } | { ok: false; problem: string } {
  const problem = `classRules: a list of at most ${MAX_CLASS_RULES} rules, each { id, match, maxLevel, note? }: a unique id of 2-40 lowercase letters, digits or '-' starting with a letter; match with at least one of ${RULE_MATCH_KEYS.join(", ")}, each 1-${MAX_RULE_VALUE} characters; maxLevel one of ${CAP_LEVELS.join(", ")}; a note of at most ${MAX_NOTE} characters; no control characters`;
  if (!Array.isArray(raw) || raw.length > MAX_CLASS_RULES) return { ok: false, problem };
  const rules: ClassRule[] = [];
  const seen = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (!isPlainObject(entry) || Object.keys(entry).some((k) => !["id", "match", "maxLevel", "note"].includes(k))) return { ok: false, problem };
    const { id, match, maxLevel, note } = entry;
    if (typeof id !== "string" || !CLASS_RULE_ID.test(id) || seen.has(id)) return { ok: false, problem };
    if (!isCapLevel(maxLevel)) return { ok: false, problem };
    if (!isPlainObject(match)) return { ok: false, problem };
    const keys = Object.keys(match);
    if (keys.length === 0 || keys.some((k) => !(RULE_MATCH_KEYS as readonly string[]).includes(k))) return { ok: false, problem };
    const cleanMatch: RuleMatch = {};
    for (const k of keys as RuleMatchKey[]) {
      const value = cleanText(match[k], MAX_RULE_VALUE);
      if (value === null) return { ok: false, problem };
      cleanMatch[k] = value;
    }
    let cleanNote: string | undefined;
    if (note !== undefined && note !== "") {
      const n = cleanText(note, MAX_NOTE);
      if (n === null) return { ok: false, problem };
      cleanNote = n;
    }
    seen.add(id);
    rules.push({ id, match: cleanMatch, maxLevel, ...(cleanNote !== undefined && { note: cleanNote }) });
  }
  return { ok: true, rules };
}

/** The fields of an incident a rule reads, and what tells its kind (src/incidentKinds.ts). */
export type RuleSubject = Partial<Record<RuleMatchKey, string | undefined | null>> & { signalSource?: unknown; fingerprint?: unknown };

/** True when every field the rule names equals the incident's. A field the incident lacks never matches. */
export function ruleMatches(rule: ClassRule, incident: RuleSubject): boolean {
  return RULE_MATCH_KEYS.every((k) => rule.match[k] === undefined || incident[k] === rule.match[k]);
}

const millis = (v: unknown): number | undefined => {
  const t = v as { toMillis?: unknown } | null | undefined;
  if (typeof t?.toMillis === "function") return t.toMillis() as number;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/**
 * The correction stored on an incident document, or undefined. Read strictly: a level that is not one of LEVELS, or no
 * operator, is no correction (firestore.rules allows neither from the UI).
 */
export function readCorrection(doc: Record<string, unknown> | undefined): IncidentCorrection | undefined {
  if (!doc || !isLevel(doc.correctedLevel) || typeof doc.correctedBy !== "string" || doc.correctedBy === "") return undefined;
  const at = millis(doc.correctedAt);
  const note = cleanText(doc.correctionNote, MAX_NOTE);
  return {
    level: doc.correctedLevel,
    by: doc.correctedBy,
    ...(at !== undefined && { at: new Date(at).toISOString() }),
    ...(note !== null && { note }),
  };
}

/** When the stored correction was made (millis), or undefined. */
export function correctedAtMillis(doc: Record<string, unknown> | undefined): number | undefined {
  return doc && isLevel(doc.correctedLevel) ? millis(doc.correctedAt) : undefined;
}

/**
 * The cap on an incident: the lowest of the matching class rules' `maxLevel` and the operator's correction, or null when
 * nothing holds it back. On a tie the correction is named (a person looked at this very incident), then the first rule.
 * Class rules never apply to a kind that overrides them (src/incidentKinds.ts `overridesClassRules`: a consolidated
 * Cloud Run quota or an overflow incident, whose fields are synthetic, so a rule written for an app's own errors would
 * match them by accident, #435); the operator's correction of the incident still does.
 */
export function levelCap(incident: RuleSubject, rules: readonly ClassRule[], correction?: Pick<IncidentCorrection, "level">): LevelCap | null {
  let cap: LevelCap | null = null;
  if (correction && isCapLevel(correction.level)) cap = { level: correction.level, by: "correction" };
  if (incidentKindOf(incident).overridesClassRules) return cap;
  for (const rule of rules) {
    if (!ruleMatches(rule, incident)) continue;
    if (cap === null || levelRank(rule.maxLevel) < levelRank(cap.level)) cap = { level: rule.maxLevel, by: "rule", ruleId: rule.id };
  }
  return cap;
}

/** Whether `cap` holds `level` back. */
export const capHolds = (cap: LevelCap | null, level: Level): boolean => cap !== null && levelRank(level) > levelRank(cap.level);

/** The cap in words, for a reason a person reads: "the admin's rule `x`" or "an operator's correction". */
export function capSource(cap: LevelCap): string {
  return cap.by === "rule" ? `the admin's rule "${cap.ruleId ?? "unknown"}"` : "an operator's correction";
}
