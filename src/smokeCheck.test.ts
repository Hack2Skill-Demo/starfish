import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeSmoke, SMOKE_FUNCTION, type SmokeIncident } from "./smokeCheck.js";

const T = new Date("2026-10-04T12:00:00Z");
const inc = (over: Partial<SmokeIncident> = {}): SmokeIncident => ({ id: "i1", functionName: SMOKE_FUNCTION, lastOccurredAt: new Date("2026-10-04T12:00:30Z"), retired: false, ...over });

describe("judgeSmoke", () => {
  it("passes for a live smoke incident whose last occurrence is after the plant", () => {
    expect(judgeSmoke([inc()], T)).toEqual({ ok: true, incidentId: "i1" });
    expect(judgeSmoke([inc({ lastOccurredAt: T })], T).ok).toBe(true); // at the plant time counts
  });
  it("fails when there is none, and says the entry was not read", () => {
    const v = judgeSmoke([], T);
    expect(v).toMatchObject({ ok: false });
    expect(!v.ok && v.reason).toMatch(/not read into the store/);
  });
  it("fails for one an earlier run left: its last occurrence is before this plant", () => {
    const v = judgeSmoke([inc({ lastOccurredAt: new Date("2026-10-04T11:00:00Z") })], T);
    expect(!v.ok && v.reason).toMatch(/earlier run left it/);
  });
  it("is not satisfied by another function's incident, a retired one, or one with no time", () => {
    expect(judgeSmoke([inc({ functionName: "orders-create" })], T).ok).toBe(false);
    expect(judgeSmoke([inc({ retired: true })], T).ok).toBe(false);
    expect(judgeSmoke([inc({ lastOccurredAt: null })], T).ok).toBe(false);
  });
  it("finds the fresh one among stale ones", () => {
    const v = judgeSmoke([inc({ id: "old", lastOccurredAt: new Date("2026-10-01T00:00:00Z") }), inc({ id: "new" })], T);
    expect(v).toEqual({ ok: true, incidentId: "new" });
  });
});

describe("readSmokeIncidents' index (#224)", () => {
  it("is declared in firestore.indexes.json: the ordered lookup needs (environment, functionName, lastOccurredAt desc)", () => {
    const file = JSON.parse(readFileSync(new URL("../firestore.indexes.json", import.meta.url), "utf8")) as {
      indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order?: string }[] }[];
    };
    expect(file.indexes).toContainEqual({
      collectionGroup: "incidents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "environment", order: "ASCENDING" },
        { fieldPath: "functionName", order: "ASCENDING" },
        { fieldPath: "lastOccurredAt", order: "DESCENDING" },
      ],
    });
  });
});
