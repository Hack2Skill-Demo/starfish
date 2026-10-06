/**
 * The admin API service (#63, #65): `node --import tsx src/adminApiCli.ts`, what the Cloud Run service
 * `starfish-admin` runs (scripts/deploy-gcp.sh, DEPLOY_ADMIN_API=1; written and dry-run tested, never run). The rules
 * are in src/adminApi.ts; this wires them to Firebase Auth, the store and the ingest.
 */
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { triggerIngest } from "./ingest/trigger.js";
import { retireIncident } from "./ingest/retire.js";
import { createAdminApi } from "./adminApi.js";
import { startAdminApiServer } from "./adminApiServer.js";

const config = loadConfig();
initializeApp({ projectId: config.projectId });
const db = getFirestore(config.databaseId);
const loader = new RuntimeConfigLoader(config);

const handle = createAdminApi({
  // A signature and expiry check against Google's public keys, and `checkRevoked` (#141): one Auth lookup per call, so
  // an account that is disabled, or whose tokens were revoked, is cut off at once rather than when its token expires (up
  // to an hour). Any failure here, a lookup that could not be made included, is the one 401 (adminApi.ts).
  verifyToken: async (token) => ({ uid: (await getAuth().verifyIdToken(token, true)).uid }),
  runIngest: (uid) => triggerIngest(db, config, loader, uid),
  retire: (id, uid, reason) => retireIncident(db, config, id, uid, reason, new Date()),
  allowedOrigins: config.adminApiOrigins,
});

const server = startAdminApiServer(handle, config.adminApiPort);
console.log(`admin api on :${config.adminApiPort}, ${config.adminApiOrigins.length} browser origin(s) allowed`);
process.on("SIGTERM", () => server.close());
