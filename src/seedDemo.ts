/**
 * A SYNTHETIC evidence history for the public demo (#12): when the watched project has no live incident, a
 * judge still needs to see what each path of the agent loop leaves behind. `pnpm seed-demo` writes a few
 * incidents and the cycles, run events and run records (`summary.<stage>`) the loop would have written for
 * them, in the same shapes (src/agent/cycle.ts, src/agent/loop.ts), so the UI renders them like any other.
 *
 * None of it happened. Honesty is the product's main asset, so it must never pass for a real run:
 *
 *   - every document written carries `synthetic: true`, and the UI shows a "Synthetic" badge on it;
 *   - every incident's message starts with SYNTHETIC_MESSAGE_PREFIX, and every cycle's first event says it;
 *   - no link points anywhere: issue and pull-request numbers are recorded without a URL, and the triage
 *     record names no model, because none was called;
 *   - no incident key is written and the fingerprints are not hashes, so a real occurrence can never be
 *     folded into a synthetic incident (store.ts finds open incidents through the key only);
 *   - guests read it as they read everything: through the trimmed copies (src/publicView.ts, #18), written in the same
 *     batch as each document, so the synthetic history leaves out for them what a real one would;
 *   - every incident has a settled cycle for its recurrence, so the agent's pass never selects one (pass.ts); and every
 *     engine scan skips `synthetic: true` itself (pass.ts, reconcile.ts, autoMerge.ts/fastRevert.ts `cyclesInState`,
 *     the phone escalation's `escalationEligible`), so nothing names a seeded record to GitHub or Twilio (#192).
 *
 * Demo only: it refuses any environment but DEMO_ENVIRONMENT. Ids are fixed, so a re-run replaces what it wrote
 * (with timestamps moved to the new "now") and never duplicates; `removeDemoHistory` deletes exactly those
 * documents. Neither overwrites nor deletes a document at one of those ids that is not marked synthetic.
 */
import { Timestamp } from "firebase-admin/firestore";
import type { DocumentReference, Firestore, WriteBatch } from "firebase-admin/firestore";
import type { StarfishConfig } from "./config.js";
import { cycleId, sanitizeEvent, type CyclePath, type CycleState, type RunEvent } from "./agent/cycle.js";
import { counterCheckRecord } from "./agent/loop.js";
import { publicEventId, toPublicCycle, toPublicIncident, toPublicEvent, type PublicViewConfig } from "./publicView.js";

/** The only environment this writes to: the public demo's label, which firestore.rules lets guests read. */
export const DEMO_ENVIRONMENT = "demo";
/** Every seeded document id starts with this; real incidents have auto ids, and real cycles derive from them. */
export const SYNTHETIC_ID_PREFIX = "synthetic-demo-";
export const SYNTHETIC_MESSAGE_PREFIX = "[Synthetic demo data, not a real incident]";

/** With the public-view settings: each document's guest copy is written in the same batch (src/publicView.ts, #18). */
export type SeedConfig = Pick<StarfishConfig, "environment" | "incidentCollection" | "cycleCollection"> & PublicViewConfig;

type Flat = Record<string, string | number | boolean | null>;

export interface PlannedDoc {
  id: string;
  data: Record<string, unknown>;
}

export interface PlannedCycle extends PlannedDoc {
  events: PlannedDoc[];
}

