#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

/** Create only: never silently change the password/privileges of an existing user. */
export async function provisionUser(auth, db, { email, role, collection = "starfish_users" }) {
  if (!["admin", "operator", "viewer"].includes(role)) throw new Error("Role must be admin, operator or viewer");
  if (typeof email !== "string" || !email.trim()) throw new Error("Email is required");
  if (!collection || collection.includes("/")) throw new Error("Users collection must be one collection name");
  const user = await auth.createUser({ email: email.trim(), password: randomBytes(32).toString("base64url") });
  try {
    await db.collection(collection).doc(user.uid).create({ roles: [role] });
  } catch (error) {
    // We own this newly created identity. Do not leave a half-provisioned login.
    try {
      await auth.deleteUser(user.uid);
    } catch {
      throw new Error(`Role creation failed and account cleanup failed; remove newly created UID ${user.uid} through the trusted admin console.`);
    }
    throw error;
  }
  return user.uid;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      project: { type: "string" }, database: { type: "string", default: "starfish" },
      email: { type: "string" }, role: { type: "string" },
      "users-collection": { type: "string", default: "starfish_users" },
    } });
    if (!values.project) throw new Error("Explicit --project is required; use Starfish's own project");
    const app = initializeApp({ projectId: values.project });
    const uid = await provisionUser(getAuth(app), getFirestore(app, values.database), {
      email: values.email, role: values.role, collection: values["users-collection"],
    });
    console.log(`Created ${values.role} ${uid} in ${values.project}/${values.database}. Use Forgot password on the sign-in page to set the initial password. No email has been sent by this script.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Account provisioning failed");
    process.exitCode = 1;
  }
}
