/**
 * The state the agent loop (#8) needs to be safe to run more than once: one CYCLE per incident
 * and recurrence, a LEASE that lets only one worker act on a cycle at a time, and an append-only
 * list of RUN EVENTS that the Live runs screen (#33) and the incident page (#39) render.
 *
 *   cycle    `{cycleCollection}/{incidentId}_r{recurrence}`. One recurrence is one cycle, so a
 *            regression gets a fresh cycle (and so a fresh fix) while a retry of the same
 *            recurrence resumes the old one and cannot open a second PR for it.
 *   lease    `owner` + `leaseExpiresAt` on the cycle, taken in a transaction. A crashed worker's lease
 *            runs out and another resumes the cycle, counted as another attempt; after
 *            `maxCycleAttempts` starts the cycle is given up on rather than retried forever.
 *   deadline fixed when the cycle begins. Renewing a lease can never extend past it, so a worker
 *            that keeps renewing cannot hold a cycle open indefinitely.
 *   events   `{cycle}/events/{seq}`, written only by the current lease holder (FENCING: the write
 *            checks the lease inside the same transaction, so a worker whose lease was taken over
 *            cannot record, or finish, anything). Contiguous sequence numbers, never rewritten.
 *            Everything in an event is redacted and bounded: guests read events on the demo.
 *   decline  a cycle declined by triage keeps its `decision` (when, the rule, the evidence it saw). With a
 *            reconsideration policy, `acquireLease` REOPENS a declined cycle when new evidence arrived since
 *            (reconsider.ts), in the same transaction that takes the lease: the same cycle id, so still one
 *            issue and one pull request per recurrence, the events appended after the earlier ones, the earlier
 *            decision moved to `history`, and a fresh deadline and attempt count for the new consideration.
 *   startDays the UTC days the cycle was started or reopened on: what the daily cycle cap counts (pass.ts).
 *   spend    `modelCalls` and `revisions`: what the cycle has used of its model-call budget and its one revision, counted
 *            under the fence before each is spent, so a resumed attempt goes on from them instead of from zero (#182). A
 *            reconsideration starts a fresh count, as it does the attempts; reconsiderations are themselves capped per day.
 *
 * Logical refusals (lease held elsewhere, lease lost, cycle closed) are returned as reasons.
 * Infrastructure failures throw, deliberately: a worker that cannot reach the store must not go
 * on to act on a cycle it cannot prove it holds.
 *
 * Run by the agent job (`pnpm agent`).
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { DocumentReference, Firestore, Transaction } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { clipWellFormed, isSensitiveKey } from "../ingest/redact.js";
import type { PublicViewConfig } from "../publicView.js";
import { refreshPublicCycle, writePublicEventInTx } from "../publicViewStore.js";
import { MAX_DECISION_HISTORY, reconsiderTrigger, recentReconsiderations, utcDay, type ReconsiderPolicy, type ReconsiderTrigger } from "./reconsider.js";

/** With the public-view settings: a cycle of a public environment keeps its guest copy up to date (src/publicView.ts, #18). */
export type CycleConfig = Pick<StarfishConfig, "cycleCollection" | "leaseSeconds" | "cycleDeadlineMinutes" | "maxCycleAttempts"> & PublicViewConfig;

export type CycleState = "running" | "waiting-human" | "done" | "declined" | "failed";

export interface CycleKey {
  incidentId: string;
  environment: string;
  /** The incident's `recurrenceCount` (0 before its first regression). */
  recurrence: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SUMMARY = 300;
const MAX_VALUE = 300;
/**
 * Keys whose value is worth more than MAX_VALUE whole. The counter-check's filter (#39) is shown so a person can run
 * it again; with the excluded-service clauses it is usually longer than 300, and a cut filter counts something else.
 */
export const LONG_VALUE_KEYS: Readonly<Record<string, number>> = { counterFilter: 2000 };
const MAX_DATA_KEYS = 20;
const MAX_OUTCOME = 200;
const DATA_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;
/** A stage name safe to use as a field path under `summary`. */
const STAGE_RE = /^[a-z]{1,20}$/;
const MS_PER_MINUTE = 60_000;

/** The document id of a cycle, or null for an incident id that is not a plain id. */
export function cycleId(key: CycleKey): string | null {
  if (!ID_RE.test(key.incidentId) || !Number.isInteger(key.recurrence) || key.recurrence < 0) return null;
  return `${key.incidentId}_r${key.recurrence}`;
}

export type AcquireResult =
  | {
      acquired: true;
      cycleId: string;
      attempt: number;
      resumed: boolean;
      leaseExpiresAt: Date;
      reconsidered?: ReconsiderTrigger;
      /** What earlier attempts of this cycle (this consideration) spent: model calls, revisions (#182). */
      modelCalls: number;
      revisions: number;
    }
  | { acquired: false; reason: "invalid-key" | "held" | "closed" | "waiting-human" | "deadline-passed" | "retries-exhausted" };

/** A stored count, or 0 when it is absent or not a count. */
const count = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);

