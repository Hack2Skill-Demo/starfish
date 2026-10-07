/**
 * `pnpm smoke-check --since <ISO time> [--cleanup --actor <admin uid>]`: did the engine read the error the smoke test
 * planted, and (with --cleanup) leave no live `starfish-smoke` incident behind (#91).
 *
 * Exit 0 only when the planted incident was found (and, with --cleanup, every live smoke incident was retired and the
 * retirement read back). A cleanup that fails says which incident to delete and exits 1: a pass is never reported
 * over a leftover. --actor is the uid of an admin operator (`pnpm grant-operator`); retiring is admin-only and audited
 * (src/ingest/retire.ts). The lookup is bounded: one environment, one function name, at most 20 documents.
 */
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadConfig } from "./config.js";
import { retireIncident } from "./ingest/retire.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { judgeSmoke, SMOKE_FUNCTION, type SmokeIncident } from "./smokeCheck.js";

const { values } = parseArgs({
  options: { since: { type: "string" }, cleanup: { type: "boolean", default: false }, actor: { type: "string" } },
  allowPositionals: false,
});
const plantedAt = new Date(values.since ?? "");
if (Number.isNaN(plantedAt.getTime())) {
  console.error("smoke-check: --since must be the ISO time the error was planted");
  process.exit(2);
}
if (values.cleanup && !values.actor) {
  console.error("smoke-check: --cleanup needs --actor <admin uid>");
  process.exit(2);
}

const base = loadConfig();
initializeApp({ projectId: base.projectId });
const db = getFirestore(base.databaseId);
// The engine files incidents under the runtime settings' environment (src/ingest/run.ts), not necessarily the env var's.
const config = (await new RuntimeConfigLoader(base).resolve(db)).config;

const snap = await db
  .collection(config.incidentCollection)
  .where("environment", "==", config.environment)
  .where("functionName", "==", SMOKE_FUNCTION)
  .limit(20)
  .get();
const incidents: SmokeIncident[] = snap.docs.map((d) => {
  const data = d.data();
  const last = (data.lastOccurredAt as { toDate?: () => Date } | undefined)?.toDate?.();
  return { id: d.id, functionName: String(data.functionName), lastOccurredAt: last ?? null, retired: data.retired === true };
});

const verdict = judgeSmoke(incidents, plantedAt);
console.log(verdict.ok ? `smoke-check: found the planted incident ${verdict.incidentId}` : `smoke-check: FAILED: ${verdict.reason}`);

let leftovers: string[] = [];
const live = incidents.filter((i) => !i.retired);
if (values.cleanup) {
  for (const i of live) {
    const r = await retireIncident(db, config, i.id, values.actor!, "smoke test cleanup", new Date()).catch(() => ({ ok: false as const }));
    const after = r.ok ? (await db.collection(config.incidentCollection).doc(i.id).get()).data() : undefined;
    if (!r.ok || after?.retired !== true) leftovers.push(i.id);
  }
  if (leftovers.length > 0) {
    console.error(`smoke-check: CLEANUP FAILED: delete these incident documents in the Firestore console: ${leftovers.join(", ")}`);
  } else {
    console.log(`smoke-check: retired ${live.length} ${SMOKE_FUNCTION} incident(s); none is left in any list`);
  }
} else if (live.length > 0) {
  leftovers = live.map((i) => i.id);
  console.log(`smoke-check: ${live.length} ${SMOKE_FUNCTION} incident(s) remain in the store (pass --cleanup --actor <uid>, or delete them in the console before showing the public demo)`);
}
process.exit(verdict.ok && !(values.cleanup && leftovers.length > 0) ? 0 : 1);
