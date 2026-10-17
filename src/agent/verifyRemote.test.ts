/**
 * The isolated verify step end to end, minus Google: the agent side (`createRemoteVerifier`) and the runner side
 * (`runVerifier`) are the real code, the real verify gate runs a real command in a real scratch copy, and the
 * bucket is a local HTTP server that, like a signed URL, allows exactly one method on one object. What is NOT
 * exercised: Cloud Storage signing, the Cloud Run API, and the credential-less service account.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { unpackBundle } from "./verifyBundle.js";
import { VerifyRunnerError } from "./verifyProtocol.js";
import { createRemoteVerifier, type JobStarter, type ObjectStore } from "./verifyRemote.js";
import { runVerifier } from "./verifyRunner.js";
import type { VerifyRequest } from "./verifyGate.js";

const objects = new Map<string, Buffer>();
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.slice(1);
    const allowed = url.searchParams.get("m");
    if (req.method !== allowed) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET") {
      const found = objects.get(path);
      if (!found) res.writeHead(404).end();
      else res.writeHead(200, { "content-length": found.length }).end(found);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      objects.set(path, Buffer.concat(chunks));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const store: ObjectStore = {
  async put(path, data) {
    objects.set(path, data);
  },
  async signedUrl(path, method) {
    return `${base}/${path}?m=${method}`;
  },
  async read(path) {
    return objects.get(path) ?? null;
  },
  async remove(paths) {
    for (const p of paths) objects.delete(p);
  },
};

const GOOD_PATCH = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-hello old\n+hello new\n";
let src: string;
let tmp: string;
let pending: Promise<unknown>[];
let clock: number;
let ids = 0;
const nextId = () => `run-${String(++ids).padStart(10, "0")}`;
/** For the one test that needs a deadline to pass: the clock jumps, with no real waiting. */
const tick = async (ms: number) => {
  clock += ms;
  await new Promise<void>((r) => setTimeout(r, 1));
};
beforeEach(() => {
  objects.clear();
  tmp = mkdtempSync(join(tmpdir(), "remote-test-"));
  src = join(tmp, "src");
  mkdirSync(join(src, "keep"), { recursive: true });
  mkdirSync(join(src, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(src, ".git"));
  writeFileSync(join(src, "greeting.txt"), "hello old\n");
  writeFileSync(join(src, "node_modules", "dep", "index.js"), "module.exports = 1;");
  writeFileSync(join(src, ".git", "HEAD"), "ref: refs/heads/main");
  pending = [];
  clock = 0;
});
afterEach(async () => {
  await Promise.all(pending);
  rmSync(tmp, { recursive: true, force: true });
});

/** A job that, like Cloud Run, accepts the request and runs the real runner in the background. */
const realJob: JobStarter = async (request) => {
  pending.push(runVerifier(JSON.stringify(request), { tmpDir: tmp }).catch(() => undefined));
};

/** Real time: the runner really runs, and the deadline (the command's limit plus 300 s) is far off. */
const verifier = (startJob: JobStarter = realJob, id: () => string = nextId) =>
  createRemoteVerifier({ verifyTimeoutSeconds: 10 }, { store, startJob, tmpDir: tmp, newId: id, pollMs: 25 });

/** A fake clock, so a result that never comes reaches its deadline at once. */
const impatient = (startJob: JobStarter, id: () => string = nextId) =>
  createRemoteVerifier({ verifyTimeoutSeconds: 10 }, { store, startJob, tmpDir: tmp, now: () => clock, sleep: tick, newId: id, pollMs: 3000 });

const request = (over: Partial<VerifyRequest["config"]> = {}, patch = GOOD_PATCH): VerifyRequest => ({
  sourceDir: src,
  patch,
  baseRevision: "rev1",
  config: { verifyCommand: "grep -q new greeting.txt", verifyTimeoutSeconds: 10, patchExcludedPaths: [".github/"], ...over },
});

describe("createRemoteVerifier + runVerifier", () => {
  it("proves a patch in the runner and returns a result bound to that patch", async () => {
    const r = await verifier()(request());
    expect(r).toMatchObject({ status: "passed", rule: "command-passed", exitCode: 0, baseRevision: "rev1", changedFiles: ["greeting.txt"] });
    await Promise.all(pending);
  });

  it("returns a command that failed as a RESULT (the fixer can revise), not as an error", async () => {
    const r = await verifier()(request({ verifyCommand: "grep -q never greeting.txt" }));
    expect(r).toMatchObject({ status: "failed", rule: "command-failed", exitCode: 1 });
  });

  it("returns a command that timed out as a result", async () => {
    // Real time here: the command really has to run into its one-second limit.
    const real = createRemoteVerifier({ verifyTimeoutSeconds: 1 }, { store, startJob: realJob, tmpDir: tmp, pollMs: 50, newId: nextId });
    const r = await real(request({ verifyCommand: "sleep 30", verifyTimeoutSeconds: 1 }));
    expect(r).toMatchObject({ status: "timeout", rule: "command-timeout" });
  });

  it("runs the gate's own refusals in the runner too: a patch touching an excluded path is rejected", async () => {
    const evil = "--- /dev/null\n+++ b/.github/workflows/ci.yml\n@@ -0,0 +1 @@\n+name: x\n";
    const r = await verifier()(request({}, evil));
    expect(r).toMatchObject({ status: "rejected", rule: "excluded-path" });
  });

  it("leaves nothing in the bucket afterwards", async () => {
    await verifier()(request());
    expect([...objects.keys()]).toEqual([]);
  });

  it("sends the source without .git or node_modules, and the patch beside it", async () => {
    let captured: Buffer | undefined;
    const spy: ObjectStore = { ...store, put: async (p, d) => void (captured = d, objects.set(p, d)) };
    const v = createRemoteVerifier({ verifyTimeoutSeconds: 10 }, { store: spy, startJob: realJob, tmpDir: tmp, newId: nextId, pollMs: 25 });
    await v(request());
    const dest = mkdtempSync(join(tmp, "unpacked-"));
    const { tree, patch } = await unpackBundle(captured!, dest);
    expect(readFileSync(join(tree, "greeting.txt"), "utf8")).toBe("hello old\n");
    expect(readFileSync(patch, "utf8")).toBe(GOOD_PATCH);
    expect(() => readFileSync(join(tree, ".git", "HEAD"))).toThrow();
    expect(() => readFileSync(join(tree, "node_modules", "dep", "index.js"))).toThrow();
  });

  it("THROWS, instead of guessing, when the job never writes a result", async () => {
    const never: JobStarter = async () => undefined;
    await expect(impatient(never)(request())).rejects.toThrow("no result before the deadline");
    expect(clock).toBeGreaterThanOrEqual(310_000); // the command's limit plus the runner's slack
    expect([...objects.keys()]).toEqual([]);
  });

  it("beats the heartbeat while it waits, and stops at once (cleaning up) when the lease is lost (#132)", async () => {
    const never: JobStarter = async () => undefined;
    let beats = 0;
    const lost = new Error("lease lost");
    const req = { ...request(), heartbeat: async () => (++beats === 3 ? Promise.reject(lost) : undefined) };
    await expect(impatient(never)(req)).rejects.toBe(lost);
    expect(beats).toBe(3);
    expect(clock).toBe(6000); // two polls, not the whole wait
    expect([...objects.keys()]).toEqual([]);
  });

  it("THROWS when the job cannot be started, and still cleans up", async () => {
    const down: JobStarter = async () => {
      throw new VerifyRunnerError("the verify job could not be started: Cloud Run answered 403");
    };
    await expect(verifier(down)(request())).rejects.toThrow("could not be started");
    expect([...objects.keys()]).toEqual([]);
  });

  it("refuses a result written for a different patch", async () => {
    const forger: JobStarter = async () => {
      objects.set("verify/run-9999999991/result.json", Buffer.from(JSON.stringify({ status: "passed", rule: "command-passed", reason: "ok", patchSha256: "0".repeat(64), changedFiles: [], exitCode: 0, output: "", durationMs: 1 })));
    };
    await expect(verifier(forger, () => "run-9999999991")(request())).rejects.toThrow("different patch");
  });

  it("refuses a result that is not one", async () => {
    const junk: JobStarter = async () => void objects.set("verify/run-9999999992/result.json", Buffer.from("<html>"));
    await expect(verifier(junk, () => "run-9999999992")(request())).rejects.toThrow("not JSON");
  });

  it("refuses an unusable run id before anything is stored", async () => {
    const v = createRemoteVerifier({ verifyTimeoutSeconds: 10 }, { store, startJob: realJob, tmpDir: tmp, newId: () => "../../etc" });
    await expect(v(request())).rejects.toThrow("run id");
    expect([...objects.keys()]).toEqual([]);
  });

  it("gives the runner URLs that allow one method on one object each", async () => {
    let seen: { bundleUrl: string; resultUrl: string } | undefined;
    const peek: JobStarter = async (r) => void (seen = r);
    await impatient(peek)(request()).catch(() => undefined);
    expect((await fetch(seen!.bundleUrl, { method: "PUT", body: "x" })).status).toBe(403);
    expect((await fetch(seen!.resultUrl, { method: "GET" })).status).toBe(403);
  });
});