export interface SeedPlan {
  incidents: PlannedDoc[];
  cycles: PlannedCycle[];
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3600_000;
/** The deadline a real cycle is given (cycleDeadlineMinutes' default); only shown, never enforced here. */
const DEADLINE_MINUTES = 30;
/** A fixed, recognisably fake SHA-256 (all one digit), so no seeded hash can be taken for a real patch's. */
const fakeSha = (digit: string) => digit.repeat(64);

interface StepSpec extends RunEvent {
  /** Minutes after the cycle started. */
  at: number;
}

interface Scenario {
  key: string;
  incident: {
    functionName: string;
    service: string;
    errorType: string;
    message: string;
    errorDetail?: string;
    stackTrace?: string;
    httpStatus?: number;
    status: "new" | "acknowledged" | "logged" | "ignored";
    /** Occurrences per hour, keyed by hours before now. */
    hours: Record<number, number>;
  };
  /** When the cycle started, in hours before now. */
  cycleHoursAgo: number;
  state: Exclude<CycleState, "running">;
  path: CyclePath;
  outcome: string;
  steps: StepSpec[];
}

const NO_MODEL = "none (synthetic: no model was called)";

function counter(count: number, functionName: string, checkedAt: string): Flat {
  return counterCheckRecord({
    window: "24h",
    count,
    capped: false,
    checkedAt,
    filter: `severity>=ERROR AND resource.labels.function_name="${functionName}"`,
  });
}

const started = (at = 0): StepSpec => ({
  stage: "cycle",
  type: "started",
  summary: "Attempt 1. Synthetic demo data: no agent ran this cycle",
  data: { attempt: 1, resumed: false },
  at,
});

/**
 * One scenario per path the loop really has: declined by triage, a person told, a dry-run draft, a pull request
 * after one revision, and a patch the review broke twice. Rules, outcomes and paths are the loop's own values.
 */
function scenarios(nowIso: (hoursAgo: number) => string): Scenario[] {
  return [
    {
      key: "decline",
      incident: {
        functionName: "imageThumbnailer",
        service: "media",
        errorType: "TimeoutError",
        message: "Function execution took 60001 ms, finished with status: 'timeout' (one oversized upload)",
        status: "ignored",
        hours: { 80: 1 },
      },
      cycleHoursAgo: 79.5,
      state: "declined",
      path: "decline",
      outcome: "model-decline",
      steps: [
        started(),
        {
          stage: "triage",
          type: "decision",
          summary: "Declined: one timeout on a single oversized upload in 24 hours; the function's limit is working as intended",
          data: { decision: "decline", rule: "model-decline" },
          record: {
            decision: "decline",
            rule: "model-decline",
            reason: "Declined: one timeout on a single oversized upload in 24 hours; the function's limit is working as intended",
            suspectedCause: null,
            model: NO_MODEL,
            ...counter(1, "imageThumbnailer", nowIso(79.6)),
          },
          at: 0.6,
        },
      ],
    },
    {
      key: "notify",
      incident: {
        functionName: "paymentsWebhook",
        service: "billing",
        errorType: "AuthError",
        httpStatus: 401,
        message: "Payment provider webhook rejected: signature secret no longer matches",
        errorDetail: "the provider rotated its signing secret; the stored one is stale",
        status: "acknowledged",
        hours: { 54: 12, 53: 9, 52: 4 },
      },
      cycleHoursAgo: 52.5,
      state: "waiting-human",
      path: "notify",
      outcome: "notify:model-notify",
      steps: [
        started(),
        {
          stage: "triage",
          type: "decision",
          summary: "Notify: a rotated provider secret is a configuration change a person must make, not a code fix",
          data: { decision: "notify", rule: "model-notify" },
          record: {
            decision: "notify",
            rule: "model-notify",
            reason: "Notify: a rotated provider secret is a configuration change a person must make, not a code fix",
            suspectedCause: "The webhook signing secret in Secret Manager is out of date",
            model: NO_MODEL,
            ...counter(25, "paymentsWebhook", nowIso(52.51)),
          },
          at: 0.7,
        },
        { stage: "issue", type: "opened", summary: "Issue #101 filed (synthetic: no issue exists)", data: { number: 101 }, record: { state: "opened", number: 101 }, at: 1.1 },
        { stage: "notify", type: "pending", summary: "Telling a person", record: { state: "pending", attempts: 0 }, at: 1.2 },
        { stage: "notify", type: "sent", summary: "A person was told (synthetic: nothing was sent)", data: { attempts: 1 }, record: { state: "sent", attempts: 1 }, at: 1.4 },
      ],
    },
    {
      key: "draft",
      incident: {
        functionName: "ordersOnCreate",
        service: "orders",
        errorType: "DatabaseError",
        message: 'Cannot use "undefined" as a Firestore value (found in field "couponCode")',
        stackTrace: "Error: Cannot use \"undefined\" as a Firestore value\n    at buildOrder (src/orders/create.ts:42:9)\n    at onCreate (src/orders/trigger.ts:18:3)",
        status: "acknowledged",
        hours: { 30: 7, 29: 11 },
      },
      cycleHoursAgo: 28.8,
      state: "waiting-human",
      path: "draft",
      outcome: "dry-run",
      steps: [
        started(),
        {
          stage: "triage",
          type: "decision",
          summary: "Act: an optional field is written as undefined when no coupon is applied",
          data: { decision: "act", rule: "model-act" },
          record: {
            decision: "act",
            rule: "model-act",
            reason: "Act: an optional field is written as undefined when no coupon is applied",
            suspectedCause: "buildOrder sets couponCode unconditionally",
            model: NO_MODEL,
            ...counter(18, "ordersOnCreate", nowIso(28.81)),
          },
          at: 0.5,
        },
        { stage: "issue", type: "dry-run", summary: "An issue would be filed here; nothing filed (dry run)", record: { state: "dry-run" }, at: 0.6 },
        {
          stage: "fix",
          type: "proposed",
          summary: "couponCode is spread in only when a coupon is present",
          data: { rule: "fixer-proposed", testAdded: true },
          record: {
            outcome: "proposed",
            rule: "fixer-proposed",
            rootCause: "couponCode is spread in only when a coupon is present",
            testAdded: true,
            risk: "Low: the field is absent instead of undefined; readers already treat it as optional",
            revisions: 0,
            alternative1: "Default couponCode to null: changes what readers see for every order",
            alternative2: "Enable ignoreUndefinedProperties globally: hides the same bug elsewhere",
          },
          at: 2.1,
        },
        {
          stage: "verify",
          type: "passed",
          summary: "The configured command passed on the patched tree",
          data: { rule: "command-passed", patchSha256: fakeSha("a"), files: 2, exitCode: 0 },
          record: { status: "passed", rule: "command-passed", patchSha256: fakeSha("a"), baseRevision: "synthetic", files: 2, exitCode: 0, durationMs: 48_000 },
          at: 3.4,
        },
        {
          stage: "review",
          type: "approve",
          summary: "3 attacks tried",
          data: { rule: "reviewed", attacks: 3, broken: 0 },
          record: {
            verdict: "approve",
            rule: "reviewed",
            attacks: 3,
            held: 3,
            flagged: 0,
            broken: 0,
            patchSha256: fakeSha("a"),
            attack1: "held: an order with a coupon still stores it | the new test covers both branches",
            attack2: "held: an empty-string coupon | it is still written, as before",
            attack3: "held: other undefined fields in buildOrder | none: every other field is required",
          },
          at: 4.2,
        },
        {
          stage: "pr",
          type: "dry-run",
          summary: "Patch verified; nothing opened (dry run)",
          data: { patchSha256: fakeSha("a") },
          record: { opened: false, reason: "dry-run", patchSha256: fakeSha("a") },
          at: 4.3,
        },
      ],
    },
    {
      key: "pr",
      incident: {
        functionName: "inviteAccept",
        service: "api",
        errorType: "TypeError",
        message: "Cannot read properties of null (reading 'teamId')",
        stackTrace: "TypeError: Cannot read properties of null (reading 'teamId')\n    at accept (src/invites/accept.ts:27:31)",
        status: "logged",
        hours: { 8: 3, 7: 6, 6: 2 },
      },
      cycleHoursAgo: 6.5,
      state: "done",
      path: "pr",
      outcome: "pr-opened",
      steps: [
        started(),
        {
          stage: "triage",
          type: "decision",
          summary: "Act: an expired invite is read as if it still existed",
          data: { decision: "act", rule: "model-act" },
          record: {
            decision: "act",
            rule: "model-act",
            reason: "Act: an expired invite is read as if it still existed",
            suspectedCause: "accept() dereferences the invite before checking it was found",
            model: NO_MODEL,
            ...counter(11, "inviteAccept", nowIso(6.51)),
          },
          at: 0.5,
        },
        { stage: "issue", type: "opened", summary: "Issue #102 filed (synthetic: no issue exists)", data: { number: 102 }, record: { state: "opened", number: 102 }, at: 0.9 },
        {
          stage: "fix",
          type: "proposed",
          summary: "accept() returns not-found before reading the invite",
          data: { rule: "fixer-proposed", testAdded: false },
          record: { outcome: "proposed", rule: "fixer-proposed", rootCause: "accept() returns not-found before reading the invite", testAdded: false, risk: "Low", revisions: 0 },
          at: 2.0,
        },
        {
          stage: "verify",
          type: "failed",
          summary: "The configured command failed on the patched tree",
          data: { rule: "command-failed", patchSha256: fakeSha("b"), files: 1, exitCode: 1 },
          record: { status: "failed", rule: "command-failed", patchSha256: fakeSha("b"), baseRevision: "synthetic", files: 1, exitCode: 1, durationMs: 51_000 },
          at: 3.1,
        },
        {
          stage: "fix",
          type: "proposed",
          summary: "accept() returns not-found before reading the invite; the expired-invite test now expects 404",
          data: { rule: "fixer-proposed", testAdded: true },
          record: {
            outcome: "proposed",
            rule: "fixer-proposed",
            rootCause: "accept() returns not-found before reading the invite; the expired-invite test now expects 404",
            testAdded: true,
            risk: "Low: callers already handle not-found",
            revisions: 1,
          },
          at: 4.6,
        },
        {
          stage: "verify",
          type: "passed",
          summary: "The configured command passed on the patched tree",
          data: { rule: "command-passed", patchSha256: fakeSha("c"), files: 2, exitCode: 0 },
          record: { status: "passed", rule: "command-passed", patchSha256: fakeSha("c"), baseRevision: "synthetic", files: 2, exitCode: 0, durationMs: 53_000 },
          at: 5.7,
        },
        {
          stage: "review",
          type: "approve-with-flags",
          summary: "2 attacks tried",
          data: { rule: "reviewed", attacks: 2, broken: 0 },
          record: {
            verdict: "approve-with-flags",
            rule: "reviewed",
            attacks: 2,
            held: 1,
            flagged: 1,
            broken: 0,
            patchSha256: fakeSha("c"),
            attack1: "flagged: a revoked (not expired) invite | also returns 404; a person may prefer 410",
            attack2: "held: a valid invite | still accepted, test unchanged",
          },
          at: 6.5,
        },
        {
          stage: "pr",
          type: "opened",
          summary: "Pull request opened (synthetic: no pull request exists)",
          data: { number: 103, patchSha256: fakeSha("c") },
          record: { opened: true, number: 103, patchSha256: fakeSha("c") },
          at: 7.0,
        },
      ],
    },
    {
      key: "human",
      incident: {
        functionName: "reportsNightly",
        service: "reports",
        errorType: "RangeError",
        message: "Invalid time value while formatting the report period",
        stackTrace: "RangeError: Invalid time value\n    at formatPeriod (src/reports/period.ts:14:20)",
        status: "new",
        hours: { 3: 1, 2: 1 },
      },
      cycleHoursAgo: 1.8,
      state: "waiting-human",
      path: "human",
      outcome: "review-blocked",
      steps: [
        started(),
        {
          stage: "triage",
          type: "decision",
          summary: "Act: the nightly report crashes on a period with no end date",
          data: { decision: "act", rule: "model-act" },
          record: {
            decision: "act",
            rule: "model-act",
            reason: "Act: the nightly report crashes on a period with no end date",
            suspectedCause: "formatPeriod assumes both dates are set",
            model: NO_MODEL,
            ...counter(2, "reportsNightly", nowIso(1.81)),
          },
          at: 0.4,
        },
        { stage: "issue", type: "opened", summary: "Issue #104 filed (synthetic: no issue exists)", data: { number: 104 }, record: { state: "opened", number: 104 }, at: 0.8 },
        {
          stage: "fix",
          type: "proposed",
          summary: "formatPeriod prints an open period as 'ongoing'",
          data: { rule: "fixer-proposed", testAdded: true },
          record: { outcome: "proposed", rule: "fixer-proposed", rootCause: "formatPeriod prints an open period as 'ongoing'", testAdded: true, risk: "Medium", revisions: 0 },
          at: 1.9,
        },
        {
          stage: "verify",
          type: "passed",
          summary: "The configured command passed on the patched tree",
          data: { rule: "command-passed", patchSha256: fakeSha("d"), files: 2, exitCode: 0 },
          record: { status: "passed", rule: "command-passed", patchSha256: fakeSha("d"), baseRevision: "synthetic", files: 2, exitCode: 0, durationMs: 47_000 },
          at: 2.9,
        },
        {
          stage: "review",
          type: "block",
          summary: "2 attacks tried",
          data: { rule: "reviewed", attacks: 2, broken: 1 },
          record: { verdict: "block", rule: "reviewed", attacks: 2, held: 1, flagged: 0, broken: 1, patchSha256: fakeSha("d"), attack1: "broken: a period with no START date | still throws", attack2: "held: a closed period | unchanged" },
          at: 3.6,
        },
        {
          stage: "fix",
          type: "proposed",
          summary: "formatPeriod handles a missing start or end date",
          data: { rule: "fixer-proposed", testAdded: true },
          record: { outcome: "proposed", rule: "fixer-proposed", rootCause: "formatPeriod handles a missing start or end date", testAdded: true, risk: "Medium", revisions: 1 },
          at: 4.8,
        },
        {
          stage: "verify",
          type: "passed",
          summary: "The configured command passed on the patched tree",
          data: { rule: "command-passed", patchSha256: fakeSha("e"), files: 2, exitCode: 0 },
          record: { status: "passed", rule: "command-passed", patchSha256: fakeSha("e"), baseRevision: "synthetic", files: 2, exitCode: 0, durationMs: 49_000 },
          at: 5.9,
        },
        {
          stage: "review",
          type: "block",
          summary: "2 attacks tried",
          data: { rule: "reviewed", attacks: 2, broken: 1 },
          record: {
            verdict: "block",
            rule: "reviewed",
            attacks: 2,
            held: 1,
            flagged: 0,
            broken: 1,
            patchSha256: fakeSha("e"),
            attack1: "broken: the period's dates are strings in older reports | Invalid time value again",
            attack2: "held: a period with no start date | prints 'ongoing'",
          },
          at: 6.7,
        },
        { stage: "notify", type: "pending", summary: "Telling a person", record: { state: "pending", attempts: 0 }, at: 6.8 },
        { stage: "notify", type: "sent", summary: "A person was told (synthetic: nothing was sent)", data: { attempts: 1 }, record: { state: "sent", attempts: 1 }, at: 7.0 },
      ],
    },
  ];
}

/** Epoch-hour buckets, the shape store.ts keeps (`occurrencesByHour`). */
function buckets(nowMs: number, hours: Record<number, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ago, n] of Object.entries(hours)) {
    const key = String(Math.floor((nowMs - Number(ago) * MS_PER_HOUR) / MS_PER_HOUR));
    out[key] = (out[key] ?? 0) + n;
  }
  return out;
}

