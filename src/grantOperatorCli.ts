/**
 * `pnpm grant-operator --email you@example.com --role admin [--create]`
 *
 * Gives a person access to the operator UI (src/operators.ts). Run it once after the first deploy to
 * make the first admin. It writes Starfish's store and reads Firebase Auth, so it needs credentials
 * for the project (`gcloud auth application-default login`), or the emulators for a local try.
 */
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { grantOperator, parseRoles } from "./operators.js";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    role: { type: "string", default: "admin" },
    create: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.email === undefined) {
  console.error("usage: pnpm grant-operator --email <address> [--role admin|operator[,..]] [--create]");
  process.exit(2);
}

const config = loadConfig();
initializeApp({ projectId: config.projectId });

try {
  const result = await grantOperator(
    { auth: getAuth(), db: getFirestore(config.databaseId), usersCollection: config.usersCollection },
    { email: values.email, roles: parseRoles(values.role), createAccount: values.create }
  );
  console.log(
    `${values.email} is now ${values.role} in ${config.projectId} (${config.databaseId}/${config.usersCollection}/${result.uid})`
  );
  if (result.passwordResetLink !== undefined) {
    console.log(`account created without a password. Send them this link to choose one:\n${result.passwordResetLink}`);
  }
} catch (err) {
  console.error(`grant-operator: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
