/**
 * `pnpm scrub`: redact credentials and emails from incidents stored before the redaction
 * policy (see scrub.ts). A dry run unless told otherwise.
 *
 *   pnpm scrub                              # count what would change, write nothing
 *   pnpm scrub -- --apply --project=<id>    # rewrite the records
 *
 * `--apply` must name the project it expects (GOOGLE_CLOUD_PROJECT), so a stale .env can't
 * rewrite a store you did not mean to touch. Against the emulator
 * (FIRESTORE_EMULATOR_HOST set) that check still applies, with the emulator's project id.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { scrubCollection } from "./scrub.js";

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
const where = `${config.projectId} / ${config.databaseId} / ${config.incidentCollection}`;
console.log(`${apply ? "Scrubbing" : "Dry run on"} ${where}${process.env.FIRESTORE_EMULATOR_HOST ? " (emulator)" : ""}`);

const r = await scrubCollection(db, config, { apply });
console.log(`scanned ${r.scanned} incidents; ${r.changed} held something to redact`);
console.log(
  `  fields: message ${r.byField.errorMessage}, detail ${r.byField.errorDetail}, stack ${r.byField.stackTrace}, name ${r.byField.errorName}`
);
console.log(`  fingerprints ${apply ? "recomputed" : "to recompute"}: ${r.refingerprinted}; stale keys removed: ${r.keysRemoved}`);
if (!apply && r.changed > 0) console.log(`Nothing was written. Re-run with: pnpm scrub -- --apply --project=${config.projectId}`);
if (apply) console.log(r.changed === 0 ? "Nothing to scrub." : "Done. Running it again changes nothing.");