/**
 * The documents to write, relative to `now`. Pure: it reads and writes nothing. Events go through cycle.ts's own
 * `sanitizeEvent`, and each stage's last record becomes `summary.<stage>`, exactly as `recordEvent` would leave them.
 */
export function buildDemoPlan(now: Date, environment: string = DEMO_ENVIRONMENT): SeedPlan {
  const nowMs = now.getTime();
  const ts = (hoursAgo: number) => Timestamp.fromMillis(nowMs - hoursAgo * MS_PER_HOUR);
  const nowIso = (hoursAgo: number) => new Date(nowMs - hoursAgo * MS_PER_HOUR).toISOString();
  const plan: SeedPlan = { incidents: [], cycles: [] };

  for (const s of scenarios(nowIso)) {
    const incidentId = `${SYNTHETIC_ID_PREFIX}${s.key}`;
    const agos = Object.keys(s.incident.hours).map(Number);
    const first = ts(Math.max(...agos));
    const last = ts(Math.min(...agos));
    const { hours, message, ...fields } = s.incident;
    plan.incidents.push({
      id: incidentId,
      data: {
        ...fields,
        environment,
        errorMessage: `${SYNTHETIC_MESSAGE_PREFIX} ${message}`,
        occurrenceCount: Object.values(hours).reduce((a, b) => a + b, 0),
        occurrencesByHour: buckets(nowMs, hours),
        firstOccurredAt: first,
        lastOccurredAt: last,
        // Not a sha256: it can never equal a real fingerprint, and no incident key names it.
        fingerprint: `synthetic-${s.key}`,
        triageState: "pending",
        createdAt: first,
        updatedAt: last,
        synthetic: true,
      },
    });

    const id = cycleId({ incidentId, environment, recurrence: 0 });
    if (id === null) throw new Error(`seedDemo: ${incidentId} cannot name a cycle`);
    const start = nowMs - s.cycleHoursAgo * MS_PER_HOUR;
    const at = (min: number) => Timestamp.fromMillis(start + min * MS_PER_MINUTE);
    const summary: Record<string, Flat> = {};
    const events: PlannedDoc[] = s.steps.map((step, i) => {
      const { record, ...event } = sanitizeEvent(step);
      if (record) summary[event.stage] = record;
      const seq = i + 1;
      return { id: String(seq).padStart(6, "0"), data: { seq, environment, at: at(step.at), ...event, synthetic: true } };
    });
    const lastStep = s.steps[s.steps.length - 1]!;
    plan.cycles.push({
      id,
      data: {
        incidentId,
        environment,
        recurrence: 0,
        state: s.state,
        attempts: 1,
        owner: null,
        leaseExpiresAt: null,
        deadlineAt: at(DEADLINE_MINUTES),
        eventCount: events.length,
        stage: lastStep.stage,
        outcome: s.outcome,
        path: s.path,
        summary,
        createdAt: at(0),
        updatedAt: at(lastStep.at),
        synthetic: true,
      },
      events,
    });
  }
  return plan;
}