const ms = (value: unknown): number | undefined => {
  const v = value as { toMillis?: unknown } | null | undefined;
  return typeof v?.toMillis === "function" ? (v.toMillis() as number) : undefined;
};

function cycleRef(db: Firestore, cfg: CycleConfig, id: string): DocumentReference {
  return db.collection(cfg.cycleCollection).doc(id);
}

/**
 * One transaction on cycle `id`. When the attempt that committed wrote the cycle (it called `wrote` with the cycle's
 * environment), the cycle's guest copy is refreshed after the commit (src/publicViewStore.ts, #18): the copy is read
 * from what was stored, never guessed from the update. The refresh never throws.
 */
async function cycleTransaction<T>(
  db: Firestore,
  cfg: CycleConfig,
  id: string,
  fn: (tx: Transaction, wrote: (environment: unknown) => void) => Promise<T>
): Promise<T> {
  let wrote = false;
  let environment: unknown;
  const result = await db.runTransaction(async (tx) => {
    // Per attempt: only the attempt that commits counts.
    wrote = false;
    environment = undefined;
    return fn(tx, (env) => {
      wrote = true;
      environment = env;
    });
  });
  if (wrote) await refreshPublicCycle(db, cfg, id, environment);
  return result;
}

/** The expiry of a lease taken at `now`: a lease, never past the cycle's deadline. */
function leaseEnd(cfg: CycleConfig, now: Date, deadlineMs: number): number {
  return Math.min(now.getTime() + cfg.leaseSeconds * 1000, deadlineMs);
}

export interface AcquireOptions {
  /** Reopen a declined cycle when new evidence arrived since its decision (reconsider.ts). Absent: a decline is closed. */
  reconsider?: ReconsiderPolicy & { incidentCollection: string };
}

