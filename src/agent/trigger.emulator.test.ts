/**
 * triggerAgentPass against the real Firestore emulator: who may start an agent pass, what is recorded, and in what
 * order. The job start is a stub (no Cloud Run here). Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { testConfig } from "../testConfig.js";
import { triggerAgentPass } from "./trigger.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("agent/trigger.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "agent-trigger-emulator-tests");
const db: Firestore = getFirestore(app, "agent-trigger-tests");
afterAll(() => deleteApp(app));

const now = new Date("2026-10-10T16:05:00.000Z");

let config: StarfishConfig;
beforeEach(async () => {
  const run = randomUUID().slice(0, 8);
  config = testConfig({ projectId: "demo-starfish-rules", usersCollection: `users_${run}`, auditCollection: `audit_${run}`, databaseId: "agent-trigger-tests" });
  await db.collection(config.usersCollection).doc("admin1").set({ roles: ["admin"] });
  await db.collection(config.usersCollection).doc("op1").set({ roles: ["operator"] });
});

const audit = async () => (await db.collection(config.auditCollection).get()).docs.map((d) => d.data());

describe("triggerAgentPass", () => {
  it("starts the job once for an admin, and records who asked and when", async () => {
    let starts = 0;
    const r = await triggerAgentPass(db, config, async () => void starts++, "admin1", now);

    expect(r).toEqual({ ok: true });
    expect(starts).toBe(1);
    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "run-agent", actorUid: "admin1" });
    expect(entries[0]!.at.toMillis()).toBe(now.getTime());
  });

  it("refuses an operator, an unknown uid and a malformed one: nothing starts and nothing is recorded", async () => {
    let starts = 0;
    const start = async () => void starts++;
    expect(await triggerAgentPass(db, config, start, "op1", now)).toEqual({ ok: false, reason: "not-admin" });
    expect(await triggerAgentPass(db, config, start, "stranger", now)).toEqual({ ok: false, reason: "not-admin" });
    expect(await triggerAgentPass(db, config, start, "../admin1", now)).toEqual({ ok: false, reason: "invalid-id" });
    expect(starts).toBe(0);
    expect(await audit()).toEqual([]);
  });

  it("writes the audit entry before the start, so a start that fails is still on record", async () => {
    let auditedAtStart = -1;
    const failing = async () => {
      auditedAtStart = (await audit()).length;
      throw new Error("Cloud Run answered 403");
    };
    await expect(triggerAgentPass(db, config, failing, "admin1", now)).rejects.toThrow("403");
    expect(auditedAtStart).toBe(1);
    expect(await audit()).toHaveLength(1);
  });
});