export type SeedRefusal = { ok: false; reason: "not-demo-environment" | "id-taken"; detail: string };
export type SeedResult = { ok: true; incidents: number; cycles: number; events: number; staleEventsRemoved: number } | SeedRefusal;
export type RemoveResult = { ok: true; incidents: number; cycles: number; events: number } | SeedRefusal;

function refuseUnlessDemo(cfg: SeedConfig): SeedRefusal | null {
  if (cfg.environment === DEMO_ENVIRONMENT) return null;
  return { ok: false, reason: "not-demo-environment", detail: `environment is "${cfg.environment}"; the synthetic history is written only to "${DEMO_ENVIRONMENT}"` };
}

/** Firestore caps a batch at 500 writes. */
const WRITES_PER_BATCH = 400;

/** The writes for one document: the document and its guest copy, which must land in the same batch. */
type OpGroup = ((b: WriteBatch) => void)[];

/** Commit the groups in batches of at most WRITES_PER_BATCH writes, never splitting a group across two. */
async function commitInChunks(db: Firestore, groups: OpGroup[]): Promise<void> {
  let batch = db.batch();
  let size = 0;
  for (const group of groups) {
    if (size > 0 && size + group.length > WRITES_PER_BATCH) {
      await batch.commit();
      batch = db.batch();
      size = 0;
    }
    for (const op of group) op(batch);
    size += group.length;
  }
  if (size > 0) await batch.commit();
}

