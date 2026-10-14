import { useEffect, useState } from "react";
import type { Unsubscribe } from "firebase/firestore";

/** A live record: pending until the first snapshot, then its latest value, or an error once the listener fails. */
export type LiveRecord<T> = { status: "pending" } | { status: "error" } | { status: "ok"; data: T };

/**
 * Subscribes while mounted (and again when `key` changes) and hands back the latest value. A listener that fails is
 * over (Firestore does not resume it), so the error stands; a value it delivered before is not shown in its place.
 */
export function useLiveRecord<T>(
  key: string,
  subscribe: (onData: (value: T) => void, onError: (err: Error) => void) => Unsubscribe
): LiveRecord<T> {
  const [record, setRecord] = useState<LiveRecord<T>>({ status: "pending" });
  useEffect(() => {
    setRecord({ status: "pending" });
    return subscribe(
      (data) => setRecord({ status: "ok", data }),
      () => setRecord({ status: "error" })
    );
    // `subscribe` is a fresh closure each render; `key` names what it listens to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return record;
}
