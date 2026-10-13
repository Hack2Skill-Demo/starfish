/**
 * `pnpm demo-users`: the public demo's judge sign-in accounts (demoUsers.ts).
 *
 *   pnpm demo-users                                          # dry run: the emails it would create, nothing touched
 *   pnpm demo-users -- --apply --project=<id>                # create them (operator role) and print each password ONCE
 *   pnpm demo-users -- --apply --reset-passwords --project=<id>   # also give existing ones a new password
 *   pnpm demo-users -- --remove --project=<id>               # delete the accounts and their operator records
 *
 * Refuses unless STARFISH_ENV is "demo", and a write must name the project it expects (GOOGLE_CLOUD_PROJECT), as
 * `pnpm seed-demo` does. Needs credentials for the project. The emails come from STARFISH_DEMO_USERS.
 */
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { applyDemoUsers, checkDemoEmails, removeDemoUsers } from "./demoUsers.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const remove = args.includes("--remove");
const reset = args.includes("--reset-passwords");
const named = args.find((a) => a.startsWith("--project="))?.slice("--project=".length);
const config = loadConfig();

if (config.environment !== "demo") {
  console.error(`Refusing: demo accounts are made only in the "demo" environment; STARFISH_ENV is "${config.environment}".`);
  process.exit(1);
}
if (apply && remove) {
  console.error("Refusing: pass --apply or --remove, not both.");
  process.exit(1);
}
if (reset && !apply) {
  console.error("Refusing: --reset-passwords goes with --apply.");
  process.exit(1);
}
if ((apply || remove) && named !== config.projectId) {
  console.error(
    `Refusing to write: ${apply ? "--apply" : "--remove"} needs --project=${config.projectId} (the configured GOOGLE_CLOUD_PROJECT).` +
      (named === undefined ? " None was given." : ` Got --project=${named}.`)
  );
  process.exit(1);
}

try {
  const emails = checkDemoEmails(config.demoUserEmails);
  const where = `${config.projectId} / ${config.databaseId}`;
  if (!apply && !remove) {
    console.log(`Dry run on ${where}: would make ${emails.length} operator account(s) (never admin), each with a random password:`);
    for (const e of emails) console.log(`  ${e}`);
    console.log(`Nothing was touched. Create them with: pnpm demo-users -- --apply --project=${config.projectId}`);
  } else {
    initializeApp({ projectId: config.projectId });
    const deps = { auth: getAuth(), db: getFirestore(config.databaseId), usersCollection: config.usersCollection };
    if (apply) {
      const results = await applyDemoUsers(deps, emails, { resetPasswords: reset });
      console.log(`Demo accounts on ${where} (role: operator). Passwords are shown ONCE and kept nowhere:`);
      for (const r of results) {
        console.log(`  ${r.email}  ${r.password ?? "(exists; password unchanged, pass --reset-passwords to replace it)"}  [${r.status}]`);
      }
    } else {
      console.log(`Removed ${await removeDemoUsers(deps, emails)} demo account(s) from ${where}.`);
    }
  }
} catch (err) {
  console.error(`demo-users: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
