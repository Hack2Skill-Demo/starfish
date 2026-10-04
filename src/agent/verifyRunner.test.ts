import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packBundle } from "./verifyBundle.js";
import { VerifyRunnerError } from "./verifyProtocol.js";
import { runVerifier } from "./verifyRunner.js";

const PATCH = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-hello old\n+hello new\n";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let tmp: string;
let src: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "runner-test-"));
  src = join(tmp, "src");
  mkdirSync(src);
  writeFileSync(join(src, "greeting.txt"), "hello old\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const req = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    bundleUrl: "https://storage.googleapis.com/b/bundle?sig=SECRET1",
    resultUrl: "https://storage.googleapis.com/b/result?sig=SECRET2",
    patchSha256: sha(PATCH),
    command: "grep -q new greeting.txt",
    timeoutSeconds: 10,
    excludedPaths: [],
    ...over,
  });

/** A fetch that serves the bundle and records what is written back. */
function fakeFetch(bundle: Buffer, opts: { getStatus?: number; putStatus?: number; length?: number } = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(typeof init?.body === "string" && { body: init.body }) });
    if (method === "GET") {
      return new Response(opts.getStatus && opts.getStatus !== 200 ? "no" : bundle, { status: opts.getStatus ?? 200, headers: { "content-length": String(opts.length ?? bundle.length) } });
    }
    return new Response("", { status: opts.putStatus ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("runVerifier", () => {
  it("fetches the bundle, judges the patch, and writes the result to the result URL", async () => {
    const { f, calls } = fakeFetch(await packBundle(src, PATCH, tmp));
    const r = await runVerifier(req(), { fetch: f, tmpDir: tmp });
    expect(r).toMatchObject({ status: "passed", rule: "command-passed" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]!.url).toContain("/b/result");
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ status: "passed", patchSha256: sha(PATCH) });
  });

  it("hands the command to the user it is told to, and still passes", async () => {
    const { f } = fakeFetch(await packBundle(src, PATCH, tmp));
    const me = { uid: process.getuid!(), gid: process.getgid!() };
    expect(await runVerifier(req(), { fetch: f, tmpDir: tmp, runAs: me })).toMatchObject({ status: "passed" });
  });

  it("keeps the request, with its signed URLs, out of the command's environment", async () => {
    const { f } = fakeFetch(await packBundle(src, PATCH, tmp));
    const prior = process.env.STARFISH_VERIFY_REQUEST;
    process.env.STARFISH_VERIFY_REQUEST = req();
    try {
      const r = await runVerifier(req({ command: 'test -z "$STARFISH_VERIFY_REQUEST" && grep -q new greeting.txt' }), { fetch: f, tmpDir: tmp });
      expect(r.status).toBe("passed");
    } finally {
      if (prior === undefined) delete process.env.STARFISH_VERIFY_REQUEST;
      else process.env.STARFISH_VERIFY_REQUEST = prior;
    }
  });

  it("refuses a bundle whose patch is not the one the request names", async () => {
    const { f, calls } = fakeFetch(await packBundle(src, PATCH + "\n", tmp));
    await expect(runVerifier(req(), { fetch: f, tmpDir: tmp })).rejects.toThrow("not the one named");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("refuses a malformed request before fetching anything", async () => {
    const { f, calls } = fakeFetch(Buffer.alloc(0));
    await expect(runVerifier(req({ bundleUrl: "https://evil.example/x" }), { fetch: f })).rejects.toThrow(VerifyRunnerError);
    expect(calls).toEqual([]);
  });

  it("fails without a URL in the message when the bundle or the write is refused", async () => {
    const bundle = await packBundle(src, PATCH, tmp);
    const get = await runVerifier(req(), { fetch: fakeFetch(bundle, { getStatus: 403 }).f, tmpDir: tmp }).catch((e: Error) => e);
    expect((get as Error).message).toContain("HTTP 403");
    const put = await runVerifier(req(), { fetch: fakeFetch(bundle, { putStatus: 403 }).f, tmpDir: tmp }).catch((e: Error) => e);
    expect((put as Error).message).toContain("HTTP 403");
    for (const e of [get, put]) expect((e as Error).message).not.toMatch(/SECRET|storage\.googleapis/);
  });

  it("fails without a URL in the message when the network is down", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED https://storage.googleapis.com/b/bundle?sig=SECRET1");
    }) as unknown as typeof fetch;
    const e = await runVerifier(req(), { fetch: down, tmpDir: tmp }).catch((err: Error) => err);
    expect((e as Error).message).toBe("the bundle could not be fetched");
  });

  it("refuses a bundle that declares itself too large without reading it", async () => {
    const { f } = fakeFetch(Buffer.alloc(10), { length: 200 * 1024 * 1024 });
    await expect(runVerifier(req(), { fetch: f, tmpDir: tmp })).rejects.toThrow("larger than the limit");
  });

  it("refuses something that is not a bundle", async () => {
    const { f } = fakeFetch(Buffer.from("not a tarball"));
    await expect(runVerifier(req(), { fetch: f, tmpDir: tmp })).rejects.toThrow(VerifyRunnerError);
  });

  it("leaves no scratch directory behind", async () => {
    const { readdirSync } = await import("node:fs");
    const before = readdirSync(tmp).length;
    const { f } = fakeFetch(await packBundle(src, PATCH, tmp));
    await runVerifier(req(), { fetch: f, tmpDir: tmp });
    expect(readdirSync(tmp).length).toBe(before);
  });
});
