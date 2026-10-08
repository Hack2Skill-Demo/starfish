/**
 * Phone escalation (#37): when a cycle that needs a person goes unacknowledged after its Slack message, phone the
 * on-call people, one at a time. Built, tested against a fake Twilio and the Firestore emulator; never run against real
 * Twilio. Off by default (`STARFISH_PHONE_ESCALATION` and the admin's switch in Settings -> On-call must both be on),
 * and a dry run places no call and says so.
 *
 * When a call sequence starts. ALL of these, judged on the cycle and read fresh:
 *   - the cycle is waiting for a person (`waiting-human`, path `notify` or `human`);
 *   - triage judged it worth acting on: its decision was `notify` or `act`. Triage records no severity, so this is what
 *     "urgent" means here: a cycle triage declined never phones anyone;
 *   - the "needs a human" Slack message was attempted (`summary.notify` is `sent`, `failed` or, in a dry run, `dry-run`,
 *     with its time), within the
 *     last 24 hours: a cycle from before this existed, or long forgotten, is never dialled out of the blue;
 *   - nobody acknowledged it within the policy's wait (default 10 minutes) after that message.
 * Acknowledged means an operator moved the incident to `acknowledged`, `resolved` or `ignored` in the UI (statuses only
 * a person sets; `logged` and `recurred` are the engine's), or someone pressed 1 on a call. Either stops the sequence at
 * its next step.
 *
 * The sequence: the primary, the primary again two minutes after that call ended, then the secondary, then the support
 * lead. A person is skipped (and the skip recorded) when there is no confirmed number for the role or the person reached
 * the policy's daily cap; outside a critical incident nothing is dialled during the quiet hours, it waits for them to
 * end. Critical = the incident is a regression (`recurred`) or has at least the policy's `criticalOccurrences`.
 *
 * One sequence per cycle, however many passes, retries or restarts: `{escalationCollection}/{cycleId}` is created once,
 * in a transaction, and each call is CLAIMED in a transaction (the step, the person, the claimer, the per-person daily
 * count) before it is placed, so two concurrent passes cannot both place it. A call whose end Twilio never reports is
 * given up on after `CALL_STALE_MS` and the sequence moves on: at most one call per step, never a second dial of it.
 *
 * Everything is recorded as run events on the cycle (stage `escalation`, append-only, redacted, in the same transaction
 * as the state change), with the number MASKED (`+1 ••• ••• ••42`) and the person named only by role: the events are
 * readable by guests on the demo.
 *
 * Infrastructure errors (the store) throw, as in cycle.ts; a call Twilio refused is a result.
 */
import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { DocumentReference, DocumentSnapshot, Firestore, Transaction } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { appendEventsInTransaction, type RunEvent } from "../agent/cycle.js";
import { abortIfClosed } from "../ingest/store.js";
import { refreshPublicCycle } from "../publicViewStore.js";
import { inQuietHours, maskPhone, parsePerson, parsePolicy, POLICY_DOC, ROLE_LABELS, type OnCallPerson, type OnCallPolicy, type OnCallRole } from "../oncallSchema.js";
import type { TwilioClient } from "./twilio.js";

/**
 * Every transaction of the escalation and its webhooks. A read that finds its transaction closed under it (the emulator's
 * #151 class, seen here with concurrent passes, #245) is redone like an aborted attempt, within the runner's own bounded
 * attempts, as the store's upsert does (src/ingest/store.ts `abortIfClosed`): nothing was committed by that attempt.
 */
export const inTransaction = <T>(db: Firestore, fn: (tx: Transaction) => Promise<T>): Promise<T> => db.runTransaction((tx) => abortIfClosed(() => fn(tx)));

export type EscalationConfig = Pick<
  StarfishConfig,
  | "cycleCollection"
  | "incidentCollection"
  | "onCallCollection"
  | "onCallPeopleCollection"
  | "escalationCollection"
  | "environment"
  | "dryRun"
  | "phoneEscalation"
  | "onCallAudioUrl"
  | "twilioWebhookUrl"
  | "publicEnvironments"
  | "publicIncidentCollection"
  | "publicCycleCollection"
  | "publicEventCollection"
