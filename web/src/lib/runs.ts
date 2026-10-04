/**
 * Live subscriptions to the agent's cycles and their run events (written by src/agent/cycle.ts).
 *
 * `firestore.rules` lets operators, and guests on the demo environment, read both; nobody in the
 * browser writes. Both queries filter on `environment`, which the rules need before they will serve a
 * guest a list. The cycle list is newest-update first and needs the composite index in
 * firestore.indexes.json; a cycle's events are few, so they are read in full and put in order here.
 */
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query, where, type Unsubscribe } from "firebase/firestore";
import { firestore } from "./firebase";
import { webConfig } from "./config";
import { parseCycle, parseEvent, type CycleRow, type EventRow } from "./runsModel";

/** Cycles read for the list. The page says so when it hits this. */
export const CYCLE_LIMIT = 50;
/** Events read for one cycle: a cycle is a handful of stages, so this is a ceiling, not a window. */
export const EVENT_LIMIT = 200;

export function subscribeCycles(
  environment: string,
  onData: (rows: CycleRow[], capped: boolean) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(firestore(), webConfig().cycleCollection),
    where("environment", "==", environment),
    orderBy("updatedAt", "desc"),
    limit(CYCLE_LIMIT)
  );
  return onSnapshot(
    q,
    (snap) => {
      // A document that doesn't parse is left out rather than shown half-understood.
      const rows = snap.docs.flatMap((d) => parseCycle(d.id, d.data()) ?? []);
      onData(rows, snap.size >= CYCLE_LIMIT);
    },
    onError
  );
}

export function subscribeEvents(
  cycleId: string,
  environment: string,
  onData: (rows: EventRow[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(firestore(), webConfig().cycleCollection, cycleId, "events"),
    where("environment", "==", environment),
    limit(EVENT_LIMIT)
  );
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.flatMap((d) => parseEvent(d.id, d.data()) ?? []).sort((a, b) => a.seq - b.seq)),
    onError
  );
}

/**
 * One cycle by id, or null when there is none for this environment. The incident page reads its
 * current recurrence's cycle by id (`{incidentId}_r{n}`), which needs no index.
 */
export async function readCycle(id: string, environment: string): Promise<CycleRow | null> {
  const snap = await getDoc(doc(firestore(), webConfig().cycleCollection, id));
  if (!snap.exists()) return null;
  const row = parseCycle(snap.id, snap.data());
  return row && row.environment === environment ? row : null;
}
