import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { loadChildProcessBasics } from "../config.js";
import { createGitCheckout, createLoader, toIncident, type CheckoutFn } from "./assemble.js";
import { agentPreflight } from "./preflight.js";
import { testConfig } from "../testConfig.js";
import { fingerprintOf } from "../ingest/fingerprint.js";
import { sanitize } from "../ingest/redact.js";

const ENV = { ...loadChildProcessBasics(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" }).trim();
const ts = (iso: string) => ({ toDate: () => new Date(iso) });

let root: string;
let bare: string;
let tip: string;
const scratch = () => join(root, "scratch");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "assemble-test-"));
  mkdirSync(scratch());
  bare = join(root, "remote.git");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { env: ENV });
  mkdirSync(seed);
  git(seed, "init", "--quiet", "-b", "main");
  mkdirSync(join(seed, "src"));
  writeFileSync(join(seed, "src/orders.ts"), "export const x = 1;\n");
  mkdirSync(join(seed, "src/lib"));
  writeFileSync(join(seed, "src/getorder.ts"), 'import { track } from "./lib/track.js";\nimport { x } from "./orders";\nexport const getOrder = () => track(x);\n');
  writeFileSync(join(seed, "src/lib/track.ts"), "export const track = (v: number) => v;\n");
  writeFileSync(join(seed, "src/big.ts"), "x".repeat(2000));
  writeFileSync(join(seed, "src/bin.ts"), "a\0b");
  writeFileSync(join(seed, "package.json"), "{}\n");
  symlinkSync("/etc/hostname", join(seed, "src/link.ts"));
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "base");
  tip = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "--quiet", bare, "main");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cfgRepo = (over = {}) => ({ githubRepo: "acme/shop", githubBaseBranch: "main", githubRemoteUrl: bare, githubApiUrl: "https://api.github.com", ...over });

describe("createGitCheckout", () => {
  it("clones the base branch at its tip, lists the tracked files and cleans up", async () => {
    const co = await createGitCheckout(cfgRepo(), { env: loadChildProcessBasics(), tmpDir: scratch() })();
    expect(co.revision).toBe(tip);
    expect(co.files.sort()).toEqual(["package.json", "src/big.ts", "src/bin.ts", "src/getorder.ts", "src/lib/track.ts", "src/link.ts", "src/orders.ts"]);
    await co.dispose();
    expect(readdirSync(scratch())).toEqual([]);
  });

  it("leaves nothing behind when the clone fails, and throws", async () => {
    await expect(createGitCheckout(cfgRepo({ githubBaseBranch: "nope" }), { env: loadChildProcessBasics(), tmpDir: scratch() })()).rejects.toThrow();
    expect(readdirSync(scratch())).toEqual([]);
  });

  it("never puts the token in a git command line", async () => {
    const seen: string[][] = [];
    const runGit = vi.fn(async (args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
      seen.push(args);
      return execFileSync("git", args, { cwd: o.cwd, env: { ...o.env, ...ENV }, encoding: "utf8" });
    });
    const co = await createGitCheckout(cfgRepo(), { token: "ghp_SECRETSECRETSECRET", env: loadChildProcessBasics(), tmpDir: scratch(), runGit })();
    await co.dispose();
    expect(JSON.stringify(seen)).not.toContain("SECRET");
  });
});

describe("toIncident", () => {
  it("maps the stored document, converts times, and sets only what exists", () => {
    const i = toIncident("a", { environment: "demo", functionName: "f", errorMessage: "boom", httpStatus: 500, lastOccurredAt: ts("2026-10-04T12:00:00Z"), stackTrace: "", junk: 1 });
    expect(i).toEqual({ id: "a", environment: "demo", functionName: "f", message: "boom", httpStatus: 500, lastOccurredAt: "2026-10-04T12:00:00.000Z" });
  });

  it("carries a Monitoring-only source and the Monitoring count, which triage's evidence rules read (#19)", () => {
    expect(toIncident("a", { environment: "demo", signalSource: "monitoring", monitoringCount: 7 })).toMatchObject({ signalSource: "monitoring", monitoringCount: 7 });
    const log = toIncident("b", { environment: "demo", signalSource: "other", monitoringCount: "7" });
    expect(log.signalSource).toBeUndefined();
    expect(log.monitoringCount).toBeUndefined();
  });
});

