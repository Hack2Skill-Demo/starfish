/**
 * `pnpm scoreboard`: read the results files, write the table. The numbers are only ever computed from recorded runs;
 * with none, it says so and writes nothing.
 *
 *   pnpm scoreboard                  write scoreboard/RESULTS.md from scoreboard/results/*.json
 *   pnpm scoreboard --check          exit 1 if RESULTS.md is not what the files produce (for CI)
 *   pnpm scoreboard --dir <d> --out <f>
 *
 * Takes no environment: it reads files, so it has no deployment-specific value to configure.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { loadRuns } from "./scoreboard/load.js";
import type { ScoreboardRun } from "./scoreboard/results.js";
import { renderScoreboard } from "./scoreboard/render.js";

function main(argv: string[]): number {
  const arg = (name: string, fallback: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const dir = arg("--dir", "scoreboard/results");
  const out = arg("--out", "scoreboard/RESULTS.md");
  let runs: ScoreboardRun[];
  try {
    runs = loadRuns(dir);
  } catch (e) {
    console.error(`scoreboard: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const text = renderScoreboard(runs);
  if (argv.includes("--check")) {
    const current = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (runs.length === 0 && current === "") return (console.log("scoreboard: no runs recorded, nothing to check"), 0);
    if (current !== text) return (console.error(`scoreboard: ${out} is not what ${dir} produces; run \`pnpm scoreboard\``), 1);
    console.log(`scoreboard: ${out} is up to date (${runs.length} run${runs.length === 1 ? "" : "s"})`);
    return 0;
  }
  if (runs.length === 0) return (console.log(`scoreboard: no runs recorded in ${dir}; nothing written`), 0);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`scoreboard: wrote ${out} from ${runs.length} run${runs.length === 1 ? "" : "s"}`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
