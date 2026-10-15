/**
 * The admin API service (#63, #65): `node --import tsx src/adminApiCli.ts`, what the Cloud Run service
 * `starfish-admin` runs (scripts/deploy-gcp.sh, DEPLOY_ADMIN_API=1; deployed to the demo project 2026-10-07, "Run ingest now" run from the UI). The rules
 * are in src/adminApi.ts; this wires them to Firebase Auth, the store and the ingest, and, when Twilio's credentials
 * are mounted, to the phone escalation's opt-in routes and Twilio's webhooks (#37; never run against real Twilio).
 * When the deploy names the agent job (`STARFISH_AGENT_JOB`), also to "Run agent now" (#276): it starts that job
 * through Cloud Run and holds none of the agent's credentials (never run against real Cloud Run).
 * Where the public demo's open actions are on (`STARFISH_PUBLIC_DEMO_ACTIONS` on a public environment, src/publicDemo.ts),
 * also to those, for anonymous callers, and it writes their reads' gate document as it starts (never run on a real project).
 */
// First, so its uptime mark is taken before any other module's code runs (#275, src/startupLog.ts).
import { logStartup } from "./startupLog.js";
import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig, loadTwilioCredentials } from "./config.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { triggerIngest } from "./ingest/trigger.js";
import { retireIncident } from "./ingest/retire.js";
import { createAgentJobStarter } from "./agent/agentJob.js";
import { triggerAgentPass } from "./agent/trigger.js";
import { createAdminApi } from "./adminApi.js";
import { isAdmin } from "./adminAuth.js";
import { startAdminApiServer } from "./adminApiServer.js";
import { createIpRateLimiter } from "./ipRateLimit.js";
import { createTwilioClient } from "./oncall/twilio.js";
import { createTwilioWebhooks } from "./oncall/webhooks.js";
import { confirmNumber, sendConfirmationCode } from "./oncall/optIn.js";
import { readPolicy, stepEscalation } from "./oncall/escalation.js";
import {
  correctTriageAsGuest,
  publicDemoActionsOn,
  requestRetriageAsGuest,
  setIncidentStatusAsGuest,
  syncPublicAccess,
  triggerAgentPassAsGuest,
  triggerIngestAsGuest,
} from "./publicDemo.js";
import { claimPublicAction } from "./publicDemoLimit.js";

// #275: how long the service takes to start, Cloud Run's side against loading modules.
logStartup("admin-api");
const config = loadConfig();
initializeApp({ projectId: config.projectId });
const db = getFirestore(config.databaseId);
const loader = new RuntimeConfigLoader(config);
// Phone escalation (#37): wired only when Twilio's credentials are mounted; otherwise its routes are a 404.
const twilioCredentials = loadTwilioCredentials();
const twilio = twilioCredentials && createTwilioClient({ credentials: twilioCredentials, apiUrl: config.twilioApiUrl });
const owner = `admin-api-${randomUUID().slice(0, 8)}`;
// "Run agent now" (#276): wired only when the deploy names the agent job; otherwise its route is a 404. A name that
// is not a job name throws here, at startup, rather than on an admin's first click.
const startAgentJob = config.agentJobName
  ? createAgentJobStarter({ projectId: config.projectId, region: config.agentJobRegion, jobName: config.agentJobName })
  : null;
/** Start the agent job, logging why Cloud Run refused (an HTTP status and a hint, never a token: agentJob.ts). */
const startAgent = async (start: () => Promise<void>): Promise<void> => {
  try {
    await start();
  } catch (e) {
    console.log(JSON.stringify({ severity: "ERROR", message: "admin API could not start the agent job", reason: e instanceof Error ? e.message : "unknown" }));
    throw e;
  }
};
// The public demo's open actions: only where the deployment turned them on, on a public environment.
const publicDemoOn = publicDemoActionsOn(config);
// Their reads' gate (firestore.rules reads it): written as the service starts, on or off. A failure leaves the gate as
// it was and is logged; the service still serves.
syncPublicAccess(db, config, new Date()).then(
  (r) => console.log(JSON.stringify({ severity: "INFO", message: "public demo reads gate", publicDemoActions: publicDemoOn, gate: r })),
  (e: unknown) => console.log(JSON.stringify({ severity: "ERROR", message: "could not write the public demo reads gate", reason: e instanceof Error ? e.message : "unknown" }))
);

