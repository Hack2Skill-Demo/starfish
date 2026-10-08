/**
 * The agent's run for each listed incident, live. One subscription to the environment's newest runs (the Runs page's
 * own query, `subscribeCycles`); a run that is not among them while that list is capped is read once by its id
 * (`readCycle`), so an incident whose run is older than the newest `CYCLE_LIMIT` still shows it. A failed read says
 * nothing about that incident rather than "no run". A by-id answer holds only until a snapshot lists that run: the list
 * is newer, and a run that later drops out of it again is read anew rather than shown as it was before (#218).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { readCycle, subscribeCycles } from "./runs";
import { incidentRunView, runIdFor, type IncidentRunView } from "./incidentRun";
import { useNow } from "./useNow";
import type { CycleRow } from "./runsModel";

/** Runs read by id in one batch at most; batches follow until every listed incident is covered. */
const MAX_SINGLE_READS = 50;

export function useIncidentRuns(
  environment: string,
  ready: boolean,
  incidents: readonly { id: string; recurrenceCount: number }[]
): (incident: { id: string; recurrenceCount: number }) => IncidentRunView {
  const [cycles, setCycles] = useState<Map<string, CycleRow> | null>(null);
  const [capped, setCapped] = useState(false);
  const [failed, setFailed] = useState(false);
  // Read by id: the run, or null when it does not exist. Absent: not read (yet), or the read failed.
  const [single, setSingle] = useState<Map<string, CycleRow | null>>(new Map());
  // Ticks on its own: a run whose worker died writes nothing, and must still stop reading "In progress".
  const now = useNow();
  // Ids already read (or being read) by id for this subscription: each is read once, a failure is not retried in a loop.
  const attempted = useRef(new Set<string>());
  // Which subscription a read belongs to: a read that answers after the environment changed is dropped.
  const generation = useRef(0);
  // Snapshots seen by this subscription, and the last one that listed each run: a by-id read that started before a
  // snapshot listed its run answers with something older than the list, so that answer is dropped.
  const snapshot = useRef(0);
  const listedAt = useRef(new Map<string, number>());

  useEffect(() => {
    if (!ready) return;
    setCycles(null);
    setFailed(false);
    setSingle(new Map());
    attempted.current = new Set();
    generation.current += 1;
    snapshot.current = 0;
    listedAt.current = new Map();
    return subscribeCycles(
      environment,
      (rows, isCapped) => {
        snapshot.current += 1;
        for (const r of rows) {
          listedAt.current.set(r.id, snapshot.current);
          // Listed now: forget any by-id answer, so a later miss reads it again.
          attempted.current.delete(r.id);
        }
        setSingle((prev) => {
          if (!rows.some((r) => prev.has(r.id))) return prev;
          const next = new Map(prev);
          for (const r of rows) next.delete(r.id);
          return next;
        });
        setCycles(new Map(rows.map((r) => [r.id, r])));
        setCapped(isCapped);
        setFailed(false);
      },
      () => setFailed(true)
    );
  }, [environment, ready]);

  const ids = useMemo(() => incidents.map((i) => runIdFor(i.id, i.recurrenceCount)), [incidents]);

  useEffect(() => {
    if (!ready || cycles === null || !capped) return;
    const wanted = ids.filter((id) => !cycles.has(id) && !attempted.current.has(id)).slice(0, MAX_SINGLE_READS);
    if (wanted.length === 0) return;
    for (const id of wanted) attempted.current.add(id);
    const gen = generation.current;
    const at = snapshot.current;
    void Promise.all(
      wanted.map((id) =>
        readCycle(id, environment).then(
          (row) => [id, row] as const,
          () => undefined
        )
      )
    ).then((found) => {
      if (gen !== generation.current) return;
      setSingle((prev) => {
        const next = new Map(prev);
        for (const f of found) if (f && (listedAt.current.get(f[0]) ?? 0) <= at) next.set(f[0], f[1]);
        return next;
      });
    });
  }, [ids, cycles, capped, environment, ready]);

  return (incident) => {
    if (failed || cycles === null) return { kind: "unknown" };
    const id = runIdFor(incident.id, incident.recurrenceCount);
    const listed = cycles.get(id);
    if (listed) return incidentRunView(listed, true, now);
    return incidentRunView(single.get(id), !capped, now);
  };
}
