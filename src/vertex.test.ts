import { describe, it, expect, vi } from "vitest";
import { SEEDED_SECRETS } from "./ingest/testSecrets.js";

let responseText = "";
const clientOptions: unknown[] = [];
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor(options: unknown) {
      clientOptions.push(options);
    }
    models = { generateContent: async () => ({ text: responseText }) };
  },
}));
// The store project and the Vertex project differ on purpose: the client must use the Vertex one.
vi.mock("./config.js", () => ({
  loadConfig: () => ({ projectId: "store-project", vertexProjectId: "vertex-project", location: "l", model: "m" }),
}));

const { askJson, UNTRUSTED_DATA_NOTICE } = await import("./vertex.js");

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
    expect(clientOptions).toEqual([{ vertexai: true, project: "vertex-project", location: "l" }]);
  });
});
