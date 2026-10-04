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
  await db.doc(`incidents/seed-${i}`).set({
    environment: "demo", fingerprint: `seed${i}`, triageState: "pending", sourceProjectId: "demo-starfish",
    createdAt: inc.firstOccurredAt, updatedAt: inc.lastOccurredAt, ...inc,
  });
}
// What the engine writes after a run (src/ingest/run.ts), so the status line has something to show.
await db.doc("starfish_runs/last_run").set({
  environment: "demo", outcome: "ok", startedAt: ts(0.21), finishedAt: ts(0.2), windows: 1, capped: false,
  totals: { entriesProcessed: 12, incidentsCreated: 1, incidentsUpdated: 3, incidentsRecurred: 0, incidentsReplayed: 0 },
  configSource: "env", actionsAllowed: true, problems: [],
});
// Agent cycles and their run events (src/agent/cycle.ts), so the Runs page has something to show:
// one that ended at triage (every later step "not reached"), one still running, one waiting for a
// person with a pull request. Illustrative data for the emulator only: no job runs the loop yet.
const SEED_PATCH = "0123456789abcdef".repeat(4);
const cycles = [
  {
    id: "seed-0_r0", state: "declined", path: "decline", outcome: "declined by triage", ageMin: 50,
    events: [
      ["cycle", "started", "Attempt 1", 0, { attempt: 1 }],
      ["triage", "decision", "Declined: the error comes from a dependency, not this code", 0.4, { rule: "upstream-fault" }, { decision: "decline", rule: "upstream-fault" }],
    ],
  },
  {
    id: "seed-1_r0", state: "running", ageMin: 3, live: true,
    events: [
      ["cycle", "started", "Attempt 1", 0, { attempt: 1 }],
      ["triage", "decision", "Act: a null dereference in the order handler", 0.5, { rule: "model-act" }, { decision: "act", rule: "model-act" }],
      ["fix", "proposed", "Proposed a two-line guard and a test", 1.8, {}, { outcome: "proposed" }],
    ],
  },
  {
    id: "seed-2_r0", state: "waiting-human", path: "pr", outcome: "pull request opened", ageMin: 20,
    events: [
      ["cycle", "started", "Attempt 1", 0, { attempt: 1 }],
      ["triage", "decision", "Act: a missing await on a Firestore write", 0.4, { rule: "model-act" }, { decision: "act", rule: "model-act" }],
      ["fix", "proposed", "Proposed a one-line fix and a test", 1.5, {}, { outcome: "proposed" }],
      ["verify", "passed", "The configured command passed on the patched tree", 2.6, {}, { status: "passed", rule: "passed", patchSha256: SEED_PATCH }],
      ["review", "approved", "The reviewer found nothing it could hold against the patch", 3.4, {}, { verdict: "approved", rule: "survived", patchSha256: SEED_PATCH }],
      ["pr", "opened", "Opened a pull request", 3.9, {}, { opened: true, number: 42, url: "https://github.com/example/app/pull/42", patchSha256: SEED_PATCH }],
    ],
  },
];
for (const c of cycles) {
  const start = Date.now() - c.ageMin * 60_000;
  const at = (min) => Timestamp.fromMillis(start + min * 60_000);
  const last = c.events[c.events.length - 1][3];
  await db.doc(`starfish_cycles/${c.id}`).set({
    incidentId: c.id.replace(/_r\d+$/, ""), environment: "demo", recurrence: 0, state: c.state, attempts: 1,
    eventCount: c.events.length, createdAt: at(0), updatedAt: at(last), stage: c.events[c.events.length - 1][0],
    leaseExpiresAt: c.live ? Timestamp.fromMillis(Date.now() + 10 * 60_000) : null,
    deadlineAt: at(30), ...(c.path && { path: c.path }), ...(c.outcome && { outcome: c.outcome }),
    summary: Object.fromEntries(c.events.filter((e) => e[5]).map((e) => [e[0], e[5]])),
  });
  for (const [i, [stage, type, summary, min, data]] of c.events.entries()) {
    await db.doc(`starfish_cycles/${c.id}/events/${String(i + 1).padStart(6, "0")}`).set({
      seq: i + 1, environment: "demo", at: at(min), stage, type, summary, data,
    });
  }
}
console.log(`seed-emulator: ${users.length} users (password "starfish"), ${incidents.length} incidents, ${cycles.length} cycles`);
