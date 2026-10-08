/**
 * readSmokeIncidents against the real Firestore emulator (#224): the retired incidents earlier smoke runs leave behind
 * must not crowd the fresh one out of the bounded lookup. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { judgeSmoke, readSmokeIncidents, SMOKE_FUNCTION, SMOKE_LOOKUP_LIMIT } from "./smokeCheck.js";

// Never let this suite reach a real project with ambient credentials.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("smokeCheck.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "smoke-emulator-tests");
const db: Firestore = getFirestore(app, "smoke-tests");
afterAll(() => deleteApp(app));

const plantedAt = new Date("2026-10-08T12:00:00.000Z");
const minutes = (m: number) => Timestamp.fromMillis(plantedAt.getTime() + m * 60_000);

let config: { incidentCollection: string; environment: string };
beforeEach(() => {
  config = { incidentCollection: `incidents_${randomUUID().slice(0, 8)}`, environment: "demo" };
});

const seed = (id: string, over: Record<string, unknown>) =>
  db.collection(config.incidentCollection).doc(id).set({ environment: "demo", functionName: SMOKE_FUNCTION, retired: false, ...over });

describe("readSmokeIncidents on the emulator", () => {
  it("finds this plant's incident behind more retired ones from earlier runs than one read takes", async () => {
    // Ids that sort before the fresh one, as an unordered read returns them: it took these and stopped.
    for (let i = 0; i < SMOKE_LOOKUP_LIMIT + 5; i++) {
      await seed(`a${String(i).padStart(2, "0")}`, { retired: true, lastOccurredAt: minutes(-60 * 24 * (i + 1)) });
    }
    await seed("z-fresh", { lastOccurredAt: minutes(1) });
    // Not the smoke function, or not this environment: never read.
    await seed("b-other-fn", { functionName: "orders-create", lastOccurredAt: minutes(2) });
    await seed("b-other-env", { environment: "prod", lastOccurredAt: minutes(2) });

    const incidents = await readSmokeIncidents(db, config);

    expect(incidents).toHaveLength(SMOKE_LOOKUP_LIMIT);
    expect(incidents[0]).toEqual({ id: "z-fresh", functionName: SMOKE_FUNCTION, lastOccurredAt: minutes(1).toDate(), retired: false });
    expect(incidents.every((i) => i.functionName === SMOKE_FUNCTION)).toBe(true);
    expect(incidents.map((i) => i.id)).not.toContain("b-other-env");
    expect(judgeSmoke(incidents, plantedAt)).toEqual({ ok: true, incidentId: "z-fresh" });
  });

  it("still reads a live one an earlier cleanup left, so it is retired too", async () => {
    for (let i = 0; i < 10; i++) await seed(`a${i}`, { retired: true, lastOccurredAt: minutes(-60 * 24 * (i + 2)) });
    await seed("z-leftover", { lastOccurredAt: minutes(-60 * 24) });
    await seed("z-fresh", { lastOccurredAt: minutes(1) });

    const live = (await readSmokeIncidents(db, config)).filter((i) => !i.retired).map((i) => i.id);

    expect(live).toEqual(["z-fresh", "z-leftover"]);
  });
});