/** Take (or resume, or renew) the lease on the cycle for `key`; with `opts.reconsider`, reopen a declined one that qualifies. */
export async function acquireLease(db: Firestore, cfg: CycleConfig, key: CycleKey, owner: string, now: Date, opts: AcquireOptions = {}): Promise<AcquireResult> {
  const id = cycleId(key);
  if (id === null) return { acquired: false, reason: "invalid-key" };
  const ref = cycleRef(db, cfg, id);
  const reconsider = opts.reconsider;
  const incidentRef = reconsider && db.collection(reconsider.incidentCollection).doc(key.incidentId);

  return cycleTransaction(db, cfg, id, async (tx, wrote): Promise<AcquireResult> => {
    const snap = await tx.get(ref);

    if (!snap.exists) {
      wrote(key.environment);
      const deadlineMs = now.getTime() + cfg.cycleDeadlineMinutes * MS_PER_MINUTE;
      const expires = leaseEnd(cfg, now, deadlineMs);
      tx.create(ref, {
        incidentId: key.incidentId,
        environment: key.environment,
        recurrence: key.recurrence,
        state: "running",
        attempts: 1,
        owner,
        leaseExpiresAt: Timestamp.fromMillis(expires),
        deadlineAt: Timestamp.fromMillis(deadlineMs),
        eventCount: 0,
        modelCalls: 0,
        revisions: 0,
        startDays: [utcDay(now)],
        createdAt: Timestamp.fromDate(now),
        updatedAt: Timestamp.fromDate(now),
      });
      return { acquired: true, cycleId: id, attempt: 1, resumed: false, leaseExpiresAt: new Date(expires), modelCalls: 0, revisions: 0 };
    }

    const d = snap.data() as Record<string, unknown>;
    const state = d.state as CycleState;
    if ((state === "declined" || state === "waiting-human") && reconsider && incidentRef) {
      // Read in this transaction (and only for a declined or waiting-human cycle, so an ordinary acquire never holds the incident that
      // ingest writes): a concurrent operator ignore, or a second worker, cannot both pass the check and reopen.
      const incidentSnap = await tx.get(incidentRef);
      const trigger = reconsiderTrigger(d, incidentSnap.data(), reconsider, now);
      if (trigger !== null) {
        wrote(d.environment);
        const deadlineMs = now.getTime() + cfg.cycleDeadlineMinutes * MS_PER_MINUTE;
        const expires = leaseEnd(cfg, now, deadlineMs);
        const history = Array.isArray(d.history) ? (d.history as unknown[]) : [];
        const previous = { ...(typeof d.decision === "object" && d.decision !== null ? (d.decision as Record<string, unknown>) : {}), outcome: d.outcome ?? null };
        tx.update(ref, {
          state: "running",
          attempts: 1,
          owner,
          leaseExpiresAt: Timestamp.fromMillis(expires),
          deadlineAt: Timestamp.fromMillis(deadlineMs),
          resumeUncounted: false,
          // A new consideration: a fresh budget, as it gets a fresh deadline and attempt count.
          modelCalls: 0,
          revisions: 0,
          reconsideredBecause: trigger,
          reconsiderCount: Number(d.reconsiderCount ?? 0) + 1,
          reconsideredAt: [...recentReconsiderations(d, now).map((t) => Timestamp.fromMillis(t)), Timestamp.fromDate(now)],
          history: [...history, previous].slice(-MAX_DECISION_HISTORY),
          startDays: FieldValue.arrayUnion(utcDay(now)),
          // The earlier consideration's result goes; its events and its decision (in `history`) stay. The issue and the
          // pull request stay: they are the recurrence's, and keeping them is what stops a second of either.
          decision: FieldValue.delete(),
          outcome: FieldValue.delete(),
          path: FieldValue.delete(),
          releasedBecause: FieldValue.delete(),
          "summary.triage": FieldValue.delete(),
          "summary.fix": FieldValue.delete(),
          "summary.verify": FieldValue.delete(),
          "summary.review": FieldValue.delete(),
          // A person was told once for this recurrence: a retry of a waiting-human cycle does not tell them again. A
          // declined one never reached a person, so its (absent or dry-run) record goes with the rest.
          ...(state === "declined" && { "summary.notify": FieldValue.delete() }),
          updatedAt: Timestamp.fromDate(now),
        });
        return { acquired: true, cycleId: id, attempt: 1, resumed: false, leaseExpiresAt: new Date(expires), reconsidered: trigger, modelCalls: 0, revisions: 0 };
      }
    }
    if (state !== "running") {
      return { acquired: false, reason: state === "waiting-human" ? "waiting-human" : "closed" };
    }

    const deadlineMs = ms(d.deadlineAt) ?? 0;
    if (now.getTime() >= deadlineMs) {
      wrote(d.environment);
      tx.update(ref, { state: "failed", outcome: "deadline-passed", path: "failed", owner: null, leaseExpiresAt: null, updatedAt: Timestamp.fromDate(now) });
      return { acquired: false, reason: "deadline-passed" };
    }

    const heldUntil = ms(d.leaseExpiresAt) ?? 0;
    const attempts = Number(d.attempts ?? 1);
    if (heldUntil > now.getTime() && d.owner !== owner) return { acquired: false, reason: "held" };

    // Same owner with a live lease is a renewal; otherwise the lease ran out and this is a takeover. A cycle released
    // by the kill switch (`uncounted`) is resumed without counting a start: turning automation off is not the cycle failing.
    const renewing = heldUntil > now.getTime() && d.owner === owner;
    const free = d.resumeUncounted === true;
    if (!renewing && !free && attempts >= cfg.maxCycleAttempts) {
      wrote(d.environment);
      tx.update(ref, { state: "failed", outcome: "retries-exhausted", path: "failed", owner: null, leaseExpiresAt: null, updatedAt: Timestamp.fromDate(now) });
      return { acquired: false, reason: "retries-exhausted" };
    }

    const expires = leaseEnd(cfg, now, deadlineMs);
    const attempt = renewing || free ? attempts : attempts + 1;
    wrote(d.environment);
    tx.update(ref, { owner, leaseExpiresAt: Timestamp.fromMillis(expires), attempts: attempt, resumeUncounted: false, updatedAt: Timestamp.fromDate(now) });
    return { acquired: true, cycleId: id, attempt, resumed: !renewing, leaseExpiresAt: new Date(expires), modelCalls: count(d.modelCalls), revisions: count(d.revisions) };
  });
}

