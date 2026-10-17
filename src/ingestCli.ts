/**
 * `pnpm ingest`: one scheduled ingest run (see src/ingest/run.ts). This is the entrypoint the
 * Cloud Run job runs (the Dockerfile's command; scripts/deploy-gcp.sh deploys and schedules it, and
 * did so once, on the demo project, 2026-10-05, #6). Exits 1 when the run failed, so Cloud Run, a
 * scheduler or a shell sees the failure. That includes a run that refused to start because the runtime
 * settings could not be used and no last-good copy exists (`settings-unusable`, src/ingest/run.ts).
 *
 * It reads the watched project's Cloud Logging and writes Starfish's store, so it needs
 * credentials for both (or the emulator, FIRESTORE_EMULATOR_HOST, for the store).
 *
 * A read that stalls is given up at the end of the run budget (`STARFISH_INGEST_RUN_BUDGET_SECONDS`, #221),
 * and recorded as a failed `last_run`, before the Cloud Run job's task timeout (which scripts/deploy-gcp.sh
 * derives from the budget, above it) kills the process.
 *
 * Known limits: with no credentials at all, the Cloud Logging client throws from inside the
 * library, which ends the process (exit 1, stack on stderr) before this run can record a failed
 * `last_run`. And the budget bounds the window reads, not the settings read and state transactions around them or the
 * process's own start: a stall there, or a budget set above the task timeout by hand, is ended by the
 * task timeout with nothing recorded. In both cases a scheduler sees the exit; the UI would show the
 * previous run as the latest, which is what the "alert when scheduled ingestion stops" criterion on #6 is for.
 */
// First, so its uptime mark is taken before any other module's code runs (#275, src/startupLog.ts).
import { logStartup } from "./startupLog.js";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { runIngest } from "./ingest/run.js";
import { ingestCheckpointLine } from "./ingest/lagLog.js";
import { syncRecentPublicView } from "./publicViewStore.js";

// #275: where the ~2 minutes before any work go. Also the run's first line: the rest is printed when it ends.
logStartup("ingest");
const config = loadConfig();
initializeApp({ projectId: config.projectId });
const db = getFirestore(config.databaseId);

const summary = await runIngest(db, new RuntimeConfigLoader(config));

const t = summary.totals;
console.log(
  `ingest ${summary.outcome}: ${summary.windows} window(s), ${t.entriesProcessed} entries; ` +
    `${t.incidentsCreated} new, ${t.incidentsUpdated} updated, ${t.incidentsRecurred} recurred, ${t.incidentsReplayed} replayed` +
    (t.errorsFoldedIntoOverflow > 0 ? `; ${t.errorsFoldedIntoOverflow} distinct error(s) folded into overflow incidents` : "") +
    (summary.capped ? " (a read hit the cap: counts are a floor)" : "") +
    (summary.lagSeconds !== undefined && summary.lagSeconds >= 60 ? `; checkpoint ${Math.round(summary.lagSeconds / 60)} min behind` : "") +
    (summary.error !== undefined ? ` - ${summary.error}` : "")
);
// The line the external lag alert reads (#387, scripts/setup-ingest-alerts.sh).
const checkpointLine = ingestCheckpointLine(summary);
if (checkpointLine !== undefined) console.log(checkpointLine);
console.log(`config from ${summary.configSource}${summary.problems.length ? `; settings not used: ${summary.problems.join("; ")}` : ""}`);

// The guests' trimmed copies (#18) of the newest public records, for changes the engine's own refreshes cannot see (an
// operator's triage in the UI). Never throws, and never fails the run: the copies only lag until the next one.
if (config.publicEnvironments.length > 0) {
  const sweep = await syncRecentPublicView(db, config);
  console.log(
    `public view: ${sweep.incidents.refreshed} of ${sweep.incidents.checked} incident copies and ${sweep.cycles.refreshed} of ${sweep.cycles.checked} cycle copies brought up to date` +
      (sweep.failures > 0 ? `; ${sweep.failures} could not be (they catch up next run)` : "")
  );
}
process.exit(summary.outcome === "failed" ? 1 : 0);