/** Set `data` at `ref` and, beside it, its guest copy (or remove a copy that must not exist). */
function withCopy(ref: DocumentReference, data: Record<string, unknown>, copyRef: DocumentReference, copy: Record<string, unknown> | null): OpGroup {
  return [(b) => b.set(ref, data), copy ? (b) => b.set(copyRef, copy) : (b) => b.delete(copyRef)];
}

function refs(db: Firestore, cfg: SeedConfig, plan: SeedPlan): DocumentReference[] {
  return [
    ...plan.incidents.map((d) => db.collection(cfg.incidentCollection).doc(d.id)),
    ...plan.cycles.map((c) => db.collection(cfg.cycleCollection).doc(c.id)),
  ];
}

/** Ids in the plan already held by a document this did not write (no `synthetic: true`, or another environment). */
async function takenIds(db: Firestore, cfg: SeedConfig, plan: SeedPlan): Promise<string[]> {
  const snaps = await db.getAll(...refs(db, cfg, plan));
  return snaps.filter((s) => s.exists && !(s.data()?.synthetic === true && s.data()?.environment === cfg.environment)).map((s) => s.ref.path);
}

/**
 * Write the plan. A re-run replaces every document at the same ids (and removes events a previous plan had beyond
 * this one's), so it never duplicates. Refuses, writing nothing, outside the demo environment or when one of the
 * ids is held by a document that is not synthetic.
 */
