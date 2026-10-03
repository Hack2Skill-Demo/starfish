import { describe, it, expect, vi } from "vitest";
import { SEEDED_SECRETS } from "./ingest/testSecrets.js";

let responseText = "";
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: async () => ({ text: responseText }) };
  },
}));
vi.mock("./config.js", () => ({
  loadConfig: () => ({ projectId: "p", location: "l", model: "m" }),
}));

const { askJson } = await import("./vertex.js");

describe("askJson", () => {
  it("redacts and bounds the model output quoted in its parse error", async () => {
    responseText = `not json ${SEEDED_SECRETS.githubToken} ${"y".repeat(3000)}`;

    const err = await askJson("p", "s", {}).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(SEEDED_SECRETS.githubToken);
    expect((err as Error).message.length).toBeLessThan(1300);
  });
});
