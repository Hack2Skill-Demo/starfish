/**
 * The admin API service (#63, #65): `node --import tsx src/adminApiCli.ts`, what the Cloud Run service
 * `starfish-admin` runs (scripts/deploy-gcp.sh, DEPLOY_ADMIN_API=1; written and dry-run tested, never run). The rules
 * are in src/adminApi.ts; this wires them to Firebase Auth, the store and the ingest, and, when Twilio's credentials
 * are mounted, to the phone escalation's opt-in routes and Twilio's webhooks (#37; never run against real Twilio).
 */
import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig, loadTwilioCredentials } from "./config.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { triggerIngest } from "./ingest/trigger.js";
import { retireIncident } from "./ingest/retire.js";
import { createAdminApi } from "./adminApi.js";
import { startAdminApiServer } from "./adminApiServer.js";
import { createTwilioClient } from "./oncall/twilio.js";
import { createTwilioWebhooks } from "./oncall/webhooks.js";
import { confirmNumber, sendConfirmationCode } from "./oncall/optIn.js";
import { readPolicy, stepEscalation } from "./oncall/escalation.js";

const config = loadConfig();
initializeApp({ projectId: config.projectId });
const db = getFirestore(config.databaseId);
const loader = new RuntimeConfigLoader(config);
// Phone escalation (#37): wired only when Twilio's credentials are mounted; otherwise its routes are a 404.
const twilioCredentials = loadTwilioCredentials();
const twilio = twilioCredentials && createTwilioClient({ credentials: twilioCredentials, apiUrl: config.twilioApiUrl });
const owner = `admin-api-${randomUUID().slice(0, 8)}`;

const handle = createAdminApi({
  // A signature and expiry check against Google's public keys, and `checkRevoked` (#141): one Auth lookup per call, so
  // an account that is disabled, or whose tokens were revoked, is cut off at once rather than when its token expires (up
  // to an hour). Any failure here, a lookup that could not be made included, is the one 401 (adminApi.ts).
  verifyToken: async (token) => ({ uid: (await getAuth().verifyIdToken(token, true)).uid }),
  // Cloud Run reads a JSON line on stdout as a structured log entry. The caller still gets only the one 401.
  onRefused: (reason) => console.log(JSON.stringify({ severity: "WARNING", message: "admin API refused a call", reason })),
  // #12: only when STARFISH_ADMIN_API_APPCHECK is on. verifyToken checks the signature, expiry, audience (this project)
  // and issuer; it throws for anything else, which adminApi.ts turns into the one 401.
  ...(config.adminApiRequireAppCheck && {
    verifyAppCheck: async (token: string) => {
      await getAppCheck().verifyToken(token);
    },
  }),
  runIngest: (uid) => triggerIngest(db, config, loader, uid),
  retire: (id, uid, reason) => retireIncident(db, config, id, uid, reason, new Date()),
  allowedOrigins: config.adminApiOrigins,
  ...(twilio &&
    twilioCredentials && {
      sendOnCallCode: (personId: string, uid: string) => sendConfirmationCode(db, config, twilio, personId, uid, new Date()),
      confirmOnCallNumber: (personId: string, code: string, uid: string) => confirmNumber(db, config, personId, code, uid, new Date()),
      twilioWebhooks: createTwilioWebhooks({
        db,
        config,
        authToken: twilioCredentials.authToken,
        twilio,
        now: () => new Date(),
        // After a call ended the next person need not wait for the next agent pass. The runtime settings (dry run, the
        // environment) apply as they do to the agent; unusable settings place nothing.
        kick: async (id) => {
          const resolved = await loader.resolve(db);
          if (!resolved.actionsAllowed) return;
          const policy = await readPolicy(db, resolved.config);
          if (policy) await stepEscalation({ db, config: resolved.config, now: () => new Date(), owner, twilio }, id, policy);
        },
      }),
    }),
});

const server = startAdminApiServer(handle, config.adminApiPort);
console.log(
  `admin api on :${config.adminApiPort}, ${config.adminApiOrigins.length} browser origin(s) allowed, App Check ${config.adminApiRequireAppCheck ? "required" : "not required"}, Twilio ${twilio ? "wired" : "not configured"}`
);
process.on("SIGTERM", () => server.close());