export async function applyDemoHistory(db: Firestore, cfg: SeedConfig, plan: SeedPlan): Promise<SeedResult> {
  const refused = refuseUnlessDemo(cfg);
  if (refused) return refused;
  const taken = await takenIds(db, cfg, plan);
  if (taken.length > 0) return { ok: false, reason: "id-taken", detail: `not synthetic, left alone: ${taken.join(", ")}` };

  const ops: OpGroup[] = [];
  let staleEventsRemoved = 0;
  for (const inc of plan.incidents) {
    const ref = db.collection(cfg.incidentCollection).doc(inc.id);
    ops.push(withCopy(ref, inc.data, db.collection(cfg.publicIncidentCollection).doc(inc.id), toPublicIncident(inc.data, cfg)));
  }
  for (const c of plan.cycles) {
    const ref = db.collection(cfg.cycleCollection).doc(c.id);
    const wanted = new Set(c.events.map((e) => e.id));
    for (const old of await ref.collection("events").listDocuments()) {
      if (wanted.has(old.id)) continue;
      staleEventsRemoved += 1;
      ops.push([(b) => b.delete(old), (b) => b.delete(db.collection(cfg.publicEventCollection).doc(publicEventId(c.id, old.id)))]);
    }
    ops.push(withCopy(ref, c.data, db.collection(cfg.publicCycleCollection).doc(c.id), toPublicCycle(c.data, cfg)));
    for (const e of c.events) {
      const copyRef = db.collection(cfg.publicEventCollection).doc(publicEventId(c.id, e.id));
      ops.push(withCopy(ref.collection("events").doc(e.id), e.data, copyRef, toPublicEvent(c.id, e.data, cfg)));
    }
  }
  await commitInChunks(db, ops);
  return {
    ok: true,
    incidents: plan.incidents.length,
    cycles: plan.cycles.length,
    events: plan.cycles.reduce((n, c) => n + c.events.length, 0),
    staleEventsRemoved,
  };
}

