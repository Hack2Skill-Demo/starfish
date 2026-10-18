import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { SEEDED_SECRETS } from "./ingest/testSecrets.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { testConfig } from "./testConfig.js";

let responseText = "";
/** The whole response, when a test needs more than its text (a finish or block reason, #418). */
let responseExtra: Record<string, unknown> = {};
const clientOptions: unknown[] = [];
const requests: { client: unknown; model: unknown }[] = [];
const configs: Record<string, unknown>[] = [];
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models: { generateContent: (req: { model: unknown; config: Record<string, unknown> }) => Promise<Record<string, unknown>> };
    constructor(options: unknown) {
      clientOptions.push(options);
      this.models = {
        generateContent: async (req: { model: unknown; config: Record<string, unknown> }) => {
          requests.push({ client: options, model: req.model });
          configs.push(req.config);
          return { text: responseText, ...responseExtra };
        },
      };
    }
  },
}));
// The store project and the Vertex project differ on purpose: the client must use the Vertex one.
vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  loadConfig: () => ({ projectId: "store-project", vertexProjectId: "vertex-project", location: "l", model: "m", modelTimeoutSeconds: 600, modelMaxOutputTokens: 4096, modelThinkingLevel: "low", modelThinkingBudget: null }),
}));

const { askJson, askModel, createAskJson, thinkingConfigOf, isTransientModelFailure, modelCallFailure, modelFailureRule, modelFetch, ModelAnswerError, UNTRUSTED_DATA_NOTICE } = await import("./vertex.js");

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
  configs.length = 0;
  responseExtra = {};
});

describe("the untrusted-data notice", () => {
  it("names every section of a prompt that carries untrusted text, the verify output of candidate code and the log samples included (#138, #304)", () => {
    for (const section of ["INCIDENT", "RECENT SAMPLES", "SOURCE CONTEXT", "PATCH", "THE FIXER CLAIMS", "PREVIOUS ATTEMPT FAILED VERIFICATION", "PREVIOUS ATTEMPT BLOCKED BY REVIEW"]) {
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
    expect(requests).toEqual([{ client: expect.objectContaining({ vertexai: true, project: "vertex-project", location: "l" }), model: "m" }]);
  });
});

describe("how much the model thinks (#452)", () => {
  const target = { vertexProjectId: "vertex-project", location: "l", model: "m", modelTimeoutSeconds: 600, modelMaxOutputTokens: 4096 };

  it("sends the configured level on every call, as the API's enum value, beside the output limit", async () => {
    responseText = "{}";
    await askJson("p", "s", {});
    expect(configs[0]).toMatchObject({ maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "LOW" } });
    await createAskJson({ ...target, modelThinkingLevel: "medium", modelThinkingBudget: null })("p", "s", {});
    expect(configs[1]!.thinkingConfig).toEqual({ thinkingLevel: "MEDIUM" });
  });

  it("sends a budget instead, for a model that takes one, never both", async () => {
    responseText = "{}";
    await createAskJson({ ...target, modelThinkingLevel: null, modelThinkingBudget: 2048 })("p", "s", {});
    expect(configs[0]!.thinkingConfig).toEqual({ thinkingBudget: 2048 });
    expect(thinkingConfigOf({ modelThinkingLevel: "high", modelThinkingBudget: 2048 })).toEqual({ thinkingLevel: "HIGH" });
  });

  it("sends no thinking setting at all when none is configured: the model's own default", async () => {
    responseText = "{}";
    await createAskJson({ ...target, modelThinkingLevel: null, modelThinkingBudget: null })("p", "s", {});
    expect(configs[0]).not.toHaveProperty("thinkingConfig");
    expect(configs[0]).toMatchObject({ maxOutputTokens: 4096 });
  });
});

