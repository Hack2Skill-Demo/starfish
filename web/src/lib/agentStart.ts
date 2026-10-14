/**
 * "Run agent now" was accepted (#276): when, in this tab only. The admin API answers once the job's start is accepted,
 * and the pass records its start only once its job is up, a little later; between the two the agent's status says a
 * start was requested, and its live listener shows the pass as it starts with no page refresh.
 * Never stored: a reload forgets it, and the record alone says what the agent did.
 */
import { useSyncExternalStore } from "react";

let requestedAt: number | null = null;
const listeners = new Set<() => void>();

export function markAgentStartRequested(atMs: number = Date.now()): void {
  requestedAt = atMs;
  for (const l of listeners) l();
}

/** For tests: forget the request. */
export function resetAgentStartRequested(): void {
  requestedAt = null;
  for (const l of listeners) l();
}

/** When this tab last had a start accepted, or null. */
export function useAgentStartRequestedAt(): number | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => requestedAt
  );
}