/**
 * Why a `running` cycle nobody holds can only be given up, or null (#226). Pure. The same two rules `acquireLease`
 * applies when it takes a cycle over: its deadline passed, or its attempts ran out (a cycle released by the kill switch,
 * `resumeUncounted`, has not used one). A cycle whose lease is live is its holder's to finish, and is never one.
 */
export function strandedReason(d: Record<string, unknown> | undefined, now: Date, maxAttempts: number): "deadline-passed" | "retries-exhausted" | null {
  if (d?.state !== "running") return null;
  if ((ms(d.leaseExpiresAt) ?? 0) > now.getTime()) return null;
  if (now.getTime() >= (ms(d.deadlineAt) ?? 0)) return "deadline-passed";
  if (d.resumeUncounted !== true && Number(d.attempts ?? 1) >= maxAttempts) return "retries-exhausted";
  return null;
}

/**
 * Give up a stranded cycle (`strandedReason`, read again in the transaction) as `acquireLease` would have: `failed`, with
 * the reason as its outcome. Takes no lease and runs nothing. Returns the reason, or null when the cycle is not (or no
 * longer) stranded: only the call that made the transition gets a reason, so a person is told once. Throws when the
 * store does.
 */
export async function giveUpStranded(db: Firestore, cfg: CycleConfig, key: CycleKey, now: Date): Promise<"deadline-passed" | "retries-exhausted" | null> {
  const id = cycleId(key);
  if (id === null) return null;
  const ref = cycleRef(db, cfg, id);
  return cycleTransaction(db, cfg, id, async (tx, wrote) => {
    const snap = await tx.get(ref);
    const reason = strandedReason(snap.data(), now, cfg.maxCycleAttempts);
    if (reason === null) return null;
    wrote(snap.get("environment"));
    tx.update(ref, { state: "failed", outcome: reason, path: "failed", owner: null, leaseExpiresAt: null, updatedAt: Timestamp.fromDate(now) });
    return reason;
  });
}

export type FenceResult = { ok: true } | { ok: false; reason: "lease-lost" | "no-such-cycle" };

/**
 * Reads the cycle and proves `owner` holds an unexpired lease on it, inside the caller's transaction.
 * Expired counts as lost even if nobody has taken over yet: a worker that overran must start again.
 */
function fence(d: Record<string, unknown> | undefined, owner: string, now: Date): d is Record<string, unknown> {
  return d !== undefined && d.state === "running" && d.owner === owner && (ms(d.leaseExpiresAt) ?? 0) > now.getTime();
}

/** Extend the lease, never past the cycle's deadline. */
export async function renewLease(db: Firestore, cfg: CycleConfig, id: string, owner: string, now: Date): Promise<FenceResult & { leaseExpiresAt?: Date }> {
  const ref = cycleRef(db, cfg, id);
  return cycleTransaction(db, cfg, id, async (tx, wrote) => {
    const snap = await tx.get(ref);
    const d = snap.data() as Record<string, unknown> | undefined;
    if (!snap.exists) return { ok: false, reason: "no-such-cycle" } as const;
    if (!fence(d, owner, now)) return { ok: false, reason: "lease-lost" } as const;
    wrote(d.environment);
    const deadlineMs = ms(d.deadlineAt) ?? 0;
    if (now.getTime() >= deadlineMs) {
      tx.update(ref, { state: "failed", outcome: "deadline-passed", path: "failed", owner: null, leaseExpiresAt: null, updatedAt: Timestamp.fromDate(now) });
      return { ok: false, reason: "lease-lost" } as const;
    }
    const expires = leaseEnd(cfg, now, deadlineMs);
    tx.update(ref, { leaseExpiresAt: Timestamp.fromMillis(expires), updatedAt: Timestamp.fromDate(now) });
    return { ok: true, leaseExpiresAt: new Date(expires) } as const;
  });
}

/**
 * Count one model call, or one revision, against the cycle (#182), under the fence: only the lease holder can, and the
 * count is the cycle's, so an attempt resumed after a release or a takeover goes on from it. Counted BEFORE it is spent,
 * so a worker that crashes during the call still has it counted. Returns the cycle's count after this one.
 */
