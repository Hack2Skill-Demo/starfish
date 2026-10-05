import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ResultsError, parseRun, type ScoreboardRun } from "./results.js";

/** Every results file in a directory, parsed strictly. One bad file fails the lot: a table must not quietly skip a run. */
export function loadRuns(dir: string): ScoreboardRun[] {
  if (!existsSync(dir)) return [];
  const runs: ScoreboardRun[] = [];
  const ids = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let run: ScoreboardRun;
    try {
      run = parseRun(JSON.parse(readFileSync(join(dir, file), "utf8")));
    } catch (e) {
      throw new ResultsError(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (ids.has(run.runId)) throw new ResultsError(`${file}: runId "${run.runId}" is already used by another file`);
    ids.add(run.runId);
    runs.push(run);
  }
  return runs;
}
