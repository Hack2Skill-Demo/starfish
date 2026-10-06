/**
 * `pnpm grant-operator --project <id> --email you@example.com --role admin [--create]`
 *
 * `--trust-existing` grants to an existing account whose email is not verified (refused by default: #139); read the
 * account's creation time and providers in the refusal first. `--link` also prints a link to choose a password, for an account that exists (email can be slow or blocked).
 * Gives a person access to the operator UI (src/operators.ts). Run it once after the first deploy to
 * make the first admin. It writes Starfish's store and reads Firebase Auth, so it needs credentials
 * for the project (`gcloud auth application-default login`), or the emulators for a local try.
 */
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { describeAccount, grantOperator, parseRoles } from "./operators.js";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    email: { type: "string" },
    role: { type: "string", default: "admin" },
    create: { type: "boolean", default: false },
    link: { type: "boolean", default: false },
    "trust-existing": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.email === undefined || values.project === undefined) {
  console.error("usage: pnpm grant-operator --project <id> --email <address> [--role admin|operator[,..]] [--create] [--link] [--trust-existing]");
  process.exit(2);
}

const config = loadConfig();
// The project is named on the command line AND read from GOOGLE_CLOUD_PROJECT (which Cloud Shell sets to whatever
// project the shell is on, and which changes under you). They must agree, or nothing is touched.
if (config.projectId !== values.project) {
  console.error(
    `grant-operator: refusing: --project is ${values.project} but GOOGLE_CLOUD_PROJECT is ${config.projectId}. ` +
      `Run \`export GOOGLE_CLOUD_PROJECT=${values.project}\` and try again.`
  );
  process.exit(2);
}
console.log(`project ${config.projectId}, database ${config.databaseId}`);
initializeApp({ projectId: config.projectId });

try {
  const result = await grantOperator(
    { auth: getAuth(), db: getFirestore(config.databaseId), usersCollection: config.usersCollection },
    {
      email: values.email,
      roles: parseRoles(values.role),
      createAccount: values.create,
      resetLink: values.link,
      trustExisting: values["trust-existing"],
    }
  );
  console.log(`account ${result.uid}: ${result.created ? "created by this run" : describeAccount(result.account)}`);
  console.log(
    `${values.email} is now ${values.role} in ${config.projectId} (${config.databaseId}/${config.usersCollection}/${result.uid})`
  );
  if (result.passwordResetLink !== undefined) {
    console.log(`a link to choose a password (open it in a browser; it works once):\n${result.passwordResetLink}`);
  }
} catch (err) {
  console.error(`grant-operator: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
