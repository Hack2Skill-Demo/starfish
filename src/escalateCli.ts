/**
 * `pnpm escalate`: one tick of the phone escalation (#37, src/oncall/escalation.ts), apart from an agent pass. The agent
 * pass runs the same tick at its end; this is for a deployment that wants the waits (10 minutes, then 2) kept closer than
 * its agent schedule allows: schedule it more often. scripts/deploy-gcp.sh does not schedule it. Off unless
 * STARFISH_PHONE_ESCALATION and the admin's switch are both on; a dry run places nothing. Never run against real Twilio.
 * Exits 1 when the tick failed or the runtime settings are unusable, 0 otherwise.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig, loadTwilioCredentials } from "./config.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { redactPii } from "./ingest/redact.js";
import { runEscalationTick } from "./oncall/escalation.js";
import { createTwilioClient } from "./oncall/twilio.js";

const base = loadConfig();
const credentials = loadTwilioCredentials();
initializeApp({ projectId: base.projectId });
const db = getFirestore(base.databaseId);
const resolved = await new RuntimeConfigLoader(base).resolve(db);
if (!resolved.actionsAllowed) {
  console.error(`escalate: the runtime settings are unusable and nothing good is known (${resolved.problems.join("; ")}); not acting.`);
  process.exit(1);
}
const cfg = resolved.config;
const twilio = credentials && createTwilioClient({ credentials, apiUrl: cfg.twilioApiUrl });
try {
  const t = await runEscalationTick({ db, config: cfg, now: () => new Date(), owner: `escalate-${hostname()}-${randomUUID().slice(0, 8)}`, ...(twilio && { twilio }) });
  if (t.skipped === "off") console.log("escalate: phone escalation is off (STARFISH_PHONE_ESCALATION); nothing done.");
  else if (t.skipped === "policy-unreadable") console.log("escalate: the on-call policy is invalid or unreadable; nothing done.");
  else {
    console.log(`escalate: ${t.armed} armed, ${t.placed} call(s) placed, ${t.closed} closed${cfg.dryRun ? " (dry run: nothing placed)" : ""}`);
    if (t.scanCapped) console.warn("escalate: the scan of waiting cycles hit its cap; any beyond it are armed on a later tick.");
  }
} catch (err) {
  console.error(`escalate: failed: ${redactPii(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
  process.exit(1);
}
process.exit(0);
