import { useEffect, useState } from "react";
import type { Unsubscribe } from "firebase/firestore";

/** A live record: pending until the first snapshot, then its latest value, or an error once the listener fails. */
export type LiveRecord<T> = { status: "pending" } | { status: "error" } | { status: "ok"; data: T };

/** How long after a failed listener it listens again: Firestore ends a listener that fails, where a poll would read again. */
export const LIVE_RETRY_MS = 60_000;

/**
 * Subscribes while mounted (and again when `key` changes) and hands back the latest value. A listener that fails shows
 * the error, never a value it delivered before (#195), and is started again after LIVE_RETRY_MS.
 */
export function useLiveRecord<T>(
  key: string,
  subscribe: (onData: (value: T) => void, onError: (err: Error) => void) => Unsubscribe
): LiveRecord<T> {
  const [record, setRecord] = useState<LiveRecord<T>>({ status: "pending" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(
      (data) => setRecord({ status: "ok", data }),
      () => {
        setRecord({ status: "error" });
        retry = setTimeout(() => setAttempt((n) => n + 1), LIVE_RETRY_MS);
      }
    );
    return () => {
      clearTimeout(retry);
      unsubscribe();
    };
    // `subscribe` is a fresh closure each render; `key` names what it listens to, `attempt` starts it again after a failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return record;
}
