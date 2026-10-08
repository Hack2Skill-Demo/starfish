/**
 * What an index heal's runtime verdict was decided on (`summary.index.runtimeBasis`, written by observe.ts). Fixed
 * sentences, so the trimmed copy guests read (src/publicView.ts) can allow exactly these and nothing else.
 */
export const QUIET_BASIS = "no occurrence since READY with ingest read through the window, and the configured query replayed at the end; traffic is not measured";
export const UNCOVERED_BASIS = "ingest had not read the logs through the window a day after it ended; nothing was concluded from the incident's record";
export const INCONCLUSIVE_BASIS = "the configured query could not be replayed until a day after the window ended; nothing was concluded from it";

export const RUNTIME_BASES: readonly string[] = [QUIET_BASIS, UNCOVERED_BASIS, INCONCLUSIVE_BASIS];
