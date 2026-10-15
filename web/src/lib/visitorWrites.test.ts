/**
 * Where a triage write goes: Firestore for an operator (firestore.rules are the gate), the admin API for a public demo
 * visitor where the open actions are on (src/publicDemo.ts), and never Firestore for that visitor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateDoc = vi.hoisted(() => vi.fn(async () => {}));
const api = vi.hoisted(() => ({
  setIncidentStatusAsVisitor: vi.fn(async () => ({ ok: true as const, value: null })),
  requestRetriageAsVisitor: vi.fn(async () => ({ ok: true as const, value: null })),
}));
const auth = vi.hoisted(() => ({ currentUser: null as null | { isAnonymous: boolean } }));
const flag = vi.hoisted(() => ({ on: false }));
vi.mock("firebase/firestore", async (orig) => ({ ...(await orig<typeof import("firebase/firestore")>()), updateDoc, doc: vi.fn(() => ({})) }));
vi.mock("./firebase", () => ({ firestore: vi.fn(), firebaseAuth: () => auth }));
vi.mock("./config", () => ({ webConfig: () => ({ environment: "demo", adminApiUrl: "https://admin.example", incidentCollection: "incidents", publicDemoActions: flag.on }) }));
vi.mock("./adminApi", () => ({ ...api, appAdminApi: () => ({}) }));

import { applyAction, requestRetriage, type IncidentRow } from "./incidents";

const row = { id: "inc-1", status: "new" } as IncidentRow;

beforeEach(() => {
  vi.clearAllMocks();
  flag.on = false;
  auth.currentUser = { isAnonymous: true };
});

describe("triage writes", () => {
  it("with the open actions off, write Firestore (where the rules refuse a guest), never the admin API", async () => {
    await applyAction(row, "acknowledge", "guest");
    await requestRetriage("inc-1", "guest");
    expect(updateDoc).toHaveBeenCalledTimes(2);
    expect(api.setIncidentStatusAsVisitor).not.toHaveBeenCalled();
    expect(api.requestRetriageAsVisitor).not.toHaveBeenCalled();
  });

  it("with them on, a guest's go to the admin API and never to Firestore; a refusal's message is thrown", async () => {
    flag.on = true;
    await applyAction(row, "resolve", "guest");
    await requestRetriage("inc-1", "guest");
    expect(api.setIncidentStatusAsVisitor).toHaveBeenCalledWith({}, "inc-1", "resolve");
    expect(api.requestRetriageAsVisitor).toHaveBeenCalledWith({}, "inc-1");
    expect(updateDoc).not.toHaveBeenCalled();
    api.requestRetriageAsVisitor.mockResolvedValueOnce({ ok: false, message: "The public demo's hourly limit for your address is reached." } as never);
    await expect(requestRetriage("inc-1", "guest")).rejects.toThrow("hourly limit");
  });

  it("with them on, an operator still writes Firestore", async () => {
    flag.on = true;
    auth.currentUser = { isAnonymous: false };
    await applyAction(row, "acknowledge", "op1");
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(api.setIncidentStatusAsVisitor).not.toHaveBeenCalled();
  });
});