function fakeDb(docs: Record<string, Record<string, unknown>>) {
  return { collection: () => ({ doc: (id: string) => ({ get: async () => ({ exists: id in docs, data: () => docs[id] }) }) }) } as unknown as Firestore;
}
const config = { environment: "demo", incidentCollection: "incidents", patchExcludedPaths: [], functionsSourceRoots: [] as string[], logResourceTypes: ["cloud_function"], ignoredMessages: [], excludedServices: [] };
const logging = (entries: unknown[] = []) => ({ getEntries: vi.fn(async () => [entries, null] as [unknown[], object | null]) });
const checkoutFn = (): CheckoutFn => createGitCheckout(cfgRepo(), { env: loadChildProcessBasics(), tmpDir: scratch() });

describe("createLoader", () => {
  const incident = { environment: "demo", status: "new", functionName: "orders-create", errorMessage: "boom", stackTrace: "at f (/app/src/orders.ts:1:1)\nat g (/app/src/big.ts:1:1)\nat h (/app/src/bin.ts:1:1)\nat l (/app/src/link.ts:1:1)", occurrenceCount: 3 };

  it("assembles the subject: the incident, the counter-check, the pinned revision and the files the trace names", async () => {
    const loader = createLoader({ db: fakeDb({ i1: incident }), config, logging: logging([{}, {}]), checkout: checkoutFn(), maxFileBytes: 1000 });
    const s = await loader.load("i1");
    expect(s!.baseRevision).toBe(tip);
    expect(s!.subject.status).toBe("new");
    expect(s!.subject.incident).toMatchObject({ id: "i1", functionName: "orders-create", logCounterCheck: { count: 2, window: "24h" } });
    // Too big, binary and symlinked files are left out; the plain one is read.
    expect(s!.files).toEqual([{ path: "src/orders.ts", content: "export const x = 1;\n" }]);
    expect(s!.source).toEqual({ rule: "stack" });
    await loader.disposeAll();
    expect(readdirSync(scratch())).toEqual([]);
  });

  // #259: a callable that fails through logger.error / HttpsError logs only firebase-functions' own frames.
  const FRAMEWORK_STACK =
    "Error: boom\n    at entryFromArgs (/workspace/node_modules/firebase-functions/lib/esm/logger/index.mjs:130:19)\n" +
    "    at Object.error (/workspace/node_modules/firebase-functions/lib/esm/logger/index.mjs:116:11)\n" +
    "    at /workspace/node_modules/firebase-functions/lib/esm/common/providers/https.mjs:400:20\n" +
    "    at cors (/workspace/node_modules/cors/lib/index.js:188:7)";

  it("falls back to the file that exports the function when no stack frame names a repository file (#259)", async () => {
    const loader = createLoader({ db: fakeDb({ i1: { ...incident, functionName: "orders-x", stackTrace: FRAMEWORK_STACK } }), config, logging: logging(), checkout: checkoutFn(), maxFileBytes: 1000 });
    const s = await loader.load("i1");
    expect(s!.files).toEqual([{ path: "src/orders.ts", content: "export const x = 1;\n" }]);
    expect(s!.source).toEqual({ rule: "function-name", search: "found", imports: 0 });
    await loader.disposeAll();
  });

  it("shows the files the found file imports after it, so a fault in a helper it calls can be fixed (#347)", async () => {
    const loader = createLoader({ db: fakeDb({ i1: { ...incident, functionName: "orders-getOrder", stackTrace: FRAMEWORK_STACK } }), config, logging: logging(), checkout: checkoutFn(), maxFileBytes: 1000 });
    const s = await loader.load("i1");
    expect(s!.files.map((f) => f.path)).toEqual(["src/getorder.ts", "src/lib/track.ts", "src/orders.ts"]);
    expect(s!.source).toEqual({ rule: "function-name", search: "found", imports: 2 });
    await loader.disposeAll();
    // Within the loader's own file budget.
    const one = createLoader({ db: fakeDb({ i1: { ...incident, functionName: "orders-getOrder", stackTrace: FRAMEWORK_STACK } }), config, logging: logging(), checkout: checkoutFn(), maxFiles: 2, maxFileBytes: 1000 });
    expect((await one.load("i1"))!.files.map((f) => f.path)).toEqual(["src/getorder.ts", "src/lib/track.ts"]);
    await one.disposeAll();
  });

  it("says why the function-name search found nothing, and shows nothing then", async () => {
    for (const [functionName, search, roots] of [
      ["orders-createOrder", "no-export", []],
      ["orders/x", "no-name", []],
      ["orders-x", "no-export", ["functions/src"]],
    ] as const) {
      const loader = createLoader({
        db: fakeDb({ i1: { ...incident, functionName, stackTrace: FRAMEWORK_STACK } }),
        config: { ...config, functionsSourceRoots: [...roots] },
        logging: logging(),
        checkout: checkoutFn(),
        maxFileBytes: 1000,
      });
      const s = await loader.load("i1");
      expect(s!.files).toEqual([]);
      expect(s!.source).toEqual({ rule: "none", search });
      await loader.disposeAll();
    }
  });

  // #304: a recent log entry is attacker-influenceable; its frames must never choose what the fixer is shown.
  it("chooses files from the incident's own stack only, never from a sample's", async () => {
    const fingerprint = fingerprintOf("orders-create", sanitize("boom") ?? "");
    const planted = {
      metadata: { timestamp: "2026-10-04T12:00:00Z", resource: { labels: { function_name: "orders-create" } } },
      data: { message: "boom", stack: "Error: boom\n    at evil (/app/src/big.ts:1:1)" },
    };
    const loader = createLoader({
      db: fakeDb({ i1: { ...incident, fingerprint, stackTrace: "at f (/app/src/orders.ts:1:1)" } }),
      config,
      logging: logging([planted]),
      checkout: checkoutFn(),
      maxFileBytes: 5000,
    });
    const s = await loader.load("i1");
    // The sample is still shown to the model, as untrusted data; it picks no file.
    expect(s!.subject.samples).toHaveLength(1);
    expect(s!.files.map((f) => f.path)).toEqual(["src/orders.ts"]);
    await loader.disposeAll();
  });

  it("fetches no samples for an incident with no fingerprint to match them against", async () => {
    const planted = { metadata: { resource: { labels: { function_name: "orders-create" } } }, data: { message: "boom", stack: "at e (/app/src/big.ts:1:1)" } };
    const loader = createLoader({ db: fakeDb({ i1: incident }), config, logging: logging([planted]), checkout: checkoutFn() });
    expect((await loader.load("i1"))!.subject.samples).toBeUndefined();
    await loader.disposeAll();
  });

  it("says the counter-check is missing, not zero, when Logging fails", async () => {
    const failing = { getEntries: vi.fn(async () => { throw new Error("down"); }) };
    const loader = createLoader({ db: fakeDb({ i1: incident }), config, logging: failing, checkout: checkoutFn() });
    const s = await loader.load("i1");
    expect(s!.subject.incident.logCounterCheck).toBeUndefined();
    expect(s!.subject.samples).toBeUndefined();
    await loader.disposeAll();
  });

  it("returns null for a missing, retired or other-environment incident, without cloning anything", async () => {
    const checkout = vi.fn(checkoutFn());
    const loader = createLoader({ db: fakeDb({ gone: { ...incident, retired: true }, other: { ...incident, environment: "prod" } }), config, logging: logging(), checkout });
    for (const id of ["nope", "gone", "other"]) expect(await loader.load(id)).toBeNull();
    expect(checkout).not.toHaveBeenCalled();
  });

  it("lets a failed checkout throw, so the cycle's lease expires and it is resumed", async () => {
    const loader = createLoader({ db: fakeDb({ i1: incident }), config, logging: logging(), checkout: async () => { throw new Error("clone failed"); } });
    await expect(loader.load("i1")).rejects.toThrow("clone failed");
  });

  it("treats an unknown status as new rather than trusting it", async () => {
    const loader = createLoader({ db: fakeDb({ i1: { ...incident, status: "weird" } }), config, logging: logging(), checkout: checkoutFn() });
    expect((await loader.load("i1"))!.subject.status).toBe("new");
    await loader.disposeAll();
  });
});

