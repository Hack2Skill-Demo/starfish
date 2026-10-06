import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { SEEDED_SECRETS } from "./ingest/testSecrets.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { testConfig } from "./testConfig.js";

let responseText = "";
const clientOptions: unknown[] = [];
const requests: { client: unknown; model: unknown }[] = [];
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models: { generateContent: (req: { model: unknown }) => Promise<{ text: string }> };
    constructor(options: unknown) {
      clientOptions.push(options);
      this.models = {
        generateContent: async (req: { model: unknown }) => {
          requests.push({ client: options, model: req.model });
          return { text: responseText };
        },
      };
    }
  },
}));
// The store project and the Vertex project differ on purpose: the client must use the Vertex one.
vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  loadConfig: () => ({ projectId: "store-project", vertexProjectId: "vertex-project", location: "l", model: "m" }),
}));

const { askJson, createAskJson, UNTRUSTED_DATA_NOTICE } = await import("./vertex.js");

/** A Firestore holding one settings document, enough for the loader's read. */
function dbWithSettings(data: Record<string, unknown>): Firestore {
  const doc = (id: string) => ({
    get: async () => (id === "current" ? { exists: true, data: () => data } : { exists: false, data: () => undefined }),
    set: async () => undefined,
    delete: async () => undefined,
  });
  return { collection: () => ({ doc }) } as unknown as Firestore;
}

beforeEach(() => {
  requests.length = 0;
});

describe("the untrusted-data notice", () => {
  it("names every section of a prompt that carries untrusted text, the verify output of candidate code included (#138)", () => {
    for (const section of ["INCIDENT", "SOURCE CONTEXT", "PATCH", "THE FIXER CLAIMS", "PREVIOUS ATTEMPT FAILED VERIFICATION"]) {
      expect(UNTRUSTED_DATA_NOTICE.replace(/\s+/g, " ")).toContain(section);
    }
  });
});

describe("askJson", () => {
  it("redacts and bounds the model output quoted in its parse error", async () => {
    responseText = `not json ${SEEDED_SECRETS.github} ${"y".repeat(3000)}`;

    const err = await askJson("p", "s", {}).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(SEEDED_SECRETS.github);
    expect((err as Error).message.length).toBeLessThan(1300);
  });

  it("builds the Gemini client in the Vertex project, not the project the store lives in (#31)", async () => {
    responseText = "{}";
    await askJson("p", "s", {});
    expect(requests).toEqual([{ client: { vertexai: true, project: "vertex-project", location: "l" }, model: "m" }]);
  });
});

describe("createAskJson", () => {
  it("asks the model and region of the run's resolved settings, not the environment's (#7)", async () => {
    responseText = "{}";
    const base = testConfig({ vertexProjectId: "vertex-project", location: "us-central1", model: "gemini-env" });
    const resolved = await new RuntimeConfigLoader(base).resolve(
      dbWithSettings({ version: 1, model: "gemini-override", location: "europe-west4" })
    );
    expect(resolved.source).toBe("settings");

    await createAskJson(resolved.config)("p", "s", {});

    expect(requests).toEqual([
      { client: { vertexai: true, project: "vertex-project", location: "europe-west4" }, model: "gemini-override" },
    ]);
  });

  it("keeps a client per location, so a run on another region doesn't reuse the first client built", async () => {
    responseText = "{}";
    await createAskJson(testConfig({ vertexProjectId: "vp", location: "asia-east1", model: "a" }))("p", "s", {});
    await createAskJson(testConfig({ vertexProjectId: "vp", location: "global", model: "b" }))("p", "s", {});
    await createAskJson(testConfig({ vertexProjectId: "vp", location: "asia-east1", model: "c" }))("p", "s", {});

    expect(requests.map((r) => [(r.client as { location: string }).location, r.model])).toEqual([
      ["asia-east1", "a"],
      ["global", "b"],
      ["asia-east1", "c"],
    ]);
    expect(clientOptions.filter((o) => (o as { project: string }).project === "vp")).toHaveLength(2);
  });
});
