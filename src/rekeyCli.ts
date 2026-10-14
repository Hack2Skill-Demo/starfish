/**
 * `pnpm rekey`: after a change to the fingerprint code, give every live incident of the configured environment
 * (STARFISH_ENV) the fingerprint its stored fields hash to now, and point its incident key at it (see rekey.ts, #362).
 * A dry run unless told otherwise.
 *
 *   pnpm rekey                              # count what would change, write nothing
 *   pnpm rekey -- --apply --project=<id>    # re-key the records
 *
 * `--apply` must name the project it expects (GOOGLE_CLOUD_PROJECT), as `pnpm scrub` does, so a stale .env cannot
 * rewrite a store you did not mean to touch. Against the emulator (FIRESTORE_EMULATOR_HOST set) that check still
 * applies, with the emulator's project id. Running it again finds nothing to do.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig, usingFirestoreEmulator } from "./config.js";
import { MAX_GROUP_RECORDS, rekeyIncidents } from "./rekey.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const named = args.find((a) => a.startsWith("--project="))?.slice("--project=".length);

const config = loadConfig();
if (apply && named !== config.projectId) {
  console.error(
    `Refusing to rewrite: --apply needs --project=${config.projectId} (the configured GOOGLE_CLOUD_PROJECT).` +
      (named === undefined ? " None was given." : ` Got --project=${named}.`)
  );
  process.exit(1);
}

initializeApp({ projectId: config.projectId });
const db = getFirestore(config.databaseId);
const where = `${config.projectId} / ${config.databaseId} / ${config.incidentCollection}, environment ${config.environment}`;
console.log(`${apply ? "Re-keying" : "Dry run on"} ${where}${usingFirestoreEmulator() ? " (emulator)" : ""}`);

const r = await rekeyIncidents(db, config, { environment: config.environment, apply });
console.log(`scanned ${r.scanned} incidents (${r.retired} retired, left as they are)`);
console.log(
  `  fingerprints ${apply ? "recomputed" : "to recompute"}: ${r.refingerprinted}; fingerprints several incidents ${apply ? "now share" : "would share"}: ${r.shared}`
);
if (apply) console.log(`  keys written: ${r.keysWritten}; tombstones kept: ${r.tombstonesKept}`);
if (r.tooLarge > 0) console.log(`  left untouched: ${r.tooLarge} fingerprint(s) held by more than ${MAX_GROUP_RECORDS} incidents`);
if (!apply && r.refingerprinted > 0) console.log(`Nothing was written. Re-run with: pnpm rekey -- --apply --project=${config.projectId}`);
if (apply) console.log(r.refingerprinted === 0 ? "Nothing to re-key." : "Done. Running it again changes nothing.");
