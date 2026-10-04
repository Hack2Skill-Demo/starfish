/**
 * RuntimeConfigLoader against the real Firestore emulator: what the fake can't
 * show, namely that a document an admin writes (with a server Timestamp) round
 * trips through validation, and that the saved last-good copy outlives the
 * instance that wrote it. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { DEFAULT_IGNORED_MESSAGES, DEFAULT_LOG_RESOURCE_TYPES, type StarfishConfig } from "./config.js";
import { LAST_GOOD_DOC, RuntimeConfigLoader, SETTINGS_DOC } from "./runtimeSettings.js";

// Never let this suite reach a real project with ambient credentials.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("runtimeSettings.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "settings-emulator-tests");
const db: Firestore = getFirestore(app, "settings-tests");
afterAll(() => deleteApp(app));

let base: StarfishConfig;
beforeEach(() => {
  base = {
    projectId: "starfish-home",
    watchedProjectId: "starfish-home",
    vertexProjectId: "starfish-home",
    location: "us-central1",
    model: "m",
    environment: "dev",
    incidentCollection: "incidents",
    incidentKeyCollection: "incident_keys",
    // Its own collection per test, so tests never see each other's documents.
    settingsCollection: `settings_${randomUUID().slice(0, 8)}`,
    databaseId: "starfish",
    servicePatterns: {},
    defaultLookbackHours: 24,
    verifyCommand: "",
    verifyTimeoutSeconds: 600,
    patchExcludedPaths: [],
    ingestLagMinutes: 5,
    ingestMaxWindowHours: 6,
    runCollection: "starfish_runs",
    logResourceTypes: [...DEFAULT_LOG_RESOURCE_TYPES],
    ignoredMessages: [...DEFAULT_IGNORED_MESSAGES],
  };
});

const doc = (id: string) => db.collection(base.settingsCollection).doc(id);

describe("RuntimeConfigLoader on the emulator", () => {
  it("applies a document written the way the UI writes it, server timestamp included", async () => {
    await doc(SETTINGS_DOC).set({
      version: 1,
      watchedProjectId: "watched-app-1",
      environment: "prod",
      logResourceTypes: ["cloud_run_revision"],
      servicePatterns: { Billing: "payments" },
      ignoredMessages: [],
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: "admin-uid",
    });

    const r = await new RuntimeConfigLoader(base).resolve(db);

    expect(r).toMatchObject({ source: "settings", problems: [], actionsAllowed: true });
    expect(r.config).toMatchObject({
      watchedProjectId: "watched-app-1",
      environment: "prod",
      logResourceTypes: ["cloud_run_revision"],
      servicePatterns: { billing: "payments" },
      ignoredMessages: [],
    });
  });

  it("a fresh instance falls back to the last good copy when the document is later broken", async () => {
    await doc(SETTINGS_DOC).set({ version: 1, environment: "prod" });
    await new RuntimeConfigLoader(base).resolve(db);
    await doc(SETTINGS_DOC).set({ version: 1, environment: "prod", logResourceTypes: [] });

    const r = await new RuntimeConfigLoader(base).resolve(db);

    expect(r).toMatchObject({ source: "last-good", actionsAllowed: true });
    expect(r.config.environment).toBe("prod");
    expect(r.problems[0]).toContain("logResourceTypes");
  });

  it("deleting the document resets to the defaults and removes the saved copy", async () => {
    await doc(SETTINGS_DOC).set({ version: 1, environment: "prod" });
    await new RuntimeConfigLoader(base).resolve(db);
    expect((await doc(LAST_GOOD_DOC).get()).exists).toBe(true);
    await doc(SETTINGS_DOC).delete();

    const r = await new RuntimeConfigLoader(base).resolve(db);

    expect(r).toMatchObject({ source: "env", actionsAllowed: true });
    expect(r.config.environment).toBe("dev");
    expect((await doc(LAST_GOOD_DOC).get()).exists).toBe(false);
  });
});
