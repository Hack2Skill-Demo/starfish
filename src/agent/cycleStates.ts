/**
 * The cycle's states and rounds, pure and with no imports (#413, #436), so cycle.ts, reconsider.ts, pass.ts and the
 * escalation read one definition. cycle.ts re-exports all of it.
 */

/** A Firestore Timestamp's milliseconds, or undefined for anything else. */
const millis = (value: unknown): number | undefined => {
  const v = value as { toMillis?: unknown } | null | undefined;
  return typeof v?.toMillis === "function" ? (v.toMillis() as number) : undefined;
};

/**
 * The cycle's states, in one table (#413). `running`: a worker holds it or will resume it. The rest are SETTLED: no worker
 * is on it. `done` ended with nothing left to do (a pull request opened, or nothing to open); `declined` triage declined
 * it, or the incident was closed or gone before it acted; `waiting-human` a person was told; `failed` it was given up on.
 */
export const CYCLE_STATES = ["running", "waiting-human", "done", "declined", "failed"] as const;
export type CycleState = (typeof CYCLE_STATES)[number];
export const SETTLED_STATES: readonly CycleState[] = ["done", "declined", "waiting-human", "failed"];
/**
 * The settled states a later consideration may REOPEN (reconsider.ts decides when): never `done`, whose pull request is
 * the recurrence's one. The one list: the lease (acquireLease), the pass's candidate scan and reconsider.ts read it.
 */
export const REOPENABLE_STATES = ["declined", "waiting-human", "failed"] as const;
export type ReopenableState = (typeof REOPENABLE_STATES)[number];
export const isReopenable = (state: unknown): state is ReopenableState => (REOPENABLE_STATES as readonly unknown[]).includes(state);

/**
 * The round a cycle is in: 1, and one more for each reopening (`reconsiderCount`). The one definition (#436): Slack's
 * "(round N)" (loop.ts), the `round` on every event, and through it the Runs page, read this.
 */
export function roundOf(cycle: Record<string, unknown> | undefined): number {
  const n = Number(cycle?.reconsiderCount ?? 0);
  return Number.isSafeInteger(n) && n > 0 ? n + 1 : 1;
}

/** When the cycle's current round began, if it was ever reopened: its latest reopening (`reconsideredAt`). */
export function currentRoundStartMs(cycle: Record<string, unknown> | undefined): number | undefined {
  const at = Array.isArray(cycle?.reconsideredAt) ? (cycle.reconsideredAt as unknown[]).map(millis).filter((t): t is number => t !== undefined) : [];
  return at.length > 0 ? Math.max(...at) : undefined;
}

/**
 * The run record's entries that belong to ONE ROUND of the cycle, cleared when it is reopened (#413), so a round never
 * shows an earlier round's record as its own. The rest are the recurrence's and stay: `issue`, `pr` once a pull request
 * was opened (keeping them is what stops a second), `index` (its create is recorded before it is made and is never
 * repeated), the records about a merged pull request, and `notify`/`alert`, which carry the round they were sent in
 * (loop.ts sends each once per round). A `pr` record of a round that opened nothing (a dry run) is the round's, and so is
 * `retryRefused` (#456): the retry it said was held back is the one the reopening starts.
 */
export const ROUND_SCOPED_RECORDS = ["triage", "fix", "verify", "review", "before", "escalation", "retryRefused"] as const;