const handle = createAdminApi({
  // A signature and expiry check against Google's public keys, and `checkRevoked` (#141): one Auth lookup per call, so
  // an account that is disabled, or whose tokens were revoked, is cut off at once rather than when its token expires (up
  // to an hour). Any failure here, a lookup that could not be made included, is the one 401 (adminApi.ts).
  // `anonymous` is the token's own sign-in provider (an anonymous Firebase Auth session: the public demo's guest).
  verifyToken: async (token) => {
    const decoded = await getAuth().verifyIdToken(token, true);
    return { uid: decoded.uid, anonymous: decoded.firebase?.sign_in_provider === "anonymous" };
  },
  // Cloud Run reads a JSON line on stdout as a structured log entry. The caller still gets only the one 401.
  onRefused: (reason) => console.log(JSON.stringify({ severity: "WARNING", message: "admin API refused a call", reason })),
  // #12: only when STARFISH_ADMIN_API_APPCHECK is on. verifyToken checks the signature, expiry, audience (this project)
  // and issuer; it throws for anything else, which adminApi.ts turns into the one 401.
  ...(config.adminApiRequireAppCheck && {
    verifyAppCheck: async (token: string) => {
      await getAppCheck().verifyToken(token);
    },
  }),
  // #305: the role is read before any route takes its lock; each action reads it again itself.
  isAdmin: (uid) => isAdmin(db, config.usersCollection, uid),
  runIngest: (uid) => triggerIngest(db, config, loader, uid),
  retire: (id, uid, reason) => retireIncident(db, config, id, uid, reason, new Date()),
  ...(startAgentJob && {
    runAgent: (uid: string) =>
      // The caller gets only a 502 when the start fails; why is in the service's log.
      triggerAgentPass(db, config, () => startAgent(startAgentJob), uid),
  }),
  ...(publicDemoOn && {
    publicDemo: {
      claim: (kind, key) => claimPublicAction(db, config, kind, key, new Date()),
      setStatus: (id, action, uid) => setIncidentStatusAsGuest(db, config, id, action, uid, new Date()),
      requestRetriage: (id, uid) => requestRetriageAsGuest(db, config, id, uid, new Date()),
      correct: (id, level, note, uid) => correctTriageAsGuest(db, config, id, level, note, uid, new Date()),
      runIngest: (uid) => triggerIngestAsGuest(db, config, loader, uid),
      ...(startAgentJob && { runAgent: (uid: string) => triggerAgentPassAsGuest(db, config, () => startAgent(startAgentJob), uid) }),
    },
  }),
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
        // environment) apply as they do to the agent; unusable settings place nothing. A kick places a due call only when
        // THIS service's own switches allow it, and never closes a sequence because they don't (#225): the deploy does
        // not give this service the agent's dry run or phone switch, so the agent's next tick decides those.
        kick: async (id) => {
          const resolved = await loader.resolve(db);
          if (!resolved.actionsAllowed) return;
          const policy = await readPolicy(db, resolved.config);
          if (policy) await stepEscalation({ db, config: resolved.config, now: () => new Date(), owner, twilio }, id, policy, { kick: true });
        },
      }),
    }),
});

const server = startAdminApiServer(handle, config.adminApiPort, {
  limiter: createIpRateLimiter({ perMinute: config.adminApiRateLimitPerMinute }),
  // Once per address per minute, not per refused request: a flood must not become a Cloud Logging bill instead.
  onLimited: (key) => console.log(JSON.stringify({ severity: "WARNING", message: "admin API rate limit reached", key })),
});
console.log(
  `admin api on :${config.adminApiPort}, ${config.adminApiRateLimitPerMinute} requests a minute per address, ${config.adminApiOrigins.length} browser origin(s) allowed, App Check ${config.adminApiRequireAppCheck ? "required" : "not required"}, Twilio ${twilio ? "wired" : "not configured"}, agent job ${startAgentJob ? config.agentJobName : "not named"}, public demo actions ${publicDemoOn ? `on (${config.publicActionsPerIpPerHour} actions and ${config.publicRunsPerIpPerHour} runs an hour per address, ${config.publicAgentRunsPerHour} agent passes an hour in all)` : "off"}`
);
process.on("SIGTERM", () => server.close());
