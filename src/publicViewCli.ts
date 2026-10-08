/**
 * `pnpm public-view`: bring every guest copy (src/publicView.ts, #18) in line with the store. Records stored before the
 * copies existed get one; a copy whose record is gone, retired, or no longer in a public environment
 * (`STARFISH_PUBLIC_ENVIRONMENTS`) is removed. A dry run unless told otherwise.
 *
 *   pnpm public-view                              # count what would change, write nothing
 *   pnpm public-view -- --apply --project=<id>    # write and remove the copies
 *
 * `--apply` must name the project it expects (GOOGLE_CLOUD_PROJECT), as `pnpm scrub` does, so a stale .env cannot write
 * to a store you did not mean. Running it again on an unchanged store finds nothing to do. It reads every incident, cycle
 * and event (and every copy), so it is a one-off after a deploy, not something to schedule: the engine keeps the copies
 * up to date as it writes, and its jobs sweep the newest ones after each run.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig, usingFirestoreEmulator } from "./config.js";
import { backfillPublicView, type BackfillCounts } from "./publicViewStore.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const named = args.find((a) => a.startsWith("--project="))?.slice("--project=".length);

const config = loadConfig();
if (apply && named !== config.projectId) {
  console.error(
    `Refusing to write: --apply needs --project=${config.projectId} (the configured GOOGLE_CLOUD_PROJECT).` +
      (named === undefined ? " None was given." : ` Got --project=${named}.`)
  );
  process.exit(1);
}

initializeApp({ projectId: config.projectId });
const db = getFirestore(config.databaseId);
const where = `${config.projectId} / ${config.databaseId}`;
const envs = config.publicEnvironments.length > 0 ? config.publicEnvironments.join(", ") : "none (STARFISH_PUBLIC_ENVIRONMENTS is empty: every copy is removed)";
console.log(`${apply ? "Writing" : "Dry run on"} ${where}${usingFirestoreEmulator() ? " (emulator)" : ""}: guest copies for ${envs}`);

const r = await backfillPublicView(db, config, { apply });
const line = (what: string, c: BackfillCounts) => `  ${what}: ${c.write} to ${apply ? "write" : "be written"}, ${c.remove} to ${apply ? "remove" : "be removed"}, ${c.same} already right`;
console.log(line(`incidents (${config.publicIncidentCollection})`, r.incidents));
console.log(line(`cycles (${config.publicCycleCollection})`, r.cycles));
console.log(line(`events (${config.publicEventCollection})`, r.events));
const changes = r.incidents.write + r.incidents.remove + r.cycles.write + r.cycles.remove + r.events.write + r.events.remove;
if (!apply && changes > 0) console.log(`Nothing was written. Re-run with: pnpm public-view -- --apply --project=${config.projectId}`);
if (apply && r.failures > 0) {
  console.error(`${r.failures} cop${r.failures === 1 ? "y" : "ies"} could not be written; run it again.`);
  process.exit(1);
}
if (apply) console.log(changes === 0 ? "Nothing to do." : "Done. Running it again changes nothing.");
