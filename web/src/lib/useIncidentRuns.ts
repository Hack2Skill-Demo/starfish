/**
 * The agent's run for each listed incident, live. One subscription to the environment's newest runs (the Runs page's
 * own query, `subscribeCycles`); a run that is not among them while that list is capped is read once by its id
 * (`readCycle`), so an incident whose run is older than the newest `CYCLE_LIMIT` still shows it. A failed read says
 * nothing about that incident rather than "no run".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { readCycle, subscribeCycles } from "./runs";
import { incidentRunView, runIdFor, type IncidentRunView } from "./incidentRun";
import type { CycleRow } from "./runsModel";

/** Runs read one by one per page render at most: the incident list itself is bounded, this bounds the extra reads. */
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
  const [now, setNow] = useState(() => Date.now());
  // Ids already read (or being read) by id for this subscription: each is read once, a failure is not retried in a loop.
  const attempted = useRef(new Set<string>());
  // Which subscription a read belongs to: a read that answers after the environment changed is dropped.
  const generation = useRef(0);

  useEffect(() => {
    if (!ready) return;
    setCycles(null);
    setFailed(false);
    setSingle(new Map());
    attempted.current = new Set();
    generation.current += 1;
    return subscribeCycles(
      environment,
      (rows, isCapped) => {
        setCycles(new Map(rows.map((r) => [r.id, r])));
        setCapped(isCapped);
        setFailed(false);
        setNow(Date.now());
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
        for (const f of found) if (f) next.set(f[0], f[1]);
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
