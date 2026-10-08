import { useEffect, useState } from "react";

/** How often a page re-evaluates time-based states ("live", a lease that ran out) without waiting for the next write. */
export const TICK_MS = 15_000;

/** The current time, refreshed every `TICK_MS`: a run whose worker died writes nothing, so a snapshot alone never moves it. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  return now;
}
