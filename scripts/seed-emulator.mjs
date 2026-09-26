#!/usr/bin/env node
/**
 * Seed the local emulators so the operator UI can be tried with no GCP project:
 * two operators (admin, operator), one user with no role, and a handful of
 * incidents shaped exactly like the ones the engine writes (src/ingest/store.ts).
 *
 * Refuses to run unless both emulator hosts are set, so it can never write to a
 * real project. Run via `pnpm dev:emulated`.
 */
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error("seed-emulator: emulator hosts not set — refusing to touch a real project.");
  process.exit(1);
}

initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-starfish" });
const auth = getAuth();
// Same named database the engine and UI default to (STARFISH_DATABASE_ID).
const db = getFirestore(process.env.STARFISH_DATABASE_ID || "starfish");

const users = [
  { uid: "admin", email: "admin@starfish.local", roles: ["admin"] },
  { uid: "operator", email: "operator@starfish.local", roles: ["operator"] },
  { uid: "viewer", email: "viewer@starfish.local", roles: ["viewer"] },
  { uid: "nobody", email: "nobody@starfish.local", roles: [] },
];
for (const u of users) {
  await auth.createUser({ uid: u.uid, email: u.email, password: "starfish" }).catch(() => {});
  await db.doc(`starfish_users/${u.uid}`).set({ roles: u.roles });
}

const HOUR = 3600_000;
const now = Date.now();
const bucket = (hoursAgo, n) => ({ [String(Math.floor((now - hoursAgo * HOUR) / HOUR))]: n });
const ts = (hoursAgo) => Timestamp.fromMillis(now - hoursAgo * HOUR);

const incidents = [
  {
    functionName: "mailQueueDrainer", service: "mail", errorType: "UnknownError", errorName: "EmailGatewayTokenError",
    errorMessage: "Email gateway token could not be decrypted",
    errorDetail: "the configured EMAIL_GATEWAY_TOKEN_ENCRYPTION_KEY does not match the stored token",
    occurrenceCount: 35, occurrencesByHour: bucket(9, 35), firstOccurredAt: ts(9), lastOccurredAt: ts(9), status: "new",
    stackTrace: "Error: Email gateway token could not be decrypted\n    at decryptToken (lib/crypto.ts:41:11)\n    at drain (scheduled/drainer.ts:88:5)",
  },
  {
    functionName: "reportsHourlyJob", service: "reports", errorType: "DatabaseError",
    errorMessage: 'Cannot use "undefined" as a Firestore value (found in field "normalizedReason")',
    occurrenceCount: 46, occurrencesByHour: { ...bucket(3, 40), ...bucket(2, 6) }, firstOccurredAt: ts(3), lastOccurredAt: ts(2), status: "acknowledged",
  },
  {
    functionName: "search-indexDocument", service: "search", errorType: "AuthError", httpStatus: 403,
    errorMessage: "Vertex AI embedding API: 403 — API has not been used in this project or it is disabled",
    occurrenceCount: 175, occurrencesByHour: bucket(20, 175), firstOccurredAt: ts(22), lastOccurredAt: ts(20), status: "logged",
    githubIssueNumber: 54, githubIssueUrl: "https://github.com/example/app/issues/54",
    githubPrNumber: 60, githubPrUrl: "https://github.com/example/app/pull/60", githubPrState: "open",
  },
  {
    functionName: "orders-updateSubscription", service: "billing", errorType: "MonitoringError",
    errorMessage: "Cloud Monitoring reported failed invocations, but no matching Cloud Logging ERROR entry was found",
    occurrenceCount: 4, occurrencesByHour: bucket(30, 4), firstOccurredAt: ts(30), lastOccurredAt: ts(30), status: "ignored",
  },
  {
    functionName: "auth-resetPassword", service: "api", errorType: "UnavailableError", errorCode: "unavailable",
    errorMessage: "resetPassword: Sign-in is temporarily unavailable. Please try again.",
    occurrenceCount: 2, occurrencesByHour: bucket(17, 1), firstOccurredAt: ts(40), lastOccurredAt: ts(17), status: "resolved",
  },
];
for (const [i, inc] of incidents.entries()) {
  const record = {
    environment: "demo", fingerprint: `seed${i}`, triageState: "pending", sourceProjectId: "demo-starfish",
    createdAt: inc.firstOccurredAt, updatedAt: inc.lastOccurredAt, ...inc,
  };
  await db.doc(`incidents/seed-${i}`).set(record);
  // These fixtures are synthetic. Never copy live incidents into the demo feed.
  await db.doc(`demo_incidents/seed-${i}`).set(record);
}
console.log(`seed-emulator: ${users.length} users (password "starfish"), ${incidents.length} incidents`);
