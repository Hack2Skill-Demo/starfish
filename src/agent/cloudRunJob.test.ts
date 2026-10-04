import { describe, expect, it } from "vitest";
import { REQUEST_ENV, createCloudRunJobStarter } from "./cloudRunJob.js";
import { VerifyRunnerError, type RunnerRequest } from "./verifyProtocol.js";

const request: RunnerRequest = {
  v: 1,
  bundleUrl: "https://storage.googleapis.com/b/x?X-Goog-Signature=SECRET_BUNDLE",
  resultUrl: "https://storage.googleapis.com/b/y?X-Goog-Signature=SECRET_RESULT",
  patchSha256: "a".repeat(64),
  command: "pnpm test",
  timeoutSeconds: 600,
  excludedPaths: [],
};
const cfg = { projectId: "star-proj", region: "us-central1", jobName: "starfish-verify" };

function fetchStub(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("createCloudRunJobStarter", () => {
  it("runs the job with the request as one environment override, authorised by the token it was given", async () => {
    const { f, calls } = fetchStub();
    await createCloudRunJobStarter(cfg, { token: async () => "tok", fetch: f })(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://run.googleapis.com/v2/projects/star-proj/locations/us-central1/jobs/starfish-verify:run");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.overrides.containerOverrides).toHaveLength(1);
    const env = body.overrides.containerOverrides[0].env;
    expect(env).toEqual([{ name: REQUEST_ENV, value: JSON.stringify(request) }]);
  });

  it("names the missing role on a 403, and never echoes the request or the signed URLs", async () => {
    const e = await createCloudRunJobStarter(cfg, { token: async () => "tok", fetch: fetchStub(403).f })(request).catch((err: Error) => err);
    expect(e).toBeInstanceOf(VerifyRunnerError);
    expect((e as Error).message).toContain("403");
    expect((e as Error).message).toContain("roles/run.invoker");
    expect((e as Error).message).not.toMatch(/SECRET|googleapis\.com\/b/);
  });

  it("reports an unreachable API without the request", async () => {
    const down = (async () => {
      throw new Error("ECONNRESET " + request.bundleUrl);
    }) as unknown as typeof fetch;
    const e = await createCloudRunJobStarter(cfg, { token: async () => "tok", fetch: down })(request).catch((err: Error) => err);
    expect((e as Error).message).toContain("could not be reached");
    expect((e as Error).message).not.toContain("SECRET");
  });

  it("refuses a job name, region or project that could change the URL it calls", () => {
    for (const bad of [{ jobName: "a/../b" }, { jobName: "Bad Name" }, { jobName: "" }, { region: "us-central1/x" }, { region: "" }, { projectId: "P" }, { projectId: "a:b" }]) {
      expect(() => createCloudRunJobStarter({ ...cfg, ...bad })).toThrow(VerifyRunnerError);
    }
  });
});
