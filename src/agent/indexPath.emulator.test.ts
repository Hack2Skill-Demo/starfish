/**
 * The loop's missing-index path (#11) against the Firestore emulator: the cycle, its lease, its events and the run
 * record are real; the Firestore Admin API, the probe and the pull-request opener are fakes. Nothing here, or anywhere
 * in the suite, calls Google. Also the observer that decides whether a heal held. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { runCycle, type LoopDeps, type LoopSubject, type PullRequestRequest } from "./loop.js";
import { capSlot, countIndexCreations, readIndexFileText, type IndexHealWiring } from "./indexPath.js";
import type { AskJson } from "./triage.js";
import type { IndexAdmin, LiveIndex } from "../indexheal/firestoreAdmin.js";
import { createIndexProbe, type IndexProbeSpec, type ProbeVerdict } from "../indexheal/probe.js";
import { observeIndexHeals } from "../indexheal/observe.js";
import type { IssueRequest } from "../integrations/githubPr.js";
import type { NotifyRequest } from "../integrations/slack.js";
import { PUBLIC_VIEW_OFF, testConfig } from "../testConfig.js";
import type { Incident, IncidentStatus } from "../types.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("indexPath.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "index-path-emulator-tests");
const db: Firestore = getFirestore(app, "index-path-tests");
afterAll(() => deleteApp(app));

// ---- A create-index URL built from the documented Index message ------------------------------------------------
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
const lenDelimited = (num: number, bytes: number[]) => [...varint(num * 8 + 2), ...varint(bytes.length), ...bytes];
const str = (num: number, s: string) => lenDelimited(num, [...Buffer.from(s, "utf8")]);
const int = (field: number, n: number) => [...varint(field * 8), ...varint(n)];
function urlFor(project = "demo-app-1"): string {
  const bytes = [...str(1, `projects/${project}/databases/(default)/collectionGroups/orders/indexes/_`), ...int(2, 1)];
  for (const [path, order] of [["status", 1], ["createdAt", 2]] as const) bytes.push(...lenDelimited(3, [...str(1, path), ...int(2, order)]));
  return `https://console.firebase.google.com/v1/r/project/${project}/firestore/indexes?create_composite=${Buffer.from(bytes).toString("base64url")}`;
}

const t0 = new Date("2026-10-06T12:00:00.000Z");
const key = { incidentId: "idx1", environment: "demo", recurrence: 0 };
const OP = "projects/demo-app-1/databases/(default)/operations/op1";
const incidentFor = (project = "demo-app-1"): Incident => ({
  id: "idx1",
  environment: "demo",
  functionName: "orders-list",
  service: "orders",
  errorType: "MissingIndexError",
  occurrenceCount: 12,
  logCounterCheck: { window: "24h", count: 12 },
  message: `9 FAILED_PRECONDITION: The query requires an index. You can create it here: ${urlFor(project)}`,
});
const READY: LiveIndex = {
  name: "projects/demo-app-1/databases/(default)/collectionGroups/orders/indexes/abc",
  state: "READY",
  queryScope: "COLLECTION",
  fields: [
    { fieldPath: "status", order: "ASCENDING" },
    { fieldPath: "createdAt", order: "DESCENDING" },
    { fieldPath: "__name__", order: "DESCENDING" },
  ],
};

let src: string;
let clock: Date;
let status: IncidentStatus | null;
let enabled: boolean;
let run: string;
let incident: Incident;
let cfgOver: Partial<ReturnType<typeof testConfig>>;
beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), "index-src-"));
  writeFileSync(join(src, "firestore.indexes.json"), `${JSON.stringify({ indexes: [], fieldOverrides: [] }, null, 2)}\n`);
  clock = new Date(t0);
  status = "new";
  enabled = true;
  run = randomUUID().slice(0, 8);
  incident = incidentFor();
  cfgOver = {};
});
afterEach(() => rmSync(src, { recursive: true, force: true }));

/** A Firestore Admin fake: an index that appears READY once created (after one poll), and a record of every call. */
function fakeAdmin(over: { live?: LiveIndex[]; opDone?: { done: boolean; error?: { code: number; message: string } }[]; existing?: number } = {}) {
  const calls: string[] = [];
  let created = false;
  const ops = [...(over.opDone ?? [{ done: false }, { done: true }])];
  const admin: IndexAdmin = {
    list: vi.fn(async () => {
      calls.push("list");
      return created ? [READY] : (over.live ?? []);
    }),
    create: vi.fn(async () => {
      calls.push("create");
      return { operation: OP };
    }),
    countIndexes: vi.fn(async () => {
      calls.push("count");
      return over.existing ?? 5;
    }),
    getOperation: vi.fn(async () => {
      calls.push("op");
      const next = ops.length > 1 ? ops.shift()! : ops[0]!;
      if (next.done && next.error === undefined) created = true;
      return next;
    }),
  };
  return { admin, calls };
}