export async function countSpend(
  db: Firestore,
  cfg: CycleConfig,
  id: string,
  owner: string,
  now: Date,
  what: "modelCalls" | "revisions"
): Promise<FenceResult & { count?: number }> {
  const ref = cycleRef(db, cfg, id);
  return cycleTransaction(db, cfg, id, async (tx, wrote) => {
    const snap = await tx.get(ref);
    const d = snap.data() as Record<string, unknown> | undefined;
    if (!snap.exists) return { ok: false, reason: "no-such-cycle" } as const;
    if (!fence(d, owner, now)) return { ok: false, reason: "lease-lost" } as const;
    wrote(d.environment);
    const next = count(d[what]) + 1;
    tx.update(ref, { [what]: next, updatedAt: Timestamp.fromDate(now) });
    return { ok: true, count: next } as const;
  });
}

export interface RunEvent {
  /** Which stage of the loop: "triage", "fix", "verify", "review", "pr"... */
  stage: string;
  /** What happened: "decision", "proposed", "rejected"... */
  type: string;
  /** One line a person can read. */
  summary: string;
  /** Small structured detail (rule, counts, hashes). Sensitive-looking keys are dropped. */
  data?: Record<string, string | number | boolean | null>;
  /**
   * This stage's part of the cycle's run record: stored on the cycle document at `summary.<stage>`,
   * replacing the stage's earlier entry, in the same fenced transaction as the event. A stage that
   * did not run has no entry: the record never fakes one. Same limits and redaction as `data`.
   */
  record?: Record<string, string | number | boolean | null>;
}

const clip = (text: string, max: number) => clipWellFormed(text, max);

type Flat = Record<string, string | number | boolean | null>;

/** A flat map reduced to what may be stored and shown: redacted, bounded, no nested values. */
function sanitizeFlat(input: Record<string, unknown> | undefined): Flat {
  const out: Flat = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (Object.keys(out).length >= MAX_DATA_KEYS) break;
    if (!DATA_KEY_RE.test(k) || isSensitiveKey(k)) continue;
    if (typeof v === "string") out[k] = clip(v, LONG_VALUE_KEYS[k] ?? MAX_VALUE);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean" || v === null) out[k] = v;
  }
  return out;
}

/** An event reduced to what may be stored and shown: redacted, bounded, no nested values. */
export function sanitizeEvent(event: RunEvent): { stage: string; type: string; summary: string; data: Flat; record?: Flat } {
  return {
    stage: clip(event.stage, 40),
    type: clip(event.type, 40),
    summary: clip(event.summary, MAX_SUMMARY),
    data: sanitizeFlat(event.data),
    ...(event.record && { record: sanitizeFlat(event.record) }),
  };
}

/** Append an event. Only the current lease holder can; the sequence stays contiguous. */
export async function recordEvent(
  db: Firestore,
  cfg: CycleConfig,
  id: string,
  owner: string,
  now: Date,
  event: RunEvent
): Promise<FenceResult & { seq?: number }> {
  const ref = cycleRef(db, cfg, id);
  const clean = sanitizeEvent(event);
  return cycleTransaction(db, cfg, id, async (tx, wrote) => {
    const snap = await tx.get(ref);
    const d = snap.data() as Record<string, unknown> | undefined;
    if (!snap.exists) return { ok: false, reason: "no-such-cycle" } as const;
    if (!fence(d, owner, now)) return { ok: false, reason: "lease-lost" } as const;
    wrote(d.environment);
    const seq = Number(d.eventCount ?? 0) + 1;
    const { record, ...eventFields } = clean;
    const eventId = String(seq).padStart(6, "0");
    const eventDoc = { seq, environment: d.environment, at: Timestamp.fromDate(now), ...eventFields };
    tx.create(ref.collection("events").doc(eventId), eventDoc);
    // Its guest copy in the same transaction: an event of a public environment never exists without one (#18).
    writePublicEventInTx(tx, db, cfg, id, eventId, eventDoc);
    tx.update(ref, {
      eventCount: seq,
      stage: clean.stage,
      updatedAt: Timestamp.fromDate(now),
      // The stage's part of the run record. A dotted path replaces only this stage's entry.
      ...(record && STAGE_RE.test(clean.stage) && { [`summary.${clean.stage}`]: record }),
    });
    return { ok: true, seq } as const;
  });
}