describe("how a model call ended (#418)", () => {
  it("sets the output limit on every call", async () => {
    responseText = "{}";
    await askJson("p", "s", {});
    expect(configs[0]).toMatchObject({ maxOutputTokens: 4096, temperature: 0 });
  });

  it("says an answer cut at the output limit is truncated, not a failed call", async () => {
    responseText = '{"decision": "ac';
    responseExtra = { candidates: [{ finishReason: "MAX_TOKENS" }] };
    expect(await askModel(askJson, "p", "s", {})).toEqual({ kind: "truncated", reason: expect.stringContaining("cut off at the output limit (MAX_TOKENS)") });
  });

  it("says a filtered prompt or answer is blocked", async () => {
    responseText = "";
    responseExtra = { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } };
    expect(await askModel(askJson, "p", "s", {})).toMatchObject({ kind: "blocked", reason: expect.stringContaining("PROHIBITED_CONTENT") });
    responseExtra = { candidates: [{ finishReason: "SAFETY" }] };
    expect(await askModel(askJson, "p", "s", {})).toMatchObject({ kind: "blocked" });
  });

  it("says a normal answer that is not JSON is unparseable, and a parsed one is ok", async () => {
    responseText = "not json";
    responseExtra = { candidates: [{ finishReason: "STOP" }] };
    expect(await askModel(askJson, "p", "s", {})).toMatchObject({ kind: "unparseable" });
    responseText = '{"a": 1}';
    expect(await askModel(askJson, "p", "s", {})).toEqual({ kind: "ok", value: { a: 1 } });
  });

  it("tells a timeout from a failed call, by names and codes only", async () => {
    const slow = Object.assign(new Error("secret prompt text"), { name: "AbortError" });
    expect(await askModel(async () => Promise.reject(slow), "p", "s", {})).toEqual({ kind: "timeout", reason: "The model call timed out (AbortError)." });
    const failed = await askModel(async () => Promise.reject(new TypeError("secret prompt text")), "p", "s", {});
    expect(failed).toEqual({ kind: "call-failed", reason: "The model call failed (TypeError)." });
  });

  it("retries only what a later attempt may do better at, and names each the same in every stage", () => {
    expect(["call-failed", "timeout", "unparseable", "truncated", "blocked"].filter((k) => isTransientModelFailure(k as never))).toEqual(["call-failed", "timeout", "unparseable"]);
    expect(modelFailureRule("timeout")).toBe("model-call-failed");
    expect(modelFailureRule("truncated")).toBe("model-output-truncated");
    expect(modelFailureRule("blocked")).toBe("model-output-blocked");
    expect(new ModelAnswerError("truncated", "MAX_TOKENS").message).not.toContain("prompt");
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
      { client: expect.objectContaining({ vertexai: true, project: "vertex-project", location: "europe-west4" }), model: "gemini-override" },
    ]);
  });

  it("builds the client in the Vertex project of the run's resolved settings (#7)", async () => {
    responseText = "{}";
    const base = testConfig({ projectId: "store-project", vertexProjectId: "vertex-env", location: "us-central1", model: "m" });
    const resolved = await new RuntimeConfigLoader(base).resolve(dbWithSettings({ version: 1, vertexProjectId: "elsewhere" }));
    expect(resolved.source).toBe("settings");

    await createAskJson(resolved.config)("p", "s", {});

    expect(requests).toEqual([{ client: expect.objectContaining({ vertexai: true, project: "elsewhere", location: "us-central1" }), model: "m" }]);
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

describe("the model call's deadline (#334)", () => {
  it("gives the client the configured deadline, and a fetch of its own so Node's 300 s limit does not cut it short", async () => {
    responseText = "{}";
    await createAskJson(testConfig({ vertexProjectId: "deadline", location: "l", model: "m", modelTimeoutSeconds: 900 }))("p", "s", {});

    const options = clientOptions.find((o) => (o as { project: string }).project === "deadline") as {
      httpOptions: { timeout: number; fetch: unknown };
    };
    expect(options.httpOptions.timeout).toBe(900_000);
    expect(typeof options.httpOptions.fetch).toBe("function");
  });

  it("keeps a client per deadline, so a run with another deadline doesn't reuse the first client built", async () => {
    responseText = "{}";
    await createAskJson(testConfig({ vertexProjectId: "per-deadline", location: "l", model: "m", modelTimeoutSeconds: 60 }))("p", "s", {});
    await createAskJson(testConfig({ vertexProjectId: "per-deadline", location: "l", model: "m", modelTimeoutSeconds: 120 }))("p", "s", {});

    const timeouts = clientOptions
      .filter((o) => (o as { project: string }).project === "per-deadline")
      .map((o) => (o as { httpOptions: { timeout: number } }).httpOptions.timeout);
    expect(timeouts).toEqual([60_000, 120_000]);
  });
});

describe("modelFetch (#334)", () => {
  async function slowServer(delayMs: number): Promise<{ url: string; close: () => void }> {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      const t = setTimeout(() => res.end('{"ok":true}'), delayMs);
      res.on("close", () => clearTimeout(t));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
  }

  it("waits for a response that comes within the deadline", async () => {
    const server = await slowServer(200);
    try {
      const res = await modelFetch(5_000)(server.url);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  it("honours the caller's abort signal, which is how the SDK's deadline ends a call", async () => {
    const server = await slowServer(5_000);
    try {
      const err = await modelFetch(60_000)(server.url, { signal: AbortSignal.timeout(100) }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(modelCallFailure(err)).toMatch(/^The model call timed out \(/);
    } finally {
      server.close();
    }
  });
});

describe("modelCallFailure (#334)", () => {
  it("names fetch's timeout as a timeout, by the cause's name and code", () => {
    const cause = Object.assign(new Error("Headers Timeout Error"), { name: "HeadersTimeoutError", code: "UND_ERR_HEADERS_TIMEOUT" });
    expect(modelCallFailure(new TypeError("fetch failed", { cause }))).toBe(
      "The model call timed out (TypeError; cause HeadersTimeoutError UND_ERR_HEADERS_TIMEOUT)."
    );
  });

  it("names the SDK's own deadline as a timeout", () => {
    expect(modelCallFailure(new DOMException("This operation was aborted", "AbortError"))).toBe("The model call timed out (AbortError).");
  });

  it("names any other failure by its name and its cause's, so a network failure is not read as a slow model", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(modelCallFailure(new TypeError("fetch failed", { cause }))).toBe("The model call failed (TypeError; cause Error ECONNREFUSED).");
    expect(modelCallFailure(Object.assign(new Error("x"), { name: "ApiError" }))).toBe("The model call failed (ApiError).");
  });

  it("never quotes a message, and keeps only identifier-shaped names and codes", () => {
    const err = Object.assign(new Error(`echoed ${SEEDED_SECRETS.github}`), {
      name: `Bad ${SEEDED_SECRETS.github}`,
      cause: { name: "x".repeat(200), code: `code ${SEEDED_SECRETS.github}` },
    });
    const reason = modelCallFailure(err);
    expect(reason).not.toContain(SEEDED_SECRETS.github);
    expect(reason).toBe("The model call failed (unknown error).");
  });

  it("says unknown for a thrown non-Error", () => {
    expect(modelCallFailure("boom")).toBe("The model call failed (unknown error).");
  });
});
