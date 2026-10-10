import { describe, expect, it } from "vitest";
import { AgentJobStartError, createAgentJobStarter } from "./agentJob.js";

const cfg = { projectId: "star-proj", region: "us-central1", jobName: "starfish-agent" };

function fetchStub(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("createAgentJobStarter", () => {
  it("runs the job as a schedule tick does: one POST, no override, authorised by the token it was given", async () => {
    const { f, calls } = fetchStub();
    await createAgentJobStarter(cfg, { token: async () => "tok", fetch: f })();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://run.googleapis.com/v2/projects/star-proj/locations/us-central1/jobs/starfish-agent:run");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe("{}");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("names the missing role on a 403 and a missing job on a 404, and never the token", async () => {
    for (const [status, hint] of [[403, "roles/run.invoker"], [404, "no such job"], [500, "answered 500"]] as const) {
      const { f } = fetchStub(status);
      const err = await createAgentJobStarter(cfg, { token: async () => "SECRET_TOKEN", fetch: f })().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentJobStartError);
      expect((err as Error).message).toContain(hint);
      expect((err as Error).message).not.toContain("SECRET_TOKEN");
    }
  });

  it("reports an unreachable API, and a token that could not be had, as a start that failed", async () => {
    const down = (async () => {
      throw new Error("ECONNRESET to run.googleapis.com with Bearer SECRET_TOKEN");
    }) as unknown as typeof fetch;
    const err = await createAgentJobStarter(cfg, { token: async () => "SECRET_TOKEN", fetch: down })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentJobStartError);
    expect((err as Error).message).toBe("the agent job could not be started: Cloud Run could not be reached");

    const { f, calls } = fetchStub();
    const noToken = createAgentJobStarter(cfg, { token: async () => Promise.reject(new Error("metadata server said no")), fetch: f });
    await expect(noToken()).rejects.toBeInstanceOf(AgentJobStartError);
    expect(calls).toEqual([]);
  });

  it("refuses a job name, region or project that could change the URL it calls", () => {
    for (const bad of [{ ...cfg, jobName: "a/b" }, { ...cfg, jobName: "" }, { ...cfg, region: "us-central1/x" }, { ...cfg, projectId: "p?x=1" }]) {
      expect(() => createAgentJobStarter(bad)).toThrow(AgentJobStartError);
    }
  });
});