/**
 * Append events to a cycle NO worker holds, inside the caller's transaction (#37: the phone escalation of a cycle that
 * is waiting for a person). `d` is the cycle as read in that same transaction, so the sequence stays contiguous against
 * every other writer, which all go through transactions on `eventCount`. Refused (false, nothing written) for a missing
 * or running cycle: a running cycle's events belong to its lease holder. Same redaction and bounds as `recordEvent`;
 * the last event's `record` becomes `summary.<stage>`. Writes only, so the caller must have done all its reads.
 */
export function appendEventsInTransaction(
  tx: Transaction,
  ref: DocumentReference,
  d: Record<string, unknown> | undefined,
  now: Date,
  events: readonly RunEvent[],
  pub: PublicViewConfig
): boolean {
  if (d === undefined || d.state === "running" || events.length === 0) return false;
  let seq = Number(d.eventCount ?? 0);
  let lastStage = "";
  let lastRecord: Flat | undefined;
  for (const event of events) {
    const { record, ...eventFields } = sanitizeEvent(event);
    seq += 1;
    const eventId = String(seq).padStart(6, "0");
    const eventDoc = { seq, environment: d.environment, at: Timestamp.fromDate(now), ...eventFields };
    tx.create(ref.collection("events").doc(eventId), eventDoc);
    // Its guest copy in the same transaction (#18). The cycle's own copy is the caller's to refresh after the commit.
    writePublicEventInTx(tx, ref.firestore, pub, ref.id, eventId, eventDoc);
    lastStage = eventFields.stage;
    lastRecord = record;
  }
  tx.update(ref, {
    eventCount: seq,
    stage: lastStage,
    updatedAt: Timestamp.fromDate(now),
    ...(lastRecord && STAGE_RE.test(lastStage) && { [`summary.${lastStage}`]: lastRecord }),
  });
  return true;
}

/**
 * Give the lease up without ending the cycle, so another worker can try again (a missing counter-check,
 * a model that failed). The start already counted stays counted, so retrying is bounded by
 * `maxCycleAttempts` like any other resume. With `uncounted` (the kill switch stopped the cycle, #133) the next
 * start is not counted: the cycle did not fail, it was paused. The deadline still bounds it.
 */
export async function releaseLease(
  db: Firestore,
  cfg: CycleConfig,
  id: string,
  owner: string,
  now: Date,
  reason: string,
  opts: { uncounted?: boolean } = {}
): Promise<FenceResult> {
  const ref = cycleRef(db, cfg, id);
  return cycleTransaction(db, cfg, id, async (tx, wrote) => {
    const snap = await tx.get(ref);
    const d = snap.data() as Record<string, unknown> | undefined;
    if (!snap.exists) return { ok: false, reason: "no-such-cycle" } as const;
    if (!fence(d, owner, now)) return { ok: false, reason: "lease-lost" } as const;
    wrote(d.environment);
    tx.update(ref, {
      owner: null,
      leaseExpiresAt: null,
      releasedBecause: clip(reason, MAX_OUTCOME),
      resumeUncounted: opts.uncounted === true,
      updatedAt: Timestamp.fromDate(now),
    });
    return { ok: true } as const;
  });
}

/**
 * Which way a finished cycle went, for whoever reads the record (the scenario runner, Live runs, the
 * scoreboard): declined, a person to be told, a patch drafted but nothing opened (dry run), a pull
 * request opened, handed to a person, or failed; or the missing-index path (#11), which created or found the index and
 * recorded its evidence pull request (or why none). A merge path does not exist (#9).
 */
export type CyclePath = "decline" | "notify" | "draft" | "pr" | "human" | "failed" | "index";

/**
 * What a decline was decided on (#8), kept on the cycle as `decision` so a later pass can tell new evidence from the
 * same logs read again (reconsider.ts): when, the rule, a short redacted reason, the suspected cause, the occurrences
 * and the independent recount it saw (with that recount's window), and the incident's structural cause class
 * (`causeClass`; not named `...Key`, because the redactor drops a key that ends in "key"). Redacted and bounded like
 * the run record.
 */
export type DeclineDecision = Record<string, string | number | boolean | null>;

