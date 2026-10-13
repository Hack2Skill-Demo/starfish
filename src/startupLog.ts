/**
 * #275: Cloud Run executions spend about 2 minutes before any of Starfish's work, and loading modules takes about 2 s
 * locally. One structured line per deployed CLI says where the wait goes: `process.uptime()` counts from node's start,
 * so the line's timestamp minus `uptimeSeconds` is when the process started. Set against the execution's creation time:
 * a small uptime puts the wait before the process (Cloud Run's side), a large one in loading modules (the image).
 *
 * Import this module FIRST in a CLI. ES modules are fetched and linked as a whole graph, then evaluated in import order,
 * so this module's body runs before the imports after it are evaluated: `codeStartSeconds` is the uptime once the graph
 * is loaded (with tsx: transpiled), and `uptimeSeconds` (when the CLI calls `logStartup` after its imports) the uptime
 * once every module has been evaluated (locally, with no credentials: ingest 0.5 s and 1.3 s, agent 1.0 s and 1.7 s).
 * It imports nothing, reads no environment (src/config.ts is the only reader), and never throws: a diagnostic must not
 * stop the job it describes. Not yet read from a deployed run.
 */

const uptime = (): number | null => {
  try {
    const u = process.uptime();
    return Number.isFinite(u) && u >= 0 ? u : null;
  } catch {
    return null;
  }
};

/** The uptime when this module was evaluated: before any import after it in the CLI. */
const codeStart = uptime();

const seconds = (u: number | null): number | null => (u === null ? null : Math.round(u * 1000) / 1000);

/**
 * The line, pure: Cloud Logging reads a JSON line's `severity` and `message`, as the admin API's lines already use.
 * `processStartedAt` is `now` minus the uptime, so it can be set against the execution's creation time directly.
 */
export function startupLine(job: string, uptimeSeconds: number | null, codeStartSeconds: number | null, now: Date): string {
  const up = seconds(uptimeSeconds);
  const startedAt = up === null || !Number.isFinite(now.getTime()) ? null : new Date(now.getTime() - up * 1000);
  return JSON.stringify({
    severity: "INFO",
    message: `starfish ${job} started`,
    job,
    uptimeSeconds: up,
    codeStartSeconds: seconds(codeStartSeconds),
    processStartedAt: startedAt && Number.isFinite(startedAt.getTime()) ? startedAt.toISOString() : null,
  });
}

/** Prints the line for `job` (`ingest`, `agent`, `admin-api`, `verify-runner`) once the CLI's imports are loaded. Never throws. */
export function logStartup(job: string): void {
  try {
    console.log(startupLine(job, uptime(), codeStart, new Date()));
  } catch {
    // A diagnostic only: nothing to do.
  }
}