>;

export interface EscalationDeps {
  db: Firestore;
  config: EscalationConfig;
  now: () => Date;
  /** Who is claiming calls: a worker id, as for the cycle lease. */
  owner: string;
  /** Absent: no Twilio credentials, so nothing can be dialled. */
  twilio?: TwilioClient;
}

/** The call sequence. `afterMinutes` is the wait after the previous call ended. */
export const STEPS: readonly { role: OnCallRole; afterMinutes: number }[] = [
  { role: "primary", afterMinutes: 0 },
  { role: "primary", afterMinutes: 2 },
  { role: "secondary", afterMinutes: 0 },
  { role: "support-lead", afterMinutes: 0 },
];

/** Incident statuses only a person sets: any of them is an acknowledgement. */
export const ACK_STATUSES: readonly string[] = ["acknowledged", "resolved", "ignored"];
/** A Slack message older than this never starts a sequence. */
export const MAX_NOTIFY_AGE_MS = 24 * 60 * 60_000;
/** A claimed call whose end was never reported is given up on after this, and the sequence moves on. */
export const CALL_STALE_MS = 10 * 60_000;
/** The most cycles one tick looks at, and the most open sequences it steps. */
export const MAX_SCAN = 50;
const MAX_PEOPLE = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** How a call ended. */
export type CallOutcome = "passed" | "no-answer" | "voicemail" | "no-input" | "link-sent" | "invalid-key" | "failed" | "lost";

const OUTCOME_TEXT: Record<CallOutcome, string> = {
  passed: "pressed 3: passed it on",
  "no-answer": "did not answer",
  voicemail: "voicemail picked up; a message with no incident detail was left",
  "no-input": "answered, pressed nothing",
  "link-sent": "took the link by text but did not take it",
  "invalid-key": "answered, pressed no valid key",
  failed: "the call could not be placed",
  lost: "the call's end was never reported",
};

export type EscalationState = "waiting" | "calling" | "acknowledged" | "exhausted" | "stopped" | "dry-run";

const roleName = (role: OnCallRole): string => ROLE_LABELS[role].toLowerCase();
const ms = (v: unknown): number | undefined => {
  const t = v as { toMillis?: unknown } | null | undefined;
  return typeof t?.toMillis === "function" ? (t.toMillis() as number) : undefined;
};
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const hhmmUtc = (d: Date): string => `${d.toISOString().slice(11, 16)} UTC`;

/**
 * The time of the Slack message a sequence waits after, when the cycle qualifies for one; else null. Pure. A seeded
 * synthetic cycle (seedDemo.ts) never qualifies: nothing happened, so nobody is phoned about it (#192).
 */
