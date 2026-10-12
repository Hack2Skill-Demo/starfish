/**
 * Live subscriptions to the agent's cycles and their run events (written by src/agent/cycle.ts).
 *
 * `firestore.rules` lets operators, and guests on the demo environment, read both; nobody in the
 * browser writes. Both queries filter on `environment`, which the rules need before they will serve a
 * guest a list. The cycle list is newest-update first and needs the composite index in
 * firestore.indexes.json; a cycle's events are read newest first, up to EVENT_LIMIT, and put in order here.
 * The Overview's feed reads the newest events across cycles with a collection-group query.
 *
 * A guest reads the trimmed copies instead (`dataSource`, #18): the cycles' copies with the same queries, and the run
 * events' copies from one flat collection, by `cycleId` for a run and newest first for both. The copies keep the
 * stored field names, so the same parsers read them.
 */
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { firestore } from "./firebase";
import { webConfig } from "./config";
import { dataSource } from "./dataSource";
import { parseCycle, parseEvent, type CycleRow, type EventRow } from "./runsModel";
import { latestActivity, parseActivity, parsePublicActivity, type ActivityRow } from "./overviewModel";

/** Cycles read for the list at first, and how many more each "Show older runs" adds. The page says so when it hits this. */
export const CYCLE_LIMIT = 50;
/** The most the list ever reads: "Show older runs" grows the read, so it has a ceiling too. firestore.rules refuses a guest's query above 500 (guestList). */
export const CYCLE_LIMIT_MAX = 500;
/**
 * Events drawn for one cycle: its newest this many (#326). Most runs are a handful of stages; a long escalation, many
 * reopenings or retries can pass it, and the Runs page then says the older ones are not drawn.
 */
export const EVENT_LIMIT = 200;

/** The newest `max` cycles (bounded by CYCLE_LIMIT_MAX), live; `capped` when there may be older ones. */
export function subscribeCycles(
  environment: string,
  onData: (rows: CycleRow[], capped: boolean) => void,
  onError: (err: Error) => void,
  max: number = CYCLE_LIMIT
): Unsubscribe {
  const n = Math.min(Math.max(1, Math.floor(Number.isFinite(max) ? max : CYCLE_LIMIT)), CYCLE_LIMIT_MAX);
  const q = query(
    collection(firestore(), dataSource().cycles),
    where("environment", "==", environment),
    orderBy("updatedAt", "desc"),
    limit(n)
  );
  return onSnapshot(
    q,
    (snap) => {
      // A document that doesn't parse is left out rather than shown half-understood.
      const rows = snap.docs.flatMap((d) => parseCycle(d.id, d.data()) ?? []);
      onData(rows, snap.size >= n);
    },
    onError
  );
}

/**
 * A run's newest EVENT_LIMIT events, live, handed over in sequence order; `capped` when the run has older events that are not read (#326).
 *
 * The read is newest first by `seq`, which every writer sets (src/agent/cycle.ts, src/seedDemo.ts, and the guest copy,
 * src/publicView.ts `toPublicEvent`), so a run with more events than the limit keeps its latest ones, the round the page
 * draws. Read by document id alone (no order), Firestore returned the OLDEST ones and the latest steps went missing. It
 * asks for one more than it keeps, so `capped` means older events exist, not that a run happens to hold exactly the
 * limit. Each shape needs its composite index in firestore.indexes.json (`events`: environment, seq desc;
 * starfish_public_events: cycleId, environment, seq desc); without it Firestore refuses the query and onError fires.
 */
export function subscribeEvents(
  cycleId: string,
  environment: string,
  onData: (rows: EventRow[], capped: boolean) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const source = dataSource();
  const deliver = (docs: QueryDocumentSnapshot[], parse: (d: QueryDocumentSnapshot) => EventRow | null) =>
    onData(
      docs
        .slice(0, EVENT_LIMIT)
        .flatMap((d) => parse(d) ?? [])
        .sort((a, b) => a.seq - b.seq),
      docs.length > EVENT_LIMIT
    );
  if (source.publicEvents) {
    // A guest: the copies of this run's events, one flat collection keyed `{cycleId}_{seq}`.
    const prefix = `${cycleId}_`;
    const q = query(
      collection(firestore(), source.publicEvents),
      where("cycleId", "==", cycleId),
      where("environment", "==", environment),
      orderBy("seq", "desc"),
      limit(EVENT_LIMIT + 1)
    );
    return onSnapshot(
      q,
      (snap) => deliver(snap.docs, (d) => (d.id.startsWith(prefix) ? parseEvent(d.id.slice(prefix.length), d.data()) : null)),
      onError
    );
  }
  const q = query(
    collection(firestore(), webConfig().cycleCollection, cycleId, "events"),
    where("environment", "==", environment),
    orderBy("seq", "desc"),
    limit(EVENT_LIMIT + 1)
  );
  return onSnapshot(q, (snap) => deliver(snap.docs, (d) => parseEvent(d.id, d.data())), onError);
}

/** Events in the Overview's feed. */
export const ACTIVITY_LIMIT = 10;

/**
 * The newest run events across every cycle of this environment, live: one collection-group query over
 * `events` (the subcollection name src/agent/cycle.ts writes), newest first. It needs the
 * COLLECTION_GROUP index in firestore.indexes.json and the collection-group rule in firestore.rules;
 * without the index Firestore refuses the query, and the caller's onError says the feed couldn't be read.
 */
export function subscribeLatestEvents(
  environment: string,
  onData: (rows: ActivityRow[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const source = dataSource();
  if (source.publicEvents) {
    // A guest: the newest event copies (#18). Needs the starfish_public_events index in firestore.indexes.json.
    const q = query(collection(firestore(), source.publicEvents), where("environment", "==", environment), orderBy("at", "desc"), limit(ACTIVITY_LIMIT));
    return onSnapshot(
      q,
      (snap) => onData(latestActivity(snap.docs.flatMap((d) => parsePublicActivity(environment, d.id, d.data()) ?? []), ACTIVITY_LIMIT)),
      onError
    );
  }
  const q = query(
    collectionGroup(firestore(), "events"),
    where("environment", "==", environment),
    orderBy("at", "desc"),
    limit(ACTIVITY_LIMIT)
  );
  const cycles = webConfig().cycleCollection;
  return onSnapshot(
    q,
    (snap) =>
      onData(latestActivity(snap.docs.flatMap((d) => parseActivity(cycles, environment, d.ref.path, d.data()) ?? []), ACTIVITY_LIMIT)),
    onError
  );
}

/**
 * One cycle by id, or null when there is none for this environment. The incident page reads its
 * current recurrence's cycle by id (`{incidentId}_r{n}`), which needs no index.
 */
export async function readCycle(id: string, environment: string): Promise<CycleRow | null> {
  const snap = await getDoc(doc(firestore(), dataSource().cycles, id));
  if (!snap.exists()) return null;
  const row = parseCycle(snap.id, snap.data());
  return row && row.environment === environment ? row : null;
}
