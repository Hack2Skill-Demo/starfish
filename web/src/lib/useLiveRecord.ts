import { useEffect, useRef, useState } from "react";
import type { Unsubscribe } from "firebase/firestore";

/** A live record: pending until the first snapshot, then its latest value, or an error once the listener fails. */
export type LiveRecord<T> = { status: "pending" } | { status: "error" } | { status: "ok"; data: T };

/** How long after a failed listener it listens again: Firestore ends a listener that fails, where a poll would read again. */
export const LIVE_RETRY_MS = 60_000;

/**
 * Keeps a Firestore listener started while `key` is not null, and starts it again LIVE_RETRY_MS after it fails (#357):
 * Firestore ends a snapshot listener once it errors, so without this a page that lost one never updates again.
 *
 * `start(onError, retrying)` subscribes and returns its unsubscribe; its own error callback records the failure (what the
 * page shows until a new snapshot arrives, never the rows it had, #195) and then calls `onError`. `retrying` is true when
 * the start is a retry for the same `key`, so the caller keeps its failed state rather than resetting to "loading". A new
 * `key` (another environment, run or page size) starts afresh. `key` names everything `start` listens to: `start` is a
 * fresh closure each render and is not a dependency.
 */
export function useRetryingSubscription(key: string | null, start: (onError: () => void, retrying: boolean) => Unsubscribe): void {
  const [attempt, setAttempt] = useState(0);
  // The key the last start was for: the same key again means the effect re-ran for `attempt`, i.e. a retry.
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (key === null) {
      startedFor.current = null;
      return;
    }
    const retrying = startedFor.current === key;
    startedFor.current = key;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const unsubscribe = start(() => {
      if (stopped) return;
      clearTimeout(retry);
      retry = setTimeout(() => setAttempt((n) => n + 1), LIVE_RETRY_MS);
    }, retrying);
    return () => {
      stopped = true;
      clearTimeout(retry);
      unsubscribe();
    };
    // `start` is a fresh closure each render; `key` names what it listens to, `attempt` starts it again after a failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
}

/**
 * Subscribes while mounted (and again when `key` changes) and hands back the latest value. A listener that fails shows
 * the error, never a value it delivered before (#195), and is started again after LIVE_RETRY_MS.
 */
export function useLiveRecord<T>(
  key: string,
  subscribe: (onData: (value: T) => void, onError: (err: Error) => void) => Unsubscribe
): LiveRecord<T> {
  const [record, setRecord] = useState<LiveRecord<T>>({ status: "pending" });
  useRetryingSubscription(key, (onError) =>
    subscribe(
      (data) => setRecord({ status: "ok", data }),
      () => {
        setRecord({ status: "error" });
        onError();
      }
    )
  );
  return record;
}
