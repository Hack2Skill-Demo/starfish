import { describe, it, expect, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

const entries: unknown[] = [];
vi.mock("@google-cloud/logging", () => ({
  Logging: class {
    getEntries = async () => [entries];
  },
}));

const { aggregateErrors } = await import("./aggregate.js");
const { DEFAULT_IGNORED_MESSAGES, DEFAULT_LOG_RESOURCE_TYPES } = await import("../config.js");

const config = {
  projectId: "p",
  location: "l",
  model: "m",
  environment: "prod",
  incidentCollection: "incidents",
  databaseId: "starfish",
  servicePatterns: {},
  defaultLookbackHours: 24,
  logResourceTypes: DEFAULT_LOG_RESOURCE_TYPES,
  ignoredMessages: DEFAULT_IGNORED_MESSAGES,
};

/** Firestore with no existing incidents that records what gets created. */
function fakeDb() {
  const created: Record<string, unknown>[] = [];
  const query = { where: () => query, limit: () => query, get: async () => ({ docs: [] }) };
  const db = {
    collection: () => ({ ...query, doc: () => ({ id: `doc${created.length}` }) }),
    batch: () => ({
      set: (_ref: unknown, data: Record<string, unknown>) => created.push(data),
      update: () => undefined,
      commit: async () => undefined,
    }),
  } as unknown as Firestore;
  return { db, created };
}

function entry(message: string) {
  return {
    metadata: { timestamp: "2026-09-21T00:00:00.000Z", resource: { labels: { function_name: "lookup" } } },
    data: message,
  };
}

describe("aggregateErrors", () => {
  it("groups on the redacted message, so PII variants are one incident", async () => {
    entries.splice(0, entries.length, entry("No user for alice@x.com"), entry("No user for bob@y.org"));
    const { db, created } = fakeDb();

    const result = await aggregateErrors(db, config, new Date(0));

    expect(result.incidentsCreated).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      errorMessage: "No user for [redacted-email]",
      occurrenceCount: 2,
    });
  });
});
