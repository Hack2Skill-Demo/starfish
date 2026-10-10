import { useEffect, useState } from "react";

/** How often a page re-evaluates time-based states ("live", a lease that ran out) without waiting for the next write. */
export const TICK_MS = 15_000;

/**
 * The current time, refreshed every `intervalMs` (default `TICK_MS`): a run whose worker died writes nothing, so a
 * snapshot alone never moves it. A running timer asks for a shorter interval, only while something is running.
 */
export function useNow(intervalMs: number = TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