/** The probe: the query fails for this index until it is READY, then passes. */
function fakeProbe(admin: { calls: string[] }, script?: ProbeVerdict[]) {
  const queue = script ? [...script] : undefined;
  return vi.fn(async (): Promise<ProbeVerdict> => {
    if (queue) return queue.length > 1 ? queue.shift()! : queue[0]!;
    return admin.calls.includes("create") || admin.calls.length === 0 ? { state: "passed", probes: 1 } : { state: "needs-index", probes: 1 };
  });
}

function wiring(admin: IndexAdmin, probe: IndexHealWiring["probe"], over: Partial<IndexHealWiring["settings"]> = {}): IndexHealWiring {
  return {
    settings: {
      allowedTargets: [{ project: "demo-app-1", database: "(default)" }],
      own: { project: "starfish-proj", database: "starfish" },
      autoApply: true,
      dailyCap: 3,
      maxIndexes: 100,
      pollMs: 1000,
      maxWaitMs: 10_000,
      ...over,
    },
    admin,
    probe,
    sleep: async (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    indexFilePath: "firestore.indexes.json",
    observeMinutes: 60,
  };
}

const noModel = (async () => {
  throw new Error("the index path must not call the model");
}) as AskJson;

function deps(indexHeal: IndexHealWiring | undefined, extra: Partial<LoopDeps> = {}, opened: PullRequestRequest[] = [], told: NotifyRequest[] = []): LoopDeps {
  const loaded = (): LoopSubject => ({ subject: { incident, status: "new" }, files: [], sourceDir: src, baseRevision: "a".repeat(40) });
  return {
    db,
    config: testConfig({ cycleCollection: `cycles_${run}`, dryRun: false, ...cfgOver }),
    owner: "worker-a",
    now: () => clock,
    ask: noModel,
    load: async () => loaded(),
    incidentStatus: async () => status,
    automationEnabled: async () => enabled,
    openPullRequest: async (req) => {
      opened.push(req);
      return { number: 11, url: "https://example.test/pull/11" };
    },
    notify: async (req) => {
      told.push(req);
      return { state: "sent", attempts: 1 };
    },
    ...(indexHeal && { indexHeal }),
    ...extra,
  };
}

const cycleRef = () => db.collection(`cycles_${run}`).doc("idx1_r0");
const cycleDoc = async () => (await cycleRef().get()).data()!;
/** The production probe for `orders`, with a runner that cannot reach Firestore (UNAVAILABLE): it never throws (#232). */
const ORDERS_PROBE: IndexProbeSpec = {
  project: "demo-app-1",
  database: "(default)",
  collection: "orders",
  scope: "COLLECTION",
  where: [{ field: "status", op: "==", value: "open" }],
  orderBy: [{ field: "createdAt", direction: "desc" }],
};
const unavailableProbe = () => createIndexProbe([ORDERS_PROBE], () => Promise.reject(Object.assign(new Error("14 UNAVAILABLE"), { code: 14 })));

const kinds = async () => (await cycleRef().collection("events").orderBy("seq").get()).docs.map((d) => `${d.data().stage}:${d.data().type}`);

describe("runCycle: a missing index takes the index path", () => {
  it("creates the one index, waits for READY, replays the query and opens the evidence pull request; no model", async () => {
    const a = fakeAdmin();
    const opened: PullRequestRequest[] = [];
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a)), {}, opened), key);
    expect(r).toEqual({ kind: "finished", state: "done", outcome: "index-pr-opened" });
    expect(a.admin.create).toHaveBeenCalledTimes(1);
    expect(await kinds()).toEqual(["cycle:started", "index:started", "index:creating", "index:building", "index:ready", "pr:opened"]);
    const doc = await cycleDoc();
    expect(doc).toMatchObject({ state: "done", path: "index" });
    expect(doc.summary.index).toMatchObject({
      state: "ready",
      created: true,
      probe: "passed",
      runtime: "observing",
      operation: OP,
      capSlot: capSlot({ project: "demo-app-1", database: "(default)" }, t0),
      collectionGroup: "orders",
      fields: "status ASCENDING, createdAt DESCENDING",
    });
    expect(doc.summary.pr).toMatchObject({ opened: true, number: 11 });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.index).toMatchObject({ collectionGroup: "orders", created: true, operation: OP, indexFile: "firestore.indexes.json", fileCreated: false });
    expect(opened[0]!.verify).toBeUndefined();
    expect(JSON.parse(readAfter(opened[0]!.patch))).toBeDefined();
  });

  // #62: while an index builds (Starfish's own create, or anyone's) Firestore answers with "that index is currently building".
  const buildingMessage = (id = "abc") => {
    const bytes = [...str(1, `projects/demo-app-1/databases/(default)/collectionGroups/orders/indexes/${id}`), ...int(2, 1)];
    for (const [path, order] of [["status", 1], ["createdAt", 2], ["__name__", 2]] as const) bytes.push(...lenDelimited(3, [...str(1, path), ...int(2, order)]));
    return `9 FAILED_PRECONDITION: The query requires an index. That index is currently building and cannot be used yet. See its status here: https://console.firebase.google.com/v1/r/project/demo-app-1/firestore/indexes?create_composite=${Buffer.from(bytes).toString("base64url")}`;
  };

  it("tells nobody and files nothing when the error names an index the inventory holds, building or ready (#62)", async () => {
    for (const [state, outcome] of [["CREATING", "index-already-building"], ["READY", "index-already-ready"]] as const) {
      run = randomUUID().slice(0, 8);
      incident = { ...incidentFor(), message: buildingMessage() };
      const a = fakeAdmin({ live: [{ ...READY, state }] });
      const issues: IssueRequest[] = [];
      const told: NotifyRequest[] = [];
      const openIssue = async (req: IssueRequest) => (issues.push(req), { number: 8, url: "https://example.test/issues/8" });
      expect(await runCycle(deps(wiring(a.admin, fakeProbe(a)), { openIssue }, [], told), key)).toEqual({ kind: "finished", state: "declined", outcome });
      expect(issues).toHaveLength(0);
      expect(told).toHaveLength(0);
      expect(a.admin.create).not.toHaveBeenCalled();
      expect(await kinds()).toEqual(["cycle:started", "index:already-building"]);
      expect(await cycleDoc()).toMatchObject({ state: "declined", path: "decline" });
    }
  });

  it("still hands it to a person when the inventory does not hold the index the words name (#62)", async () => {
    incident = { ...incidentFor(), message: buildingMessage("nope") };
    const a = fakeAdmin({ live: [READY] });
    const told: NotifyRequest[] = [];
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a)), {}, [], told), key);
    expect(r).toMatchObject({ state: "waiting-human" });
    expect(told).toHaveLength(1);
    expect(a.admin.create).not.toHaveBeenCalled();
  });

  it("files the incident's issue first, through the loop's opener, and links it from the evidence PR without closing it", async () => {
    const a = fakeAdmin();
    const opened: PullRequestRequest[] = [];
    const told: NotifyRequest[] = [];
    const issues: IssueRequest[] = [];
    const openIssue = async (req: IssueRequest) => (issues.push(req), { number: 7, url: "https://example.test/issues/7" });
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a)), { openIssue }, opened, told), key);
    expect(r).toMatchObject({ state: "done", outcome: "index-pr-opened" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: "index", cycleId: "idx1_r0", errorType: "MissingIndexError", suspectedCause: null });
    expect(issues[0]!.reason).toContain("orders (fields: status ASCENDING, createdAt DESCENDING)");
    expect((await kinds()).slice(0, 3)).toEqual(["cycle:started", "index:started", "issue:opened"]);
    expect((await cycleDoc()).summary.issue).toMatchObject({ state: "opened", number: 7 });
    expect(opened[0]!.issueNumber).toBe(7);
  });

  it("files the issue once: a resumed attempt reuses the recorded one", async () => {
    const a = fakeAdmin({ opDone: [{ done: false }] });
    const issues: IssueRequest[] = [];
    const openIssue = async (req: IssueRequest) => (issues.push(req), { number: 7, url: "https://example.test/issues/7" });
    expect(await runCycle(deps(wiring(a.admin, fakeProbe(a)), { openIssue }), key)).toEqual({ kind: "released", reason: "index-still-building" });
    clock = new Date(clock.getTime() + 60_000);
    const b = fakeAdmin({ live: [READY] });
    const opened: PullRequestRequest[] = [];
    expect(await runCycle(deps(wiring(b.admin, fakeProbe(b, [{ state: "passed", probes: 1 }])), { openIssue }, opened), key)).toMatchObject({ outcome: "index-pr-opened" });
    expect(issues).toHaveLength(1);
    expect(opened[0]!.issueNumber).toBe(7);
  });

  it("files no issue in a dry run, and records that one would have been filed", async () => {
    cfgOver = { dryRun: true };
    const a = fakeAdmin();
    const issues: IssueRequest[] = [];
    const openIssue = async (req: IssueRequest) => (issues.push(req), { number: 7, url: "https://example.test/issues/7" });
    expect(await runCycle(deps(wiring(a.admin, fakeProbe(a)), { openIssue }), key)).toMatchObject({ outcome: "index-dry-run" });
    expect(issues).toHaveLength(0);
    expect((await cycleDoc()).summary.issue).toEqual({ state: "dry-run" });
  });

  it("a failed issue is recorded and the heal goes on; a refused one still gets its issue, linked from the message", async () => {
    const a = fakeAdmin();
    const failing = async (): Promise<{ number: number; url: string }> => {
      throw Object.assign(new Error("boom"), { rule: "http-error" });
    };
    expect(await runCycle(deps(wiring(a.admin, fakeProbe(a)), { openIssue: failing }), key)).toMatchObject({ outcome: "index-pr-opened" });
    expect((await cycleDoc()).summary.issue).toEqual({ state: "failed", reason: "http-error" });

    run = randomUUID().slice(0, 8);
    incident = incidentFor("other-app-1");
    const told: NotifyRequest[] = [];
    const openIssue = async () => ({ number: 8, url: "https://example.test/issues/8" });
    const b = fakeAdmin();
    expect(await runCycle(deps(wiring(b.admin, fakeProbe(b)), { openIssue }, [], told), key)).toMatchObject({ outcome: "index-target-not-allowed" });
    expect(told[0]).toMatchObject({ rule: "index-target-not-allowed", issueUrl: "https://example.test/issues/8" });
  });

  it("refuses at the configured index limit for the database, and hands it to a person", async () => {
    const a = fakeAdmin({ existing: 100 });
    const told: NotifyRequest[] = [];
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a)), {}, [], told), key);
    expect(r).toMatchObject({ state: "waiting-human", outcome: "index-index-limit" });
    expect(a.admin.create).not.toHaveBeenCalled();
    expect((await cycleDoc()).summary.index).toMatchObject({ state: "index-limit", existing: 100, limit: 100 });
    expect((await cycleDoc()).summary.index.capSlot).toBeUndefined();
    expect(told[0]).toMatchObject({ rule: "index-index-limit" });
  });

  it("is a dry run by default: it reads and replays, and creates nothing", async () => {
    cfgOver = { dryRun: true };
    const a = fakeAdmin();
    const opened: PullRequestRequest[] = [];
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a)), {}, opened), key);
    expect(r).toEqual({ kind: "finished", state: "waiting-human", outcome: "index-dry-run" });
    expect(a.admin.create).not.toHaveBeenCalled();
    expect(opened).toHaveLength(0);
    expect((await cycleDoc()).summary.index).toMatchObject({ state: "dry-run", live: "absent", probe: "needs-index", repoFile: "absent" });
  });

  it("creates nothing with indexAutoApply off, and hands it to a person", async () => {
    const a = fakeAdmin();
    const told: NotifyRequest[] = [];
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a), { autoApply: false }), {}, [], told), key);
    expect(r).toMatchObject({ state: "waiting-human", outcome: "index-switched-off" });
    expect(a.admin.create).not.toHaveBeenCalled();
    expect(told[0]).toMatchObject({ path: "human", rule: "index-switched-off" });
  });

  it("pauses, uncounted, when the automation switch is off, and creates nothing", async () => {
    enabled = false;
    const a = fakeAdmin();
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a))), key);
    expect(r).toEqual({ kind: "released", reason: "automation-disabled" });
    expect(a.admin.list).not.toHaveBeenCalled();
    expect(a.admin.create).not.toHaveBeenCalled();
  });

  it("refuses a target that is not allowed before any Admin call", async () => {
    incident = incidentFor("other-app-1");
    const a = fakeAdmin();
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a))), key);
    expect(r).toMatchObject({ state: "waiting-human", outcome: "index-target-not-allowed" });
    expect(a.calls).toEqual([]);
  });

  it("creates nothing when no probe confirms the failing query", async () => {
    const a = fakeAdmin();
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a, [{ state: "not-configured" }]))), key);
    expect(r).toMatchObject({ state: "waiting-human", outcome: "index-no-probe" });
    expect(a.admin.create).not.toHaveBeenCalled();
  });

  it("stops at the daily cap, counting attempts recorded by other cycles for the same target today", async () => {
    const slot = capSlot({ project: "demo-app-1", database: "(default)" }, t0);
    for (const n of [1, 2, 3]) await db.collection(`cycles_${run}`).doc(`other${n}_r0`).set({ summary: { index: { capSlot: slot } } });
    await db.collection(`cycles_${run}`).doc("yesterday_r0").set({ summary: { index: { capSlot: capSlot({ project: "demo-app-1", database: "(default)" }, new Date("2026-10-05T12:00:00Z")) } } });
    expect(await countIndexCreations(db, `cycles_${run}`, slot)).toBe(3);
    const a = fakeAdmin();
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a))), key);
    expect(r).toMatchObject({ state: "waiting-human", outcome: "index-cap-reached" });
    expect(a.admin.create).not.toHaveBeenCalled();
  });

  it("takes the ordinary path when the heal is not wired in (no target allowed)", async () => {
    const ask = vi.fn(async () => ({ decision: "notify", reasoning: "An index is missing; a person should add it.", suspectedCause: "a missing index" })) as unknown as AskJson;
    const r = await runCycle(deps(undefined, { ask }), key);
    expect(ask).toHaveBeenCalled();
    expect(r).toMatchObject({ state: "waiting-human" });
    expect((await cycleDoc()).summary.index).toBeUndefined();
  });

  it("an incident an operator held to log or noise does not take the index path: nothing is created, triage decides", async () => {
    const a = fakeAdmin();
    const probe = fakeProbe(a);
    const held: LoopDeps["load"] = async () => ({ subject: { incident, status: "new", correction: { level: "noise", by: "u1" } }, files: [], sourceDir: src, baseRevision: "a".repeat(40) });
    const r = await runCycle(deps(wiring(a.admin, probe), { load: held }), key);
    expect(a.calls).toEqual([]);
    expect(r).toMatchObject({ state: "declined", outcome: "correction-cap" });
    expect((await cycleDoc()).summary.index).toBeUndefined();
  });

  it("does not open a pull request when the index file already has the entry; the runtime is still observed", async () => {
    writeFileSync(
      join(src, "firestore.indexes.json"),
      JSON.stringify({ indexes: [{ collectionGroup: "orders", queryScope: "COLLECTION", fields: [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "createdAt", order: "DESCENDING" }] }] })
    );
    const a = fakeAdmin();
    const opened: PullRequestRequest[] = [];
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a)), {}, opened), key);
    expect(r).toMatchObject({ state: "done", outcome: "index-ready-already-in-index-file" });
    expect(opened).toHaveLength(0);
    expect((await cycleDoc()).summary.index.runtime).toBe("observing");
  });

  it("is not healed when the query still fails after READY", async () => {
    const a = fakeAdmin();
    const probe = fakeProbe(a, [{ state: "needs-index", probes: 1 }]);
    const r = await runCycle(deps(wiring(a.admin, probe)), key);
    expect(r).toMatchObject({ state: "waiting-human", outcome: "index-query-still-failing" });
    expect((await cycleDoc()).summary.index.runtime).toBeUndefined();
  });

  it("a probe that could not run after READY is not \"the query does not pass\": released, and a later pass checks again (#232)", async () => {
    const a = fakeAdmin();
    let reachable = false;
    const probe = vi.fn(async (spec: Parameters<IndexHealWiring["probe"]>[0]): Promise<ProbeVerdict> => {
      // Confirms the failing query before the create, then cannot reach Firestore once READY.
      if (!a.calls.includes("create")) return { state: "needs-index", probes: 1 };
      return reachable ? { state: "passed", probes: 1 } : unavailableProbe()(spec);
    });
    const r = await runCycle(deps(wiring(a.admin, probe)), key);
    expect(r).toEqual({ kind: "released", reason: "index-probe-inconclusive" });
    const doc = await cycleDoc();
    expect(doc.state).toBe("running");
    expect(doc.summary.index).toMatchObject({ state: "ready-unconfirmed", probe: "inconclusive", operation: OP });
    expect(await kinds()).not.toContain("index:query-still-failing");

    // The next pass: READY in the inventory, the query reachable again: observed, and the evidence PR opened.
    reachable = true;
    clock = new Date(t0.getTime() + 10 * 60_000);
    const b = fakeAdmin({ live: [READY] });
    const r2 = await runCycle({ ...deps(wiring(b.admin, probe)), owner: "worker-b" }, key);
    expect(r2).toEqual({ kind: "finished", state: "done", outcome: "index-pr-opened" });
    expect(b.admin.create).not.toHaveBeenCalled();
    expect((await cycleDoc()).summary.index).toMatchObject({ runtime: "observing", created: true });
  });

  it("reports a failed build to a person and never retries the create", async () => {
    const a = fakeAdmin({ opDone: [{ done: true, error: { code: 9, message: "index limit" } }] });
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a))), key);
    expect(r).toMatchObject({ state: "waiting-human", outcome: "index-build-failed" });
    expect(a.admin.create).toHaveBeenCalledTimes(1);
  });
});

