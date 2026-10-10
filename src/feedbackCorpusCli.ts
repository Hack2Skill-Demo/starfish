/**
 * `pnpm feedback-corpus`: the feedback engine's replay cases (src/scoreboard/feedbackCorpus.ts). Reads the operators'
 * corrections of this environment's incidents from the store and writes a corpus `pnpm replay` runs, so each correction
 * is a test of whether Gemini's own triage now agrees with the person. Read-only on the store; writes only local files.
 *
 *   pnpm feedback-corpus -- --out=<new dir> [--app-revision=<rev>] [--limit=200]
 *
 * The directory must not exist yet (a corpus is never mixed with another). Corrections a triage-only case can't express
 * (fix, merge) and incidents with no recorded counter-check are listed as skipped, with why.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig, usingFirestoreEmulator } from "./config.js";
import { buildFeedbackCorpus, type CorrectedIncident } from "./scoreboard/feedbackCorpus.js";
import { LEVELS } from "./triageRules.js";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("out");
const limit = Number(arg("limit") ?? "200");
if (!out) {
  console.error("Usage: pnpm feedback-corpus -- --out=<new dir> [--app-revision=<rev>] [--limit=200]");
  process.exit(1);
}
if (existsSync(out)) {
  console.error(`Refusing to write: ${out} already exists. A corpus goes in a new directory.`);
  process.exit(1);
}
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
  console.error("--limit must be a whole number from 1 to 1000.");
  process.exit(1);
}

const config = loadConfig();
initializeApp({ projectId: config.projectId });
const db = getFirestore(config.databaseId);
console.log(`Reading corrections in ${config.projectId} / ${config.databaseId} (${config.environment})${usingFirestoreEmulator() ? " (emulator)" : ""}`);

const snap = await db
  .collection(config.incidentCollection)
  .where("environment", "==", config.environment)
  .where("correctedLevel", "in", [...LEVELS])
  .limit(limit)
  .get();
const items: CorrectedIncident[] = [];
for (const d of snap.docs) {
  const data = d.data();
  const recurrence = typeof data.recurrenceCount === "number" ? data.recurrenceCount : 0;
  const cycle = (await db.collection(config.cycleCollection).doc(`${d.id}_r${recurrence}`).get()).data();
  const triage: unknown = (cycle?.summary as Record<string, unknown> | undefined)?.triage;
  const recorded = typeof triage === "object" && triage !== null ? (triage as Record<string, unknown>) : undefined;
  items.push({ id: d.id, doc: data, ...(recorded !== undefined && { triage: recorded }) });
}

const day = new Date().toISOString().slice(0, 10);
const corpus = buildFeedbackCorpus(items, { corpusVersion: `feedback-${config.environment}-${day}`, appRevision: arg("app-revision") ?? "unknown" });
const cases = (corpus.manifest.cases as unknown[]).length;
for (const s of corpus.skipped) console.log(`  skipped ${s.incidentId}: ${s.reason}`);
if (snap.size === limit) console.log(`  stopped at --limit=${limit}: there may be more corrections`);
if (cases === 0) {
  console.log(`${snap.size} correction(s) read; none can be a triage-only case. Nothing written.`);
  process.exit(0);
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(corpus.manifest, null, 2)}\n`);
for (const [rel, content] of Object.entries(corpus.files)) {
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  writeFileSync(join(out, rel), content);
}
console.log(`${cases} case(s) written to ${out} from ${snap.size} correction(s). Run them: STARFISH_REPLAY_CORPUS=${out} pnpm replay`);