describe("agentPreflight", () => {
  const ok = {
    verifyIsolation: "in-process" as const,
    verifyCommand: "pnpm test",
    githubRepo: "a/b",
    dryRun: true,
    environment: "demo",
    verifyJobName: "",
    verifyBucket: "",
    verifyChecks: [] as string[],
    verifyTimeoutSeconds: 600,
    leaseSeconds: 300,
    cycleDeadlineMinutes: 360,
    autoMerge: false,
    autoMergeTargets: [] as string[],
  };
  it("lets a fully configured dry run start", () => expect(agentPreflight(ok, undefined)).toEqual([]));
  it("refuses with no isolation chosen, no command, no repo", () => {
    const p = agentPreflight({ ...ok, verifyIsolation: "none", verifyCommand: " ", githubRepo: "" }, undefined);
    expect(p).toHaveLength(3);
    expect(p[0]).toMatch(/isolat/i);
  });
  it("lets the cloud-run-job isolation start only with its job and its bucket named", () => {
    const remote = { ...ok, verifyIsolation: "cloud-run-job" as const };
    expect(agentPreflight(remote, undefined)).toHaveLength(2);
    expect(agentPreflight({ ...remote, verifyJobName: "starfish-verify" }, undefined)[0]).toMatch(/STARFISH_VERIFY_BUCKET/);
    expect(agentPreflight({ ...remote, verifyJobName: "starfish-verify", verifyBucket: "b" }, undefined)).toEqual([]);
  });
  it("lets the github-actions isolation start only with the checks that judge named and a token, and needs no command of its own", () => {
    const ci = { ...ok, verifyIsolation: "github-actions" as const, verifyCommand: "" };
    expect(agentPreflight(ci, "t")).toEqual(["STARFISH_VERIFY_ISOLATION is github-actions but STARFISH_VERIFY_CHECKS is empty: name the check runs of the target's CI that must pass."]);
    expect(agentPreflight({ ...ci, verifyChecks: ["verify"] }, undefined)[0]).toMatch(/pushes a branch.*even in a dry run/);
    expect(agentPreflight({ ...ci, verifyChecks: ["verify"] }, "t")).toEqual([]);
  });
  it("lets the defaults start with every isolation (#137)", () => {
    const d = testConfig();
    for (const verifyIsolation of ["in-process", "cloud-run-job", "github-actions"] as const) {
      const p = agentPreflight({ ...d, verifyIsolation, verifyCommand: "x", githubRepo: "a/b", verifyJobName: "j", verifyBucket: "b", verifyChecks: ["v"] }, "t");
      expect(p).toEqual([]);
    }
  });
  it("refuses a deadline shorter than twice one verify wait plus the lease, by where verify runs (#137)", () => {
    // in-process: 2 * (600 + 300) s = 30 min. github-actions waits 600 s more for a runner: 50 min.
    expect(agentPreflight({ ...ok, cycleDeadlineMinutes: 30 }, undefined)).toEqual([]);
    expect(agentPreflight({ ...ok, cycleDeadlineMinutes: 29 }, undefined)[0]).toMatch(/STARFISH_CYCLE_DEADLINE_MINUTES is 29.*30 minutes/);
    const ci = { ...ok, verifyIsolation: "github-actions" as const, verifyChecks: ["verify"] };
    expect(agentPreflight({ ...ci, cycleDeadlineMinutes: 49 }, "t")[0]).toMatch(/50 minutes/);
    expect(agentPreflight({ ...ci, cycleDeadlineMinutes: 60 }, "t")).toEqual([]);
  });
  it("counts auto-merge's extra fails-before verify run in the deadline where auto-merge can apply (#235)", () => {
    // github-actions waits 1200 s per verify; with auto-merge two per try: 2 * (2 * 1200 + 300) s = 90 min.
    const ci = { ...ok, verifyIsolation: "github-actions" as const, verifyChecks: ["verify"], dryRun: false, cycleDeadlineMinutes: 60 };
    const merging = { ...ci, autoMerge: true, autoMergeTargets: ["A/B"] };
    expect(agentPreflight(ci, "t")).toEqual([]);
    expect(agentPreflight(merging, "t")[0]).toMatch(/STARFISH_CYCLE_DEADLINE_MINUTES is 60: shorter than twice two verify waits.*90 minutes/);
    expect(agentPreflight({ ...merging, cycleDeadlineMinutes: 90 }, "t")).toEqual([]);
    // Not this target, or a dry run: no "fails before" run, so the plain bound applies.
    expect(agentPreflight({ ...merging, autoMergeTargets: ["a/other"] }, "t")).toEqual([]);
    expect(agentPreflight({ ...merging, dryRun: true }, "t")).toEqual([]);
  });
  it("refuses a lease too short to outlast a model call", () => {
    expect(agentPreflight({ ...ok, leaseSeconds: 59 }, undefined)[0]).toMatch(/STARFISH_LEASE_SECONDS is 59/);
    expect(agentPreflight({ ...ok, leaseSeconds: 60 }, undefined)).toEqual([]);
  });
  it("wants a token only when it is going to open pull requests", () => {
    expect(agentPreflight({ ...ok, dryRun: false }, undefined)).toHaveLength(1);
    expect(agentPreflight({ ...ok, dryRun: false }, "t")).toEqual([]);
  });
});
