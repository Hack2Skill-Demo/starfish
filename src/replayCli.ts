/**
 * `pnpm replay`: the replay harness (#10, src/scoreboard/replay.ts) over the corpus in STARFISH_REPLAY_CORPUS, writing
 * one results file to STARFISH_REPLAY_RESULTS_DIR for `pnpm scoreboard` to judge.
 *
 *   pnpm replay --hash            print each case's current hash (what a held-out case is frozen with). No model, no command.
 *   pnpm replay --check-corpus    the checks a run starts with: frozen hashes, every evaluator fails before the fix, every
 *                                 planted patch passes the gate and fails its evaluator. Runs the corpus's commands, no model.
 *   pnpm replay [--run-id <id>]   a scored run: calls Gemini on Vertex (`askJson`) for every case. Needs a .env with
 *                                 Vertex access and STARFISH_VERIFY_ISOLATION=in-process: the model's patches run in
 *                                 this process, which is not a sandbox. Never overwrites an existing results file.
 *
 * --check-corpus and a run read the deployment's settings through `loadConfig()` (model, verify timeout, excluded paths,
 * budgets), so GOOGLE_CLOUD_PROJECT must be set even for --check-corpus, which calls no cloud API.
 * Exits 0 on success, 1 on a failure, 2 when it refuses to start.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadChildProcessBasics, loadConfig, loadReplayConfig } from "./config.js";
import { askJson } from "./vertex.js";
import { caseHashOf, CorpusError, loadCorpus, type Corpus } from "./scoreboard/corpus.js";
import { checkCorpus, runReplay } from "./scoreboard/replay.js";
import { redactPii } from "./ingest/redact.js";

/** The Starfish revision under test, marked `-dirty` when the working tree has changes a reader could not see. */
function starfishRevision(): string {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", env: loadChildProcessBasics() }).trim();
  try {
    return `${git("rev-parse", "HEAD")}${git("status", "--porcelain") === "" ? "" : "-dirty"}`;
  } catch {
    return "unknown";
  }
}

async function main(argv: string[]): Promise<number> {
  const replay = loadReplayConfig();
  let corpus: Corpus;
  try {
    corpus = loadCorpus(replay.corpusDir);
  } catch (e) {
    console.error(`replay: ${e instanceof CorpusError ? e.message : String(e)}`);
    return 2;
  }
  if (corpus.synthetic) console.warn(`replay: corpus ${corpus.corpusVersion} is SYNTHETIC; nothing measured over it is a result.`);

  if (argv.includes("--hash")) {
    for (const c of corpus.cases) console.log(`${c.caseId}\t${c.split}\t${await caseHashOf(c)}`);
    return 0;
  }

  const cfg = loadConfig();
  if (argv.includes("--check-corpus")) {
    const problems = await checkCorpus(corpus, cfg);
    for (const p of problems) console.error(`replay: ${p}`);
    if (problems.length === 0) console.log(`replay: corpus ${corpus.corpusVersion} is fit to run (${corpus.cases.length} cases)`);
    return problems.length === 0 ? 0 : 1;
  }

  if (cfg.verifyIsolation !== "in-process") {
    console.error("replay: a scored run executes the model's patches in this process; set STARFISH_VERIFY_ISOLATION=in-process to say that is acceptable here.");
    return 2;
  }
  const i = argv.indexOf("--run-id");
  const runId = i >= 0 && argv[i + 1] ? argv[i + 1]! : `replay-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    console.error("replay: --run-id may hold letters, digits, '.', '_' and '-' only");
    return 2;
  }
  const out = join(replay.resultsDir, `${runId}.json`);
  if (existsSync(out)) {
    console.error(`replay: ${out} already exists; a recorded run is never overwritten`);
    return 2;
  }

  try {
    const run = await runReplay({
      corpus,
      cfg,
      ask: askJson,
      runId,
      starfishRevision: starfishRevision(),
      caseTimeoutMs: replay.caseTimeoutSeconds * 1000,
      onCase: (id, outcome, note) => console.log(`replay: ${id}: ${outcome.status} (${note})`),
    });
    mkdirSync(replay.resultsDir, { recursive: true });
    writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" });
    console.log(`replay: wrote ${out}; run \`pnpm scoreboard\` to render it`);
    return 0;
  } catch (e) {
    console.error(`replay: ${e instanceof Error ? redactPii(e.message) : "failed"}`);
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