describe("runCycle: the index path across a restart", () => {
  it("lets go when READY takes too long, and the next attempt polls the recorded operation instead of creating again", async () => {
    const a = fakeAdmin({ opDone: [{ done: false }] });
    const w = wiring(a.admin, fakeProbe(a), { maxWaitMs: 3000 });
    const r1 = await runCycle(deps(w), key);
    expect(r1).toEqual({ kind: "released", reason: "index-still-building" });
    expect((await cycleDoc()).summary.index).toMatchObject({ state: "building", operation: OP });

    // The next pass: a new worker, the build done now. The inventory does not list it yet; the operation says READY.
    const b = fakeAdmin({ opDone: [{ done: true }] });
    const opened: PullRequestRequest[] = [];
    clock = new Date(t0.getTime() + 10 * 60_000);
    const r2 = await runCycle({ ...deps(wiring(b.admin, fakeProbe({ calls: ["create"] })), {}, opened), owner: "worker-b" }, key);
    expect(r2).toEqual({ kind: "finished", state: "done", outcome: "index-pr-opened" });
    expect(b.admin.create).not.toHaveBeenCalled();
    expect(b.admin.getOperation).toHaveBeenCalledWith(OP);
    expect(opened).toHaveLength(1);
  });

  it("an attempt that crashed after recording the create, with no operation, creates nothing again", async () => {
    await cycleRef().set({
      incidentId: "idx1",
      environment: "demo",
      recurrence: 0,
      state: "running",
      attempts: 1,
      owner: null,
      leaseExpiresAt: null,
      deadlineAt: Timestamp.fromMillis(t0.getTime() + 3_600_000),
      eventCount: 0,
      startDays: ["2026-10-06"],
      createdAt: Timestamp.fromDate(t0),
      updatedAt: Timestamp.fromDate(t0),
      summary: { index: { state: "creating", attemptedAt: t0.toISOString(), capSlot: "demo-app-1/(default)|2026-10-06" } },
    });
    const a = fakeAdmin();
    const r = await runCycle(deps(wiring(a.admin, fakeProbe(a))), key);
    expect(r).toMatchObject({ state: "waiting-human", outcome: "index-unresolved-earlier-create" });
    expect(a.admin.create).not.toHaveBeenCalled();
    // The attempt still counts against the cap.
    expect((await cycleDoc()).summary.index.capSlot).toBe("demo-app-1/(default)|2026-10-06");
  });

  it("a cycle that already opened its evidence pull request ends on the index path without redoing anything", async () => {
    const a = fakeAdmin();
    await runCycle(deps(wiring(a.admin, fakeProbe(a))), key);
    await cycleRef().update({ state: "running", owner: null, leaseExpiresAt: null });
    const b = fakeAdmin();
    const r = await runCycle({ ...deps(wiring(b.admin, fakeProbe(b))), owner: "worker-b" }, key);
    expect(r).toEqual({ kind: "finished", state: "done", outcome: "index-pr-opened" });
    expect(b.calls).toEqual([]);
    expect((await cycleDoc()).path).toBe("index");
  });
});

