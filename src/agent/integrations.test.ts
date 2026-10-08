import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { INTEGRATIONS_DOC, recordIntegrations } from "./integrations.js";

function fakeDb(fail = false) {
  const writes: { collection: string; id: string; data: Record<string, unknown> }[] = [];
  const db = {
    collection: (collection: string) => ({
      doc: (id: string) => ({
        set: async (data: Record<string, unknown>) => {
          if (fail) throw new Error("permission denied");
          writes.push({ collection, id, data });
        },
      }),
    }),
  } as unknown as Firestore;
  return { db, writes };
}

const cfg = { runCollection: "runs_x", environment: "demo" };

describe("recordIntegrations", () => {
  it("writes only the environment, the time and four booleans", async () => {
    const { db, writes } = fakeDb();
    const now = new Date("2026-10-08T10:00:00.000Z");
    expect(await recordIntegrations(db, cfg, { github: true, slackOnCall: false, slackAlerts: false, twilio: false }, now)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ collection: "runs_x", id: INTEGRATIONS_DOC });
    expect(Object.keys(writes[0]!.data).sort()).toEqual(["checkedAt", "environment", "github", "slackAlerts", "slackOnCall", "twilio"]);
    expect(writes[0]!.data).toMatchObject({ environment: "demo", github: true, slackOnCall: false });
  });

  it("never throws: a failed write is reported as false", async () => {
    const { db } = fakeDb(true);
    expect(await recordIntegrations(db, cfg, { github: true, slackOnCall: true, slackAlerts: true, twilio: true })).toBe(false);
  });
});