/**
 * Delete what `applyDemoHistory` wrote: the plan's ids, and the events under its cycles, when (and only when) the
 * document there is marked synthetic in this environment. Anything else at those ids is left alone and counted out.
 */
export async function removeDemoHistory(db: Firestore, cfg: SeedConfig, plan: SeedPlan): Promise<RemoveResult> {
  const refused = refuseUnlessDemo(cfg);
  if (refused) return refused;
  const snaps = await db.getAll(...refs(db, cfg, plan));
  const ops: OpGroup[] = [];
  let incidents = 0;
  let cycles = 0;
  let events = 0;
  for (const snap of snaps) {
    const d = snap.data();
    if (!snap.exists || d?.synthetic !== true || d.environment !== cfg.environment) continue;
    const isCycle = snap.ref.parent.id === cfg.cycleCollection;
    if (isCycle) {
      cycles += 1;
      for (const e of await snap.ref.collection("events").listDocuments()) {
        events += 1;
        ops.push([(b) => b.delete(e), (b) => b.delete(db.collection(cfg.publicEventCollection).doc(publicEventId(snap.id, e.id)))]);
      }
    }
    if (!isCycle) incidents += 1;
    // The document and its guest copy go together.
    const copyRef = db.collection(isCycle ? cfg.publicCycleCollection : cfg.publicIncidentCollection).doc(snap.id);
    ops.push([(b) => b.delete(snap.ref), (b) => b.delete(copyRef)]);
  }
  await commitInChunks(db, ops);
  return { ok: true, incidents, cycles, events };
}

/** One line per document, for the dry run. */
export function describePlan(plan: SeedPlan, cfg: Pick<SeedConfig, "incidentCollection" | "cycleCollection">): string[] {
  const lines: string[] = [];
  for (const inc of plan.incidents) lines.push(`${cfg.incidentCollection}/${inc.id}  ${String(inc.data.status)}  ${String(inc.data.functionName)}`);
  for (const c of plan.cycles) {
    const d = c.data;
    lines.push(`${cfg.cycleCollection}/${c.id}  ${String(d.state)}  path=${String(d.path)}  outcome=${String(d.outcome)}  ${c.events.length} events`);
  }
  return lines;
}
