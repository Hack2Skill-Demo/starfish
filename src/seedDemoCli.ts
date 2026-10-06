/**
 * `pnpm seed-demo`: write (or remove) the SYNTHETIC evidence history for the public demo (seedDemo.ts).
 *
 *   pnpm seed-demo                               # dry run: print what would be written, write nothing
 *   pnpm seed-demo -- --apply --project=<id>     # write it (re-running replaces it, never duplicates)
 *   pnpm seed-demo -- --remove --project=<id>    # delete exactly what it wrote
 *
 * Refuses unless STARFISH_ENV is "demo". `--apply` and `--remove` must name the project they expect
 * (GOOGLE_CLOUD_PROJECT), as `pnpm scrub` does, so a stale .env cannot write to a store you did not mean.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { applyDemoHistory, buildDemoPlan, DEMO_ENVIRONMENT, describePlan, removeDemoHistory } from "./seedDemo.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const remove = args.includes("--remove");
const named = args.find((a) => a.startsWith("--project="))?.slice("--project=".length);
const config = loadConfig();

if (config.environment !== DEMO_ENVIRONMENT) {
  console.error(`Refusing: the synthetic history is written only to the "${DEMO_ENVIRONMENT}" environment; STARFISH_ENV is "${config.environment}".`);
  process.exit(1);
}
if (apply && remove) {
  console.error("Refusing: pass --apply or --remove, not both.");
  process.exit(1);
}
if ((apply || remove) && named !== config.projectId) {
  console.error(
    `Refusing to write: ${apply ? "--apply" : "--remove"} needs --project=${config.projectId} (the configured GOOGLE_CLOUD_PROJECT).` +
      (named === undefined ? " None was given." : ` Got --project=${named}.`)
  );
  process.exit(1);
}

initializeApp({ projectId: config.projectId });
const db = getFirestore(config.databaseId);
const plan = buildDemoPlan(new Date(), config.environment);
const where = `${config.projectId} / ${config.databaseId}`;

if (!apply && !remove) {
  console.log(`Dry run on ${where}: the SYNTHETIC demo history (every document marked synthetic: true)`);
  for (const line of describePlan(plan, config)) console.log(`  ${line}`);
  console.log(`Nothing was written. Write it with: pnpm seed-demo -- --apply --project=${config.projectId}`);
} else if (apply) {
  const r = await applyDemoHistory(db, config, plan);
  if (!r.ok) {
    console.error(`Refused (${r.reason}): ${r.detail}. Nothing was written.`);
    process.exit(1);
  }
  console.log(`Wrote the synthetic demo history to ${where}: ${r.incidents} incidents, ${r.cycles} cycles, ${r.events} events` +
    (r.staleEventsRemoved > 0 ? ` (${r.staleEventsRemoved} stale events removed)` : "") + ".");
} else {
  const r = await removeDemoHistory(db, config, plan);
  if (!r.ok) {
    console.error(`Refused (${r.reason}): ${r.detail}. Nothing was deleted.`);
    process.exit(1);
  }
  console.log(`Removed the synthetic demo history from ${where}: ${r.incidents} incidents, ${r.cycles} cycles, ${r.events} events.`);
}