describe("observeIndexHeals", () => {
  const cfg = () => ({
    cycleCollection: `cycles_${run}`,
    incidentCollection: `incidents_${run}`,
    runCollection: `runs_${run}`,
    watchedProjectId: "demo-app-1",
    environment: "demo",
    ingestLagMinutes: 5,
    ...PUBLIC_VIEW_OFF,
  });
  const readyAt = t0.toISOString();
  const until = new Date(t0.getTime() + 60 * 60_000).toISOString();
  /** Ingest's checkpoint for the target, as src/ingest/run.ts writes it. */
  async function ingested(through: Date, target = { watchedProjectId: "demo-app-1", environment: "demo" }) {
    await db.collection(`runs_${run}`).doc("state").set({ target, checkpoint: Timestamp.fromDate(through) });
  }
  // Ingest has read through every window unless a test says otherwise.
  beforeEach(() => ingested(new Date(t0.getTime() + 65 * 60_000)));
  async function seed(id: string, lastOccurredAt: Date, over: Record<string, unknown> = {}) {
    await db.collection(`incidents_${run}`).doc(id).set({ environment: "demo", lastOccurredAt: Timestamp.fromDate(lastOccurredAt) });
    await db
      .collection(`cycles_${run}`)
      .doc(`${id}_r0`)
      .set({
        incidentId: id,
        environment: "demo",
        state: "done",
        summary: {
          index: {
            runtime: "observing",
            readyAt,
            observeUntil: until,
            project: "demo-app-1",
            database: "(default)",
            collectionGroup: "orders",
            queryScope: "COLLECTION",
            fields: "status ASCENDING, createdAt DESCENDING",
            ...over,
          },
        },
      });
  }
  const passed = async (): Promise<ProbeVerdict> => ({ state: "passed", probes: 1 });

  it("waits out the window (and the ingest lag) before deciding anything", async () => {
    await seed("w1", new Date(t0.getTime() - 60_000));
    const probe = vi.fn(passed);
    const r = await observeIndexHeals({ db, config: cfg(), probe, now: () => new Date(t0.getTime() + 62 * 60_000) });
    expect(r).toMatchObject({ considered: 1, waiting: 1, decided: [] });
    expect(probe).not.toHaveBeenCalled();
  });

  it("healed: quiet since READY and the query passes; only the run record changes", async () => {
    await seed("h1", new Date(t0.getTime() - 60_000));
    const r = await observeIndexHeals({ db, config: cfg(), probe: passed, now: () => new Date(t0.getTime() + 70 * 60_000) });
    expect(r.decided).toEqual([{ cycleId: "h1_r0", runtime: "healed" }]);
    const doc = (await db.collection(`cycles_${run}`).doc("h1_r0").get()).data()!;
    expect(doc.state).toBe("done");
    expect(doc.summary.index).toMatchObject({ runtime: "healed", fields: "status ASCENDING, createdAt DESCENDING" });
    expect((await db.collection(`incidents_${run}`).doc("h1").get()).data()).not.toHaveProperty("status");
  });

  it("recurred: an occurrence after READY; query-failing; unverified without a probe", async () => {
    await seed("r1", new Date(t0.getTime() + 5 * 60_000));
    await seed("q1", new Date(t0.getTime() - 60_000), { collectionGroup: "invoices" });
    await seed("u1", new Date(t0.getTime() - 60_000), { collectionGroup: "carts" });
    const probe = async (spec: { collectionGroup: string }): Promise<ProbeVerdict> =>
      spec.collectionGroup === "invoices" ? { state: "needs-index", probes: 1 } : { state: "not-configured" };
    const r = await observeIndexHeals({ db, config: cfg(), probe: probe as never, now: () => new Date(t0.getTime() + 70 * 60_000) });
    expect(Object.fromEntries(r.decided.map((d) => [d.cycleId, d.runtime]))).toEqual({ r1_r0: "recurred", q1_r0: "query-failing", u1_r0: "unverified" });
  });

  it("never reports healed for a retired or gone incident: its silence proves nothing; an occurrence after READY is still recurred (#425)", async () => {
    await seed("t1", new Date(t0.getTime() - 60_000));
    await db.collection(`incidents_${run}`).doc("t1").update({ retired: true });
    await seed("t2", new Date(t0.getTime() + 5 * 60_000));
    await db.collection(`incidents_${run}`).doc("t2").update({ retired: true });
    await seed("t3", new Date(t0.getTime() - 60_000));
    await db.collection(`incidents_${run}`).doc("t3").delete();
    const probe = vi.fn(passed);
    const r = await observeIndexHeals({ db, config: cfg(), probe, now: () => new Date(t0.getTime() + 70 * 60_000) });
    expect(Object.fromEntries(r.decided.map((d) => [d.cycleId, d.runtime]))).toEqual({ t1_r0: "unverified", t2_r0: "recurred", t3_r0: "unverified" });
    expect(probe).not.toHaveBeenCalled();
    for (const id of ["t1_r0", "t3_r0"]) {
      expect((await db.collection(`cycles_${run}`).doc(id).get()).data()!.summary.index.runtimeBasis).toContain("retired or is gone");
    }
  });

  it("gives every observing heal its turn: one that stays undecided never keeps another from being decided (#422)", async () => {
    await seed("a1", new Date(t0.getTime() - 60_000), { collectionGroup: "carts" });
    await seed("b1", new Date(t0.getTime() - 60_000));
    const probe = async (spec: { collectionGroup: string }): Promise<ProbeVerdict> => {
      if (spec.collectionGroup === "carts") throw new Error("unavailable");
      return { state: "passed", probes: 1 };
    };
    const look = (minutes: number) => observeIndexHeals({ db, config: cfg(), probe: probe as never, now: () => new Date(t0.getTime() + minutes * 60_000), limit: 1 });
    expect((await look(70)).errors.map((e) => e.cycleId)).toEqual(["a1_r0"]);
    expect((await look(71)).decided).toEqual([{ cycleId: "b1_r0", runtime: "healed" }]);
    expect((await look(72)).errors.map((e) => e.cycleId)).toEqual(["a1_r0"]);
  });

  it("leaves a cycle observing when the probe throws, to try again next pass", async () => {
    await seed("e1", new Date(t0.getTime() - 60_000));
    const r = await observeIndexHeals({
      db,
      config: cfg(),
      probe: async () => {
        throw new Error("unavailable");
      },
      now: () => new Date(t0.getTime() + 70 * 60_000),
    });
    expect(r.errors).toHaveLength(1);
    expect((await db.collection(`cycles_${run}`).doc("e1_r0").get()).data()!.summary.index.runtime).toBe("observing");
  });

  it("a probe that could not run (UNAVAILABLE) is a failed read, not query-failing: still observing, unverified a day later (#232)", async () => {
    await seed("p1", new Date(t0.getTime() - 60_000));
    const probe = unavailableProbe();
    const r = await observeIndexHeals({ db, config: cfg(), probe, now: () => new Date(t0.getTime() + 70 * 60_000) });
    expect(r.decided).toEqual([]);
    expect(r.errors).toEqual([{ cycleId: "p1_r0", message: "probe inconclusive: a probe failed with code 14" }]);
    expect((await db.collection(`cycles_${run}`).doc("p1_r0").get()).data()!.summary.index.runtime).toBe("observing");

    const later = await observeIndexHeals({ db, config: cfg(), probe, now: () => new Date(t0.getTime() + 60 * 60_000 + 24 * 3600_000) });
    expect(later.decided).toEqual([{ cycleId: "p1_r0", runtime: "unverified" }]);
    const rec = (await db.collection(`cycles_${run}`).doc("p1_r0").get()).data()!.summary.index;
    expect(rec.runtimeBasis).toContain("could not be replayed");
  });

  it("a stalled ingest is not a quiet window (#188): no checkpoint, one short of the window, or another target's keeps it observing", async () => {
    await seed("s1", new Date(t0.getTime() - 60_000));
    const probe = vi.fn(passed);
    const at70 = () => new Date(t0.getTime() + 70 * 60_000);
    await db.collection(`runs_${run}`).doc("state").delete();
    expect(await observeIndexHeals({ db, config: cfg(), probe, now: at70 })).toMatchObject({ uncovered: 1, decided: [] });
    await ingested(new Date(t0.getTime() + 59 * 60_000));
    expect(await observeIndexHeals({ db, config: cfg(), probe, now: at70 })).toMatchObject({ uncovered: 1, decided: [] });
    await ingested(new Date(t0.getTime() + 65 * 60_000), { watchedProjectId: "other-app", environment: "demo" });
    expect(await observeIndexHeals({ db, config: cfg(), probe, now: at70 })).toMatchObject({ uncovered: 1, decided: [] });
    expect(probe).not.toHaveBeenCalled();
    expect((await db.collection(`cycles_${run}`).doc("s1_r0").get()).data()!.summary.index.runtime).toBe("observing");

    // Once ingest has read through the window, the same record is a quiet one.
    await ingested(new Date(t0.getTime() + 60 * 60_000));
    expect((await observeIndexHeals({ db, config: cfg(), probe, now: at70 })).decided).toEqual([{ cycleId: "s1_r0", runtime: "healed" }]);
  });

  it("an occurrence after READY is recurred even when ingest has not caught up; a window never covered is unverified after a day", async () => {
    await db.collection(`runs_${run}`).doc("state").delete();
    await seed("c1", new Date(t0.getTime() + 5 * 60_000));
    await seed("c2", new Date(t0.getTime() - 60_000));
    const r = await observeIndexHeals({ db, config: cfg(), probe: passed, now: () => new Date(t0.getTime() + 60 * 60_000 + 24 * 3600_000) });
    expect(Object.fromEntries(r.decided.map((d) => [d.cycleId, d.runtime]))).toEqual({ c1_r0: "recurred", c2_r0: "unverified" });
    const c2 = (await db.collection(`cycles_${run}`).doc("c2_r0").get()).data()!.summary.index;
    expect(c2.runtimeBasis).toContain("ingest had not read the logs through the window");
  });
});

describe("readIndexFileText", () => {
  it("is null when absent, the text when present, and undefined for a symlink out of the checkout", async () => {
    expect(await readIndexFileText(src, "missing.json")).toBeNull();
    expect(await readIndexFileText(src, "firestore.indexes.json")).toContain("indexes");
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      writeFileSync(join(outside, "secret.json"), "{}");
      symlinkSync(join(outside, "secret.json"), join(src, "linked.json"));
      expect(await readIndexFileText(src, "linked.json")).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/** The new file content from a one-hunk diff that the opener would apply: the `+` and context lines, in order. */
function readAfter(patch: string): string {
  const body = patch.split("\n").slice(patch.split("\n").findIndex((l) => l.startsWith("@@")) + 1);
  return body
    .filter((l) => (l.startsWith("+") || l.startsWith(" ")) && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}
