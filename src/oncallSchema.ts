/**
 * The on-call schema (#37): who may be phoned, and the policy that says when. Pure, with no Firestore or Node
 * dependency, so the engine (src/oncall/) and the operator UI (Settings -> On-call) run the same checks, as with
 * src/settingsSchema.ts.
 *
 * Where it lives, and why not in the runtime settings: a phone number is personal data, and the runtime settings
 * have an operator-readable copy. The policy is `{onCallCollection}/policy` and each person is
 * `{onCallPeopleCollection}/{id}`; firestore.rules lets only admins read or write either, and lets a client create a
 * person only as `pending`. Only the engine marks a number `confirmed`, when the person reads back the code it texted
 * (src/oncall/optIn.ts): nobody is phoned on a number they did not confirm.
 */

export const ONCALL_ROLES = ["primary", "secondary", "support-lead"] as const;
export type OnCallRole = (typeof ONCALL_ROLES)[number];

export const ROLE_LABELS: Record<OnCallRole, string> = {
  primary: "Primary",
  secondary: "Secondary",
  "support-lead": "Support lead",
};

/** E.164: a plus, a country code that does not start with 0, at most 15 digits in all. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME_RE = /^[^<>\p{Cc}]{1,80}$/u;

export const POLICY_DOC = "policy";

export interface OnCallPolicy {
  /** The admin's switch. The deployment's own `STARFISH_PHONE_ESCALATION` must be on too; both are off by default. */
  enabled: boolean;
  /** How long after the Slack "needs a human" message an unacknowledged incident waits before the first call. */
  waitMinutes: number;
  /** Local "HH:MM" bounds of the quiet hours, in `timeZone`; both absent means none. The range may wrap midnight. */
  quietStart?: string;
  quietEnd?: string;
  /** An IANA time zone, e.g. `Europe/London`. */
  timeZone: string;
  /** The most calls one person gets per UTC day, across every incident. */
  dailyCapPerPerson: number;
  /**
   * An incident counts as critical (and so may call during quiet hours) when it is a regression (`recurred`) or has at
   * least this many occurrences. Starfish's triage records no severity; this is the deterministic stand-in.
   */
  criticalOccurrences: number;
}

export const DEFAULT_POLICY: Readonly<OnCallPolicy> = Object.freeze({
  enabled: false,
  waitMinutes: 10,
  timeZone: "UTC",
  dailyCapPerPerson: 5,
  criticalOccurrences: 100,
});

export const POLICY_KEYS = [
  "enabled",
  "waitMinutes",
  "quietStart",
  "quietEnd",
  "timeZone",
  "dailyCapPerPerson",
  "criticalOccurrences",
] as const;

export type PersonState = "pending" | "confirmed";

export interface OnCallPerson {
  id: string;
  name: string;
  role: OnCallRole;
  /** E.164. Never shown, logged or stored anywhere else unmasked (`maskPhone`). */
  phone: string;
  state: PersonState;
  /** Milliseconds; orders people who share a role (the earliest confirmed one is called). */
  createdMs: number;
}

/** A time zone the runtime knows. */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const intIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** The policy from its stored document: the defaults for a missing one, null for one that is not valid (never throws). */
export function parsePolicy(raw: unknown): OnCallPolicy | null {
  if (raw === undefined || raw === null) return { ...DEFAULT_POLICY };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const p = { ...DEFAULT_POLICY } as OnCallPolicy;
  if (d.enabled !== undefined) {
    if (typeof d.enabled !== "boolean") return null;
    p.enabled = d.enabled;
  }
  if (d.waitMinutes !== undefined) {
    if (!intIn(d.waitMinutes, 1, 240)) return null;
    p.waitMinutes = d.waitMinutes;
  }
  const hasStart = d.quietStart !== undefined && d.quietStart !== "";
  const hasEnd = d.quietEnd !== undefined && d.quietEnd !== "";
  if (hasStart !== hasEnd) return null;
  if (hasStart) {
    if (typeof d.quietStart !== "string" || !HHMM_RE.test(d.quietStart) || typeof d.quietEnd !== "string" || !HHMM_RE.test(d.quietEnd)) return null;
    if (d.quietStart === d.quietEnd) return null;
    p.quietStart = d.quietStart;
    p.quietEnd = d.quietEnd;
  }
  if (d.timeZone !== undefined) {
    if (!validTimeZone(d.timeZone)) return null;
    p.timeZone = d.timeZone;
  }
  if (d.dailyCapPerPerson !== undefined) {
    if (!intIn(d.dailyCapPerPerson, 1, 20)) return null;
    p.dailyCapPerPerson = d.dailyCapPerPerson;
  }
  if (d.criticalOccurrences !== undefined) {
    if (!intIn(d.criticalOccurrences, 1, 1_000_000)) return null;
    p.criticalOccurrences = d.criticalOccurrences;
  }
  return p;
}

/** A person from its stored document, or null for one that is not usable (never throws). `createdMs` is passed in. */
export function parsePerson(id: string, raw: unknown, createdMs: number): OnCallPerson | null {
  if (typeof raw !== "object" || raw === null || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.name !== "string" || !NAME_RE.test(d.name)) return null;
  if (typeof d.role !== "string" || !(ONCALL_ROLES as readonly string[]).includes(d.role)) return null;
  if (typeof d.phone !== "string" || !E164_RE.test(d.phone)) return null;
  if (d.state !== "pending" && d.state !== "confirmed") return null;
  return { id, name: d.name, role: d.role as OnCallRole, phone: d.phone, state: d.state, createdMs: Number.isFinite(createdMs) ? createdMs : 0 };
}

/** Whether a person's name is acceptable (the UI checks before it saves; the rules check the length). */
export const validName = (name: string): boolean => NAME_RE.test(name.trim());

/**
 * A phone number as anyone may see it: the first digit of the country code and the last two digits,
 * `+1 ••• ••• ••42`. Anything that is not an E.164 number is masked whole.
 */
export function maskPhone(phone: string): string {
  if (!E164_RE.test(phone)) return "•••";
  return `+${phone.charAt(1)} ••• ••• ••${phone.slice(-2)}`;
}

/** Minutes past local midnight in `timeZone` (UTC when the zone is unknown). */
export function localMinutes(now: Date, timeZone: string): number {
  let tz = "UTC";
  if (validTimeZone(timeZone)) tz = timeZone;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True inside the quiet hours: [start, end) in local time, wrapping midnight when start is after end. */
export function inQuietHours(policy: Pick<OnCallPolicy, "quietStart" | "quietEnd" | "timeZone">, now: Date): boolean {
  if (!policy.quietStart || !policy.quietEnd) return false;
  const m = localMinutes(now, policy.timeZone);
  const start = toMinutes(policy.quietStart);
  const end = toMinutes(policy.quietEnd);
  return start < end ? m >= start && m < end : m >= start || m < end;
}
