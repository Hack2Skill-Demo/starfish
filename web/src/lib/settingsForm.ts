/**
 * The Settings form's model, and its translation to and from a settings document.
 *
 * Every field is "use the engine's default" or an override. The browser can't
 * see the engine's defaults (they are its environment variables), so the form
 * never shows a default value, only whether one is being overridden. For the two
 * list fields an override with nothing in it is meaningful ("suppress nothing"),
 * which is why "default" and "empty" are separate states.
 */
import { SETTINGS_VERSION, validateSettings, type RuntimeSettings } from "../../../src/settingsSchema";
import type { StoredSettings } from "./settingsWrite";

export interface FieldState {
  override: boolean;
  text: string;
}

export const FIELD_NAMES = [
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
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
export type FormState = Record<FieldName, FieldState>;

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

/** The form for a stored document (null: nothing stored, every field on its default). */
export function formFromStored(stored: StoredSettings | null): FormState {
  const s = (stored ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join("\n") : "");
  const patterns = (v: unknown) =>
    v && typeof v === "object"
      ? Object.entries(v as Record<string, unknown>)
          .map(([pattern, service]) => `${pattern}: ${String(service)}`)
          .join("\n")
      : "";
  return {
    watchedProjectId: { override: "watchedProjectId" in s, text: typeof s.watchedProjectId === "string" ? s.watchedProjectId : "" },
    environment: { override: "environment" in s, text: typeof s.environment === "string" ? s.environment : "" },
    logResourceTypes: { override: "logResourceTypes" in s, text: list(s.logResourceTypes) },
    servicePatterns: { override: "servicePatterns" in s, text: patterns(s.servicePatterns) },
    ignoredMessages: { override: "ignoredMessages" in s, text: list(s.ignoredMessages) },
    dryRun: { override: "dryRun" in s, text: typeof s.dryRun === "boolean" ? String(s.dryRun) : "true" },
    reviewRequired: { override: "reviewRequired" in s, text: typeof s.reviewRequired === "boolean" ? String(s.reviewRequired) : "true" },
    automationEnabled: { override: "automationEnabled" in s, text: typeof s.automationEnabled === "boolean" ? String(s.automationEnabled) : "true" },
    // Both merge switches start from off: turning auto-merge on is a deliberate admin action (#9).
    autoMerge: { override: "autoMerge" in s, text: typeof s.autoMerge === "boolean" ? String(s.autoMerge) : "false" },
    mergeFreeze: { override: "mergeFreeze" in s, text: typeof s.mergeFreeze === "boolean" ? String(s.mergeFreeze) : "false" },
    modelCallBudget: { override: "modelCallBudget" in s, text: typeof s.modelCallBudget === "number" ? String(s.modelCallBudget) : "" },
    model: { override: "model" in s, text: typeof s.model === "string" ? s.model : "" },
    location: { override: "location" in s, text: typeof s.location === "string" ? s.location : "" },
  };
}

export type FormResult = { ok: true; settings: RuntimeSettings } | { ok: false; problems: string[] };

/**
 * Turn the form into settings and check them with the same validator the engine
 * runs on read. A problem names the field and the rule, never the value.
 */
export function settingsFromForm(form: FormState): FormResult {
  const problems: string[] = [];
  const raw: Record<string, unknown> = { version: SETTINGS_VERSION };

  if (form.watchedProjectId.override) raw.watchedProjectId = form.watchedProjectId.text.trim();
  if (form.environment.override) raw.environment = form.environment.text.trim();
  if (form.model.override) raw.model = form.model.text.trim();
  if (form.location.override) raw.location = form.location.text.trim();
  if (form.logResourceTypes.override) raw.logResourceTypes = lines(form.logResourceTypes.text);
  if (form.ignoredMessages.override) raw.ignoredMessages = lines(form.ignoredMessages.text);

  // The switches are a select, so the text is exactly "true" or "false"; anything else is left as it is
  // for the validator to refuse rather than guessed at.
  for (const flag of ["dryRun", "reviewRequired", "automationEnabled", "autoMerge", "mergeFreeze"] as const) {
    if (form[flag].override) raw[flag] = form[flag].text === "true" ? true : form[flag].text === "false" ? false : form[flag].text;
  }
  if (form.modelCallBudget.override) {
    const text = form.modelCallBudget.text.trim();
    raw.modelCallBudget = text === "" ? Number.NaN : Number(text);
  }

  if (form.servicePatterns.override) {
    const patterns: Record<string, string> = {};
    lines(form.servicePatterns.text).forEach((line, i) => {
      const at = line.indexOf(":");
      const pattern = at < 0 ? "" : line.slice(0, at).trim();
      const service = at < 0 ? "" : line.slice(at + 1).trim();
      if (pattern === "" || service === "") problems.push(`servicePatterns: line ${i + 1} must be "pattern: service"`);
      else patterns[pattern] = service;
    });
    raw.servicePatterns = patterns;
  }

  const checked = validateSettings(raw);
  if (!checked.ok) problems.push(...checked.problems);
  return problems.length > 0 || !checked.ok ? { ok: false, problems } : { ok: true, settings: checked.settings };
}
