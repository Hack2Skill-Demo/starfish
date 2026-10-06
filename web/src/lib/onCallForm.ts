/**
 * The on-call policy form (#37): what the admin typed, turned into a policy the engine accepts (`parsePolicy` in
 * src/oncallSchema.ts, the same check the engine runs on read), or the problems with it. Pure.
 */
import { DEFAULT_POLICY, parsePolicy, type OnCallPolicy } from "../../../src/oncallSchema";

export interface PolicyForm {
  enabled: boolean;
  waitMinutes: string;
  quietStart: string;
  quietEnd: string;
  timeZone: string;
  dailyCapPerPerson: string;
  criticalOccurrences: string;
}

export function formFromPolicy(policy: OnCallPolicy | null): PolicyForm {
  const p = policy ?? DEFAULT_POLICY;
  return {
    enabled: p.enabled,
    waitMinutes: String(p.waitMinutes),
    quietStart: p.quietStart ?? "",
    quietEnd: p.quietEnd ?? "",
    timeZone: p.timeZone,
    dailyCapPerPerson: String(p.dailyCapPerPerson),
    criticalOccurrences: String(p.criticalOccurrences),
  };
}

const int = (s: string): number => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

export function policyFromForm(form: PolicyForm): { ok: true; policy: OnCallPolicy } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const wait = int(form.waitMinutes);
  if (!(wait >= 1 && wait <= 240)) problems.push("Wait must be a whole number of minutes from 1 to 240.");
  const cap = int(form.dailyCapPerPerson);
  if (!(cap >= 1 && cap <= 20)) problems.push("Daily calls per person must be from 1 to 20.");
  const critical = int(form.criticalOccurrences);
  if (!(critical >= 1 && critical <= 1_000_000)) problems.push("Critical occurrences must be a whole number from 1 to 1,000,000.");
  const start = form.quietStart.trim();
  const end = form.quietEnd.trim();
  if ((start === "") !== (end === "")) problems.push("Set both ends of the quiet hours, or neither.");
  const candidate = {
    enabled: form.enabled,
    waitMinutes: wait,
    ...(start !== "" && end !== "" && { quietStart: start, quietEnd: end }),
    timeZone: form.timeZone.trim(),
    dailyCapPerPerson: cap,
    criticalOccurrences: critical,
  };
  if (problems.length > 0) return { ok: false, problems };
  const policy = parsePolicy(candidate);
  if (!policy) return { ok: false, problems: ["Quiet hours must be HH:MM (24-hour) and differ, and the time zone must be an IANA name such as Europe/London."] };
  return { ok: true, policy };
}
