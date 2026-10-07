/**
 * `pnpm status [--stale-minutes N] [--min-incidents N] [--min-entries N]`: is the deployed engine alive?
 * Prints what the engine last recorded and how many incidents it holds, and exits 0 only when the last
 * run is ok and recent and the minimums hold (src/status.ts). Both minimums default to 0: a quiet project
 * is a correct answer. --min-entries is about the last run (log entries it processed), --min-incidents
 * about the store.
 * Needs credentials for the project (`gcloud auth application-default login`), or the emulator.
 */
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { LAST_RUN_DOC } from "./ingest/run.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { describeStatus, parseRunRecord, unmetMinimums } from "./status.js";
import { INCIDENT_STATUSES } from "./types.js";

const { values } = parseArgs({
  options: {
    "stale-minutes": { type: "string", default: "90" },
    "min-incidents": { type: "string", default: "0" },
    "min-entries": { type: "string", default: "0" },
  },
  allowPositionals: false,
});
const staleMinutes = Number(values["stale-minutes"]);
const minIncidents = Number(values["min-incidents"]);
const minEntries = Number(values["min-entries"]);
if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
  console.error("status: --stale-minutes must be a positive number");
  process.exit(2);
}
for (const [flag, n] of [["--min-incidents", minIncidents], ["--min-entries", minEntries]] as const) {
  if (!Number.isInteger(n) || n < 0) {
    console.error(`status: ${flag} must be a whole number, 0 or more`);
    process.exit(2);
  }
}

const base = loadConfig();
initializeApp({ projectId: base.projectId });
const db = getFirestore(base.databaseId);
// The environment the engine runs under is the runtime settings' one (an admin can change it in the UI), resolved the
// way src/ingest/run.ts resolves it; the env var is only its default.
const resolved = await new RuntimeConfigLoader(base).resolve(db);
const config = resolved.config;
if (resolved.problems.length > 0) console.log(`runtime settings unusable (${resolved.problems.join("; ")}); using the ${resolved.source} configuration`);

const runSnap = await db.collection(config.runCollection).doc(LAST_RUN_DOC).get();

// One aggregate count per status: bounded however many incidents there are. A retired incident is in no list in the UI
// (src/ingest/retire.ts), so it is taken out of the count here too: two aggregates per status, total minus retired.
const counts: Record<string, number> = {};
for (const status of INCIDENT_STATUSES) {
  const q = db.collection(config.incidentCollection).where("environment", "==", config.environment).where("status", "==", status);
  const [all, retired] = await Promise.all([q.count().get(), q.where("retired", "==", true).count().get()]);
  counts[status] = Math.max(0, all.data().count - retired.data().count);
}

const run = parseRunRecord(runSnap.data());
const report = describeStatus({
  run,
  now: new Date(),
  staleMinutes,
  environment: config.environment,
  counts,
});
console.log(`project ${config.projectId}, database ${config.databaseId}`);
for (const line of report.lines) console.log(line);
const unmet = unmetMinimums({ run, environment: config.environment, counts },{ incidents: minIncidents, entries: minEntries });
for (const line of unmet) console.log(line);
process.exit(report.state === "ok" && unmet.length === 0 ? 0 : 1);