export function escalationEligible(cycle: Record<string, unknown> | undefined, now: Date): Date | null {
  if (!cycle || cycle.synthetic === true || cycle.state !== "waiting-human" || (cycle.path !== "notify" && cycle.path !== "human")) return null;
  const summary = (cycle.summary ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const decision = summary.triage?.decision;
  if (decision !== "notify" && decision !== "act") return null;
  const notify = summary.notify;
  // `dry-run`: nothing was sent, and the sequence that follows places nothing either; it records what it would do.
  if (notify?.state !== "sent" && notify?.state !== "failed" && notify?.state !== "dry-run") return null;
  const at = typeof notify.at === "string" ? Date.parse(notify.at) : NaN;
  if (!Number.isFinite(at) || at > now.getTime() || now.getTime() - at > MAX_NOTIFY_AGE_MS) return null;
  return new Date(at);
}

/** A regression, or at least the policy's occurrences: such an incident may ring during the quiet hours. Pure. */
export function isCritical(incident: Record<string, unknown> | undefined, policy: Pick<OnCallPolicy, "criticalOccurrences">): boolean {
  if (!incident) return false;
  if (incident.status === "recurred") return true;
  return typeof incident.occurrenceCount === "number" && incident.occurrenceCount >= policy.criticalOccurrences;
}

/**
 * The number a call was claimed for, bound to the person, as a hash (#187): stored on the claim so the "2" keypress
 * (webhooks.ts) texts the link only to that same number, still confirmed. The sequences are engine-only (firestore.rules),
 * and the number itself is never stored on them. Pure.
 */
export function callNumberHash(personId: string, phone: string): string {
  return createHash("sha256").update(`${personId}\n${phone}`).digest("hex");
}

/** The person called for a role: the earliest-added CONFIRMED one. A pending number is never called. Pure. */
export function personFor(people: readonly OnCallPerson[], role: OnCallRole): OnCallPerson | undefined {
  return [...people]
    .filter((p) => p.role === role && p.state === "confirmed")
    .sort((a, b) => a.createdMs - b.createdMs || a.id.localeCompare(b.id))[0];
}

/** The policy, or null when it is unreadable or invalid: no call is placed on a policy nobody can vouch for. Never throws. */
export async function readPolicy(db: Firestore, cfg: Pick<EscalationConfig, "onCallCollection">): Promise<OnCallPolicy | null> {
  try {
    const snap = await db.collection(cfg.onCallCollection).doc(POLICY_DOC).get();
    return parsePolicy(snap.exists ? snap.data() : undefined);
  } catch {
    return null;
  }
}

function peopleFrom(docs: readonly DocumentSnapshot[]): OnCallPerson[] {
  return docs
    .map((d) => parsePerson(d.id, d.data(), ms(d.get("createdAt")) ?? 0))
    .filter((p): p is OnCallPerson => p !== null);
}

const escRef = (deps: EscalationDeps, id: string): DocumentReference => deps.db.collection(deps.config.escalationCollection).doc(id);
const capRef = (deps: EscalationDeps, personId: string, day: string): DocumentReference =>
  deps.db.collection(deps.config.escalationCollection).doc(`cap_${personId}_${day}`);

export interface TickResult {
  armed: number;
  placed: number;
  closed: number;
  /**
   * The arming scan read its cap of recently updated waiting cycles (#185): a qualifying cycle beyond it is armed on a
   * later tick, once newer ones are armed or settle. Said so it is visible, never silent.
   */
  scanCapped?: boolean;
  /** Why nothing could run at all, when nothing could. */
  skipped?: "off" | "policy-unreadable";
}

/**
 * One tick: start a sequence for every cycle that now qualifies, then take each open sequence one step further.
 * Run at the end of every agent pass and by `pnpm escalate`; Twilio's own reports (webhooks.ts) move a sequence on
 * between ticks. A sequence's waits are only as precise as how often something ticks.
 */
export async function runEscalationTick(deps: EscalationDeps): Promise<TickResult> {
  const result: TickResult = { armed: 0, placed: 0, closed: 0 };
  if (!deps.config.phoneEscalation) return { ...result, skipped: "off" };
  const policy = await readPolicy(deps.db, deps.config);
  if (policy === null) return { ...result, skipped: "policy-unreadable" };
  if (policy.enabled) {
    const armed = await armEscalations(deps, policy);
    result.armed = armed.armed;
    if (armed.capped) result.scanCapped = true;
  }
  const open = await deps.db
    .collection(deps.config.escalationCollection)
    .where("environment", "==", deps.config.environment)
    .where("open", "==", true)
    .limit(MAX_SCAN)
    .get();
  for (const doc of open.docs) {
    const r = await stepEscalation(deps, doc.id, policy);
    if (r === "placed") result.placed += 1;
    if (r === "closed") result.closed += 1;
  }
  return result;
}

/**
 * Start a sequence (one, ever) for each waiting cycle that qualifies. Returns how many were started, and whether the scan
 * read its cap. The scan reads only what can qualify: a cycle whose Slack message is less than a day old was updated
 * within that day (the message's record moved `updatedAt`), so it reads the waiting cycles updated in the last
 * `MAX_NOTIFY_AGE_MS`, newest first (#185). Old waiting cycles, which only accumulate, can no longer fill the scan and
 * crowd a new one out. Index: (environment, state, updatedAt desc), firestore.indexes.json.
 */
export async function armEscalations(deps: EscalationDeps, policy: OnCallPolicy): Promise<{ armed: number; capped: boolean }> {
  const { db, config: cfg } = deps;
  const since = Timestamp.fromMillis(deps.now().getTime() - MAX_NOTIFY_AGE_MS);
  const waiting = await db
    .collection(cfg.cycleCollection)
    .where("environment", "==", cfg.environment)
    .where("state", "==", "waiting-human")
    .where("updatedAt", ">=", since)
    .orderBy("updatedAt", "desc")
    .limit(MAX_SCAN)
    .get();
  let armed = 0;
  for (const doc of waiting.docs) {
    if (!ID_RE.test(doc.id) || escalationEligible(doc.data(), deps.now()) === null) continue;
    const ref = escRef(deps, doc.id);
    const created = await inTransaction(db, async (tx) => {
      const now = deps.now();
      const [esc, cycle] = await Promise.all([tx.get(ref), tx.get(doc.ref)]);
      const d = cycle.data();
      const notifiedAt = escalationEligible(d, now);
      if (esc.exists || notifiedAt === null || typeof d?.incidentId !== "string") return false;
      const dueAt = new Date(notifiedAt.getTime() + policy.waitMinutes * 60_000);
      tx.create(ref, {
        cycleId: doc.id,
        incidentId: d.incidentId,
        environment: cfg.environment,
        open: true,
        state: "waiting" satisfies EscalationState,
        step: 0,
        notifiedAt: Timestamp.fromDate(notifiedAt),
        nextAt: Timestamp.fromDate(dueAt),
        createdAt: Timestamp.fromDate(now),
        updatedAt: Timestamp.fromDate(now),
      });
      appendEventsInTransaction(tx, doc.ref, d, now, [
        {
          stage: "escalation",
          type: "armed",
          summary: `If nobody acknowledges it by ${hhmmUtc(dueAt)}, Starfish phones the on-call primary`,
          data: { waitMinutes: policy.waitMinutes },
          record: { state: "waiting", step: 0, dueAt: dueAt.toISOString() },
        },
      ], cfg);
      return true;
    });
    if (created) {
      armed += 1;
      // The cycle's guest copy, from what was just stored (src/publicViewStore.ts, #18). Never throws.
      await refreshPublicCycle(db, cfg, doc.id);
    }
  }
  return { armed, capped: waiting.size >= MAX_SCAN };
}

type Claimed = { kind: "call"; step: number; person: OnCallPerson } | { kind: "idle" } | { kind: "closed" };

/** Close the sequence: no more calls. */
function closeUpdate(state: EscalationState, now: Date): Record<string, unknown> {
  return { open: false, state, call: FieldValue.delete(), closedAt: Timestamp.fromDate(now), updatedAt: Timestamp.fromDate(now) };
}

/**
 * Move the sequence on after the current call ended with `outcome`, inside a transaction: the next step (after its
 * wait), the next PERSON when the outcome was a pass (the primary's own retry is skipped), or the end. Pure: returns
 * the escalation's update and the events, and writes nothing.
 */
export function advance(esc: Record<string, unknown>, outcome: CallOutcome, now: Date): { update: Record<string, unknown>; events: RunEvent[]; closed: boolean } {
  const call = (esc.call ?? {}) as { step?: unknown; role?: unknown; to?: unknown };
  const current = typeof call.step === "number" ? call.step : Number(esc.step ?? 0);
  const role = STEPS[current]?.role ?? "primary";
  let next = current + 1;
  if (outcome === "passed") while (next < STEPS.length && STEPS[next]!.role === role) next += 1;
  const ended: RunEvent = {
    stage: "escalation",
    type: outcome,
    summary: `The ${roleName(role)} ${OUTCOME_TEXT[outcome]}`,
    data: { step: current, role, outcome, ...(typeof call.to === "string" && { to: call.to }) },
  };
  if (next >= STEPS.length) {
    return {
      update: { ...closeUpdate("exhausted", now), lastOutcome: outcome },
      events: [ended, { stage: "escalation", type: "exhausted", summary: "Nobody took it: the call sequence ended. The Slack message stands.", record: { state: "exhausted", lastOutcome: outcome } }],
      closed: true,
    };
  }
  const nextAt = new Date(now.getTime() + STEPS[next]!.afterMinutes * 60_000);
  return {
    update: { state: "waiting", step: next, nextAt: Timestamp.fromDate(nextAt), lastOutcome: outcome, call: FieldValue.delete(), updatedAt: Timestamp.fromDate(now) },
    events: [{ ...ended, record: { state: "waiting", step: next, lastOutcome: outcome, dueAt: nextAt.toISOString() } }],
    closed: false,
  };
}

/** Why the sequence must stop before the next call, read in the transaction: an acknowledgement, or a closed incident. */
function stopReason(incident: DocumentSnapshot): { state: EscalationState; summary: string } | null {
  if (!incident.exists) return { state: "stopped", summary: "Stopped: the incident is gone" };
  const d = incident.data() ?? {};
  if (d.retired === true) return { state: "stopped", summary: "Stopped: the incident was retired" };
  if (typeof d.status === "string" && ACK_STATUSES.includes(d.status)) {
    return { state: "acknowledged", summary: `Stopped: acknowledged in the UI (the incident is ${d.status})` };
  }
  return null;
}

/**
 * Take one sequence one step further: stop it if it was acknowledged, wait if its time has not come or a call is in
 * flight, else claim the next call (transactionally) and place it. Returns what happened.
 *
 * `kick` (#225): the admin API's step after a call ended. It runs with the ADMIN API's own config, which the deploy does
 * not give the agent's dry run or phone switch, so a kick may place a due call or wait, but never closes a sequence
 * because of its own process's settings (the deployment switch off, a dry run, Twilio, the audio file or the webhook URL
 * missing): it leaves the sequence open, and the agent's next tick decides with the agent's. What the store says (an
 * acknowledgement, the admin's switch in the policy, a day-old message, nobody left to call) closes it either way.
 */
export async function stepEscalation(
  deps: EscalationDeps,
  id: string,
  policy: OnCallPolicy,
  opts: { kick?: boolean } = {}
): Promise<"placed" | "closed" | "idle"> {
  const { db, config: cfg } = deps;
  const ref = escRef(deps, id);
  const claimed = await inTransaction(db, async (tx): Promise<Claimed> => {
    const now = deps.now();
    const esc = await tx.get(ref);
    const e = esc.data();
    if (!esc.exists || !e || e.open !== true || typeof e.cycleId !== "string" || typeof e.incidentId !== "string") return { kind: "idle" };
    const cycleRef = db.collection(cfg.cycleCollection).doc(e.cycleId);
    const [cycle, incident, peopleSnap] = await Promise.all([
      tx.get(cycleRef),
      tx.get(db.collection(cfg.incidentCollection).doc(e.incidentId)),
      tx.get(db.collection(cfg.onCallPeopleCollection).limit(MAX_PEOPLE)),
    ]);
    const c = cycle.data();
    const note = (events: RunEvent[]) => appendEventsInTransaction(tx, cycleRef, c, now, events, cfg);

    const stop = stopReason(incident);
    if (stop) {
      tx.update(ref, closeUpdate(stop.state, now));
      note([{ stage: "escalation", type: stop.state, summary: stop.summary, record: { state: stop.state } }]);
      return { kind: "closed" };
    }
    // A sequence left open while the switch was off (or the policy unreadable) never rings a day later.
    if (now.getTime() - (ms(e.notifiedAt) ?? 0) > MAX_NOTIFY_AGE_MS) {
      tx.update(ref, closeUpdate("stopped", now));
      note([{ stage: "escalation", type: "stopped", summary: "Stopped: the Slack message is more than a day old", record: { state: "stopped" } }]);
      return { kind: "closed" };
    }
    if (opts.kick && (!cfg.phoneEscalation || cfg.dryRun || !deps.twilio || cfg.onCallAudioUrl === "" || cfg.twilioWebhookUrl === "")) {
      return { kind: "idle" };
    }
    if (!cfg.phoneEscalation || !policy.enabled) {
      tx.update(ref, closeUpdate("stopped", now));
      note([{ stage: "escalation", type: "stopped", summary: "Stopped: phone escalation was turned off", record: { state: "stopped" } }]);
      return { kind: "closed" };
    }
    if (e.call !== undefined) {
      // A call is in flight. Its end comes from Twilio (webhooks.ts); one never reported is given up on, not redialled.
      const claimedAt = ms((e.call as { claimedAt?: unknown }).claimedAt) ?? 0;
      if (now.getTime() - claimedAt < CALL_STALE_MS) return { kind: "idle" };
      const moved = advance(e, "lost", now);
      tx.update(ref, moved.update);
      note(moved.events);
      return moved.closed ? { kind: "closed" } : { kind: "idle" };
    }
    if (now.getTime() < (ms(e.nextAt) ?? 0)) return { kind: "idle" };

    const people = peopleFrom(peopleSnap.docs);
    const critical = isCritical(incident.data(), policy);
    if (!critical && inQuietHours(policy, now)) {
      if (e.quietHeld !== true) {
        tx.update(ref, { quietHeld: true, updatedAt: Timestamp.fromDate(now) });
        note([{ stage: "escalation", type: "held", summary: `Held for the quiet hours (until ${policy.quietEnd} ${policy.timeZone}); not critical`, record: { state: "held", step: Number(e.step ?? 0) } }]);
      }
      return { kind: "idle" };
    }

    if (cfg.dryRun) {
      const first = personFor(people, STEPS[Number(e.step ?? 0)]?.role ?? "primary");
      tx.update(ref, closeUpdate("dry-run", now));
      note([
        {
          stage: "escalation",
          type: "dry-run",
          summary: first
            ? `The on-call ${roleName(first.role)} (${maskPhone(first.phone)}) would be phoned here; nothing placed (dry run)`
            : "A call would be placed here, but no confirmed number is on the rota; nothing placed (dry run)",
          record: { state: "dry-run" },
        },
      ]);
      return { kind: "closed" };
    }
    if (!deps.twilio || cfg.onCallAudioUrl === "" || cfg.twilioWebhookUrl === "") {
      tx.update(ref, closeUpdate("stopped", now));
      note([{ stage: "escalation", type: "stopped", summary: "Cannot phone anyone: Twilio, the audio file or the webhook URL is not configured", record: { state: "stopped" } }]);
      return { kind: "closed" };
    }

    // The first step from here that has someone to call: a confirmed number, under the daily cap. Every read first.
    const day = utcDay(now);
    const skipped: RunEvent[] = [];
    const counts = new Map<string, number>();
    let chosen: { step: number; person: OnCallPerson } | undefined;
    for (let step = Number(e.step ?? 0); step < STEPS.length; step++) {
      const role = STEPS[step]!.role;
      const person = personFor(people, role);
      if (!person) {
        skipped.push({ stage: "escalation", type: "skipped", summary: `No confirmed number for the ${roleName(role)}: skipped`, data: { step, role, rule: "no-confirmed-number" } });
        continue;
      }
      if (!counts.has(person.id)) counts.set(person.id, Number((await tx.get(capRef(deps, person.id, day))).get("count") ?? 0));
      if (counts.get(person.id)! >= policy.dailyCapPerPerson) {
        skipped.push({ stage: "escalation", type: "skipped", summary: `The ${roleName(role)} reached today's call cap (${policy.dailyCapPerPerson}): skipped`, data: { step, role, rule: "daily-cap" } });
        continue;
      }
      chosen = { step, person };
      break;
    }
    if (!chosen) {
      tx.update(ref, closeUpdate("exhausted", now));
      note([...skipped, { stage: "escalation", type: "exhausted", summary: "Nobody left to call: the call sequence ended. The Slack message stands.", record: { state: "exhausted" } }]);
      return { kind: "closed" };
    }
    const to = maskPhone(chosen.person.phone);
    tx.update(ref, {
      state: "calling",
      step: chosen.step,
      quietHeld: false,
      call: {
        step: chosen.step,
        personId: chosen.person.id,
        role: chosen.person.role,
        to,
        numberHash: callNumberHash(chosen.person.id, chosen.person.phone),
        claimedBy: deps.owner,
        claimedAt: Timestamp.fromDate(now),
      },
      updatedAt: Timestamp.fromDate(now),
    });
    tx.set(capRef(deps, chosen.person.id, day), { personId: chosen.person.id, day, count: counts.get(chosen.person.id)! + 1, updatedAt: Timestamp.fromDate(now) }, { merge: true });
    note([
      ...skipped,
      {
        stage: "escalation",
        type: "calling",
        summary: `Phoning the on-call ${roleName(chosen.person.role)} (${to})${critical ? "; critical" : ""}`,
        data: { step: chosen.step, role: chosen.person.role, to, critical },
        record: { state: "calling", step: chosen.step, role: chosen.person.role, to },
      },
    ]);
    return { kind: "call", ...chosen };
  });
  // The sequence's id is its cycle's (armEscalations): bring the cycle's guest copy up to date with any event noted (#18).
  await refreshPublicCycle(db, cfg, id);
  if (claimed.kind !== "call") return claimed.kind;

  // Placed outside the transaction (a transaction may run twice; a call must not). The claim above is what makes it once.
  const base = cfg.twilioWebhookUrl;
  const q = `e=${encodeURIComponent(id)}&s=${claimed.step}`;
  let placed: Awaited<ReturnType<TwilioClient["placeCall"]>>;
  try {
    placed = await deps.twilio!.placeCall(claimed.person.phone, { voiceUrl: `${base}/twilio/voice?${q}`, statusUrl: `${base}/twilio/status?${q}` });
  } catch {
    placed = { ok: false, reason: "client-error" };
  }
  await inTransaction(db, async (tx) => {
    const now = deps.now();
    const esc = await tx.get(ref);
    const e = esc.data();
    const call = e?.call as { step?: unknown; claimedBy?: unknown; callSid?: unknown } | undefined;
    if (!e || e.open !== true || call?.step !== claimed.step || call.claimedBy !== deps.owner) return;
    const cycleRef = db.collection(cfg.cycleCollection).doc(String(e.cycleId));
    const c = (await tx.get(cycleRef)).data();
    if (placed.ok) {
      tx.update(ref, { "call.callSid": call.callSid ?? placed.callSid, "call.placedAt": Timestamp.fromDate(now), updatedAt: Timestamp.fromDate(now) });
      appendEventsInTransaction(tx, cycleRef, c, now, [{ stage: "escalation", type: "placed", summary: "The call is ringing", data: { step: claimed.step } }], cfg);
      return;
    }
    const moved = advance(e, "failed", now);
    tx.update(ref, moved.update);
    appendEventsInTransaction(tx, cycleRef, c, now, [
      { stage: "escalation", type: "refused", summary: `Twilio refused the call: ${placed.reason}`, data: { step: claimed.step, reason: placed.reason } },
      ...moved.events,
    ], cfg);
  });
  await refreshPublicCycle(db, cfg, id);
  return placed.ok ? "placed" : "idle";
}

/** For a webhook: the escalation and its current call, when `step` is the call in flight. Reads in the caller's transaction. */
export async function readCurrentCall(
  tx: Transaction,
  db: Firestore,
  cfg: Pick<EscalationConfig, "escalationCollection" | "cycleCollection" | "incidentCollection">,
  id: string,
  step: number
): Promise<
  | { current: true; ref: DocumentReference; esc: Record<string, unknown>; call: Record<string, unknown>; cycleRef: DocumentReference; cycle: Record<string, unknown> | undefined; incident: DocumentSnapshot }
  | { current: false }
> {
  const ref = db.collection(cfg.escalationCollection).doc(id);
  const snap = await tx.get(ref);
  const esc = snap.data();
  const call = esc?.call as Record<string, unknown> | undefined;
  if (!esc || esc.open !== true || !call || call.step !== step || typeof esc.cycleId !== "string" || typeof esc.incidentId !== "string") return { current: false };
  const cycleRef = db.collection(cfg.cycleCollection).doc(esc.cycleId);
  const [cycle, incident] = await Promise.all([tx.get(cycleRef), tx.get(db.collection(cfg.incidentCollection).doc(esc.incidentId))]);
  return { current: true, ref, esc, call, cycleRef, cycle: cycle.data(), incident };
}

export { closeUpdate, stopReason };