/** End the owner's hold on the cycle: it is finished, or resting until a person acts. */
export async function finishCycle(
  db: Firestore,
  cfg: CycleConfig,
  id: string,
  owner: string,
  now: Date,
  state: Exclude<CycleState, "running">,
  outcome: string,
  path?: CyclePath,
  decision?: DeclineDecision
): Promise<FenceResult> {
  const ref = cycleRef(db, cfg, id);
  return cycleTransaction(db, cfg, id, async (tx, wrote) => {
    const snap = await tx.get(ref);
    const d = snap.data() as Record<string, unknown> | undefined;
    if (!snap.exists) return { ok: false, reason: "no-such-cycle" } as const;
    if (!fence(d, owner, now)) return { ok: false, reason: "lease-lost" } as const;
    wrote(d.environment);
    tx.update(ref, {
      state,
      outcome: clip(outcome, MAX_OUTCOME),
      ...(path && { path }),
      ...(decision && { decision: { ...sanitizeFlat(decision), at: Timestamp.fromDate(now) } }),
      owner: null,
      leaseExpiresAt: null,
      updatedAt: Timestamp.fromDate(now),
    });
    return { ok: true } as const;
  });
}

/**
 * What the pull request a finished cycle opened looks like on GitHub now (#17, src/agent/reconcile.ts). Flat, so it is
 * stored as the run record's `summary.prState` beside the stages. `checkedAt` is when GitHub was read, and orders
 * observations: the newest one read wins, whatever order the writes land in.
 */
export interface PrStateRecord {
  number: number;
  state: "open" | "closed" | "merged";
  mergedAt: string | null;
  closedAt: string | null;
  headSha: string;
  /** The named required checks on `headSha`: all passed, one failed, some still running or not reported, or none named. */
  checks: "passed" | "failed" | "pending" | "missing" | "not-configured";
  checksPassed: number;
  checksRequired: number;
  /** The names of the checks that failed, comma-separated, when any did. */
  failedChecks?: string;
  checkedAt: string;
}

export type PrStateWrite =
  | { ok: true; applied: true }
  | { ok: true; applied: false; reason: "stale" | "merged-is-final" }
  | { ok: false; reason: "no-such-cycle" | "not-a-pr-cycle" | "invalid" };

const PR_STATES: readonly string[] = ["open", "closed", "merged"];
const CHECK_STATES: readonly string[] = ["passed", "failed", "pending", "missing", "not-configured"];
const isoMs = (v: unknown): number | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

/**
 * Record a pull request's later state on its finished cycle. The cycle's own state, path, outcome and `updatedAt` are
 * never changed (it is done: what happens to the PR afterwards is a fact about the PR, not a new outcome of the cycle),
 * and the incident is never touched: a merged PR is not proof that the incident is healed.
 *
 * A finished cycle has no lease, so this is not fenced by one; it is safe without it because it writes only
 * `summary.prState`, in a transaction, and only to a cycle that is `done` and recorded opening THIS pull request.
 * Two readers racing, or a slow one landing late, cannot move it backwards:
 *   - an observation read no later than the one recorded is ignored (`stale`; a duplicate is one of these);
 *   - a merge is final: nothing read afterwards makes a merged PR open or closed again (`merged-is-final`).
 */
export async function recordPrState(db: Firestore, cfg: CycleConfig, id: string, observed: PrStateRecord): Promise<PrStateWrite> {
  if (
    !ID_RE.test(id) ||
    !Number.isInteger(observed.number) ||
    observed.number < 1 ||
    !PR_STATES.includes(observed.state) ||
    !CHECK_STATES.includes(observed.checks) ||
    !/^[0-9a-f]{40}$/.test(observed.headSha) ||
    isoMs(observed.checkedAt) === null
  ) {
    return { ok: false, reason: "invalid" };
  }
  const record = sanitizeFlat({ ...observed });
  const ref = cycleRef(db, cfg, id);
  return cycleTransaction(db, cfg, id, async (tx, wrote): Promise<PrStateWrite> => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: "no-such-cycle" };
    const d = snap.data() as Record<string, unknown>;
    const summary = (d.summary ?? {}) as { pr?: { opened?: unknown; number?: unknown }; prState?: { state?: unknown; checkedAt?: unknown } };
    if (d.state !== "done" || summary.pr?.opened !== true || summary.pr.number !== observed.number) return { ok: false, reason: "not-a-pr-cycle" };
    const prior = summary.prState;
    const priorAt = isoMs(prior?.checkedAt);
    if (priorAt !== null && isoMs(observed.checkedAt)! <= priorAt) return { ok: true, applied: false, reason: "stale" };
    if (prior?.state === "merged" && observed.state !== "merged") return { ok: true, applied: false, reason: "merged-is-final" };
    wrote(d.environment);
    tx.update(ref, { "summary.prState": record });
    return { ok: true, applied: true };
  });
}
