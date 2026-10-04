/**
 * `pnpm ingest`: one scheduled ingest run (see src/ingest/run.ts). This is the entrypoint the
 * Cloud Run job runs (the Dockerfile's command; scripts/deploy-gcp.sh deploys and schedules it, but
 * has not yet been run against a real project, #6). Exits 1 when the run failed, so Cloud Run, a
 * scheduler or a shell sees the failure.
 *
 * It reads the watched project's Cloud Logging and writes Starfish's store, so it needs
 * credentials for both (or the emulator, FIRESTORE_EMULATOR_HOST, for the store).
 *
 * Known limit: with no credentials at all, the Cloud Logging client throws from inside the
 * library, which ends the process (exit 1, stack on stderr) before this run can record a failed
 * `last_run`. A scheduler sees the exit code; the UI would show the previous run as the latest,
 * which is what the "alert when scheduled ingestion stops" criterion on #6 is for.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { runIngest } from "./ingest/run.js";

const config = loadConfig();
initializeApp({ projectId: config.projectId });
const db = getFirestore(config.databaseId);

const summary = await runIngest(db, new RuntimeConfigLoader(config));

const t = summary.totals;
console.log(
  `ingest ${summary.outcome}: ${summary.windows} window(s), ${t.entriesProcessed} entries; ` +
    `${t.incidentsCreated} new, ${t.incidentsUpdated} updated, ${t.incidentsRecurred} recurred, ${t.incidentsReplayed} replayed` +
    (summary.capped ? " (a read hit the cap: counts are a floor)" : "") +
    (summary.error !== undefined ? ` - ${summary.error}` : "")
);
console.log(`config from ${summary.configSource}${summary.problems.length ? `; settings not used: ${summary.problems.join("; ")}` : ""}`);
process.exit(summary.outcome === "failed" ? 1 : 0);
