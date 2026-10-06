/**
 * The production query runner for the missing-index probe (probe.ts): the configured query, read-only, limit one, with
 * the Admin SDK against the watched project's database. It never writes. Like the Admin REST adapter, it has never run
 * against a real project: tests use a fake runner.
 */
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Query } from "firebase-admin/firestore";
import type { IndexProbeSpec, ProbeQueryRunner } from "./probe.js";

export function createFirestoreProbeRunner(): ProbeQueryRunner {
  return async (p: IndexProbeSpec) => {
    // One named app per watched project, so the job's own default app (Starfish's project) is never the one queried.
    const name = `starfish-index-probe-${p.project}`;
    const app: App = getApps().find((a) => a.name === name) ?? initializeApp({ projectId: p.project }, name);
    const db = p.database === "(default)" ? getFirestore(app) : getFirestore(app, p.database);
    let q: Query = p.scope === "COLLECTION_GROUP" ? db.collectionGroup(p.collection) : db.collection(p.collection);
    for (const w of p.where) q = q.where(w.field, w.op, w.value);
    for (const o of p.orderBy) q = q.orderBy(o.field, o.direction);
    await q.limit(1).get();
  };
}
