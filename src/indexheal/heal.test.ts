import { describe, expect, it, vi } from "vitest";
import type { IndexSpec } from "./createIndexUrl.js";
import type { IndexAdmin, LiveIndex } from "./firestoreAdmin.js";
import { healIndex, sameIndex, type HealDeps, type HealSettings } from "./heal.js";
import type { ProbeVerdict } from "./probe.js";

// ---- A create-index URL built from the documented Index message (name=1, query_scope=2, fields=3) ----------

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

function urlFor(project = "demo-app-1", database = "(default)", fields: [string, number][] = [["status", 1], ["createdAt", 2]]): string {
  const bytes = [...str(1, `projects/${project}/databases/${database}/collectionGroups/orders/indexes/_`), ...int(2, 1)];
  for (const [path, order] of fields) bytes.push(...lenDelimited(3, [...str(1, path), ...int(2, order)]));
  return `https://console.firebase.google.com/v1/r/project/${project}/firestore/indexes?create_composite=${Buffer.from(bytes).toString("base64url")}`;
}
const ERROR = (u = urlFor()) => `9 FAILED_PRECONDITION: The query requires an index. You can create it here: ${u}`;

const SPEC: IndexSpec = {
  project: "demo-app-1",
  database: "(default)",
  collectionGroup: "orders",
  queryScope: "COLLECTION",
  fields: [
    { fieldPath: "status", order: "ASCENDING" },
    { fieldPath: "createdAt", order: "DESCENDING" },
  ],
};
const live = (state: LiveIndex["state"], over: Partial<LiveIndex> = {}): LiveIndex => ({
  name: "projects/demo-app-1/databases/(default)/collectionGroups/orders/indexes/abc",
  state,
  queryScope: "COLLECTION",
  fields: [
    { fieldPath: "status", order: "ASCENDING" },
    { fieldPath: "createdAt", order: "DESCENDING" },
    { fieldPath: "__name__", order: "DESCENDING" },
  ],
  ...over,
});

const SETTINGS: HealSettings = {
  allowedTargets: [{ project: "demo-app-1", database: "(default)" }],
  own: { project: "starfish-proj", database: "starfish" },
  autoApply: true,
  dryRun: false,
  dailyCap: 3,
  pollMs: 10,
  maxWaitMs: 100,
};

function harness(
  over: { list?: LiveIndex[][]; ops?: { done: boolean; error?: { code: number; message: string } }[]; automation?: boolean[]; created?: number; file?: unknown; probe?: ProbeVerdict[] } = {}
) {
  const lists = [...(over.list ?? [[]])];
  const ops = [...(over.ops ?? [{ done: true }])];
  const automation = [...(over.automation ?? [true])];
  let t = 0;
  const calls: string[] = [];
  let lastList: LiveIndex[] = [];
  const probes = over.probe ? [...over.probe] : undefined;
  const admin: IndexAdmin = {
    list: vi.fn(async () => {
      calls.push("list");
      lastList = lists.length > 1 ? lists.shift()! : lists[0]!;
      return lastList;
    }),
    create: vi.fn(async () => {
      calls.push("create");
      return { operation: "projects/demo-app-1/databases/(default)/operations/op1" };
    }),
    getOperation: vi.fn(async () => {
      calls.push("op");
      return ops.length > 1 ? ops.shift()! : ops[0]!;
    }),
  };
  const deps: HealDeps = {
    admin,
    automationOn: vi.fn(async () => (automation.length > 1 ? automation.shift()! : automation[0]!)),
    readIndexFile: vi.fn(async () => ("file" in over ? over.file : { indexes: [] })),
    createdToday: vi.fn(async () => over.created ?? 0),
    onCreating: vi.fn(async () => {
      calls.push("creating");
    }),
    onOperation: vi.fn(async () => {
      calls.push("persist");
    }),
    // By default the replayed query fails for this index until one exists (created here, or listed READY), then passes.
    probe: vi.fn(async (): Promise<ProbeVerdict> => {
      calls.push("probe");
      if (probes) return probes.length > 1 ? probes.shift()! : probes[0]!;
      return calls.includes("create") || lastList.some((l) => l.state === "READY" && sameIndex(SPEC, l)) ? { state: "passed", probes: 1 } : { state: "needs-index", probes: 1 };
    }),
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    now: () => t,
  };
  return { admin, deps, calls };
}

describe("healIndex: what it refuses before touching anything", () => {
  it("refuses an error with no create-index URL", async () => {
    const h = harness();
    expect(await healIndex("9 FAILED_PRECONDITION: nothing useful", SETTINGS, h.deps)).toMatchObject({ outcome: "refused", rule: "no-url" });
    expect(h.admin.list).not.toHaveBeenCalled();
  });

  it("refuses an array index and a bad spec without a call", async () => {
    const h = harness();
    const bytes = [...str(1, "projects/demo-app-1/databases/(default)/collectionGroups/orders/indexes/_"), ...int(2, 1), ...lenDelimited(3, [...str(1, "tags"), ...int(3, 1)])];
    const u = `https://console.firebase.google.com/v1/r/project/demo-app-1/firestore/indexes?create_composite=${Buffer.from(bytes).toString("base64url")}`;
    expect(await healIndex(ERROR(u), SETTINGS, h.deps)).toMatchObject({ outcome: "refused", rule: "unsupported-spec" });
    expect(h.admin.list).not.toHaveBeenCalled();
  });

  it("refuses a project that is not on the allowlist", async () => {
    const h = harness();
    expect(await healIndex(ERROR(urlFor("other-app-1")), SETTINGS, h.deps)).toMatchObject({ outcome: "refused", rule: "target-not-allowed" });
    expect(h.admin.create).not.toHaveBeenCalled();
  });

  it("refuses Starfish's own database even when it is listed", async () => {
    const h = harness();
    const s = { ...SETTINGS, allowedTargets: [{ project: "starfish-proj", database: "starfish" }] };
    expect(await healIndex(ERROR(urlFor("starfish-proj", "starfish")), s, h.deps)).toMatchObject({ outcome: "refused", rule: "own-database" });
  });

  it("creates nothing when indexAutoApply is off, even with dryRun off", async () => {
    const h = harness();
    expect(await healIndex(ERROR(), { ...SETTINGS, autoApply: false }, h.deps)).toMatchObject({ outcome: "switched-off" });
    expect(h.admin.create).not.toHaveBeenCalled();
  });

  it("creates nothing when the automation switch is off or throws", async () => {
    const off = harness({ automation: [false] });
    expect(await healIndex(ERROR(), SETTINGS, off.deps)).toMatchObject({ outcome: "switched-off" });
    const broken = harness();
    broken.deps.automationOn = vi.fn(async () => {
      throw new Error("settings unreadable");
    });
    expect(await healIndex(ERROR(), SETTINGS, broken.deps)).toMatchObject({ outcome: "switched-off" });
    expect(off.admin.create).not.toHaveBeenCalled();
    expect(broken.admin.create).not.toHaveBeenCalled();
  });

  it("refuses an equal index that needs repair: that is for a person", async () => {
    const h = harness({ list: [[live("NEEDS_REPAIR")]] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "refused", rule: "needs-repair" });
    expect(h.admin.create).not.toHaveBeenCalled();
  });
});

describe("healIndex: a dry run", () => {
  it("reads, reports what it would do, and creates nothing, whatever the other switches say", async () => {
    const h = harness();
    const r = await healIndex(ERROR(), { ...SETTINGS, dryRun: true }, h.deps);
    expect(r).toMatchObject({ outcome: "dry-run", live: "absent", repoFile: "absent", spec: SPEC });
    expect(h.admin.create).not.toHaveBeenCalled();
    expect(h.deps.onOperation).not.toHaveBeenCalled();
  });

  it("does not need the automation switch, and says when the index is already there", async () => {
    const h = harness({ list: [[live("READY")]], automation: [false] });
    expect(await healIndex(ERROR(), { ...SETTINGS, dryRun: true, autoApply: false }, h.deps)).toMatchObject({ outcome: "dry-run", live: "ready" });
  });
});

describe("healIndex: creating", () => {
  it("creates once, persists the operation before waiting, and reports READY", async () => {
    const h = harness({ ops: [{ done: false }, { done: false }, { done: true }] });
    const r = await healIndex(ERROR(), SETTINGS, h.deps);
    expect(r).toMatchObject({ outcome: "ready", created: true, operation: "projects/demo-app-1/databases/(default)/operations/op1", repoFile: "absent" });
    expect(h.admin.create).toHaveBeenCalledTimes(1);
    expect(h.calls.indexOf("persist")).toBe(h.calls.indexOf("create") + 1);
    expect(h.calls.indexOf("persist")).toBeLessThan(h.calls.indexOf("op"));
  });

  it("rechecks the switch right before the mutation", async () => {
    const h = harness({ automation: [true, false] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "switched-off", reason: expect.stringContaining("went off") });
    expect(h.admin.create).not.toHaveBeenCalled();
  });

  it("stops at the daily cap", async () => {
    const h = harness({ created: 3 });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "cap-reached", created: 3, cap: 3 });
    expect(h.admin.create).not.toHaveBeenCalled();
  });

  it("reports a failed build, with Google's reason, and never retries the create", async () => {
    const h = harness({ ops: [{ done: true, error: { code: 9, message: "index limit reached" } }] });
    const r = await healIndex(ERROR(), SETTINGS, h.deps);
    expect(r).toMatchObject({ outcome: "build-failed", reason: expect.stringContaining("index limit reached") });
    expect(h.admin.create).toHaveBeenCalledTimes(1);
  });

  it("gives up waiting after maxWaitMs and says which operation to look at", async () => {
    const h = harness({ ops: [{ done: false }] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "timeout", operation: "projects/demo-app-1/databases/(default)/operations/op1" });
  });

  it("lets an infrastructure failure throw so the cycle resumes", async () => {
    const h = harness();
    h.admin.list = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    await expect(healIndex(ERROR(), SETTINGS, h.deps)).rejects.toThrow("503");
    expect(h.admin.create).not.toHaveBeenCalled();
  });
});

describe("healIndex: reconciling what is already there (including after a crash)", () => {
  it("creates nothing when the equal index is READY", async () => {
    const h = harness({ list: [[live("READY")]] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "ready", created: false });
    expect(h.admin.create).not.toHaveBeenCalled();
    expect(h.deps.createdToday).not.toHaveBeenCalled();
  });

  it("waits on an index that is still building instead of creating a second one", async () => {
    const h = harness({ list: [[live("CREATING")], [live("CREATING")], [live("READY")]] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "ready", created: false });
    expect(h.admin.create).not.toHaveBeenCalled();
  });

  it("times out on one that never finishes building", async () => {
    const h = harness({ list: [[live("CREATING")]] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "timeout" });
  });

  it("does not mistake a different index of the same collection for the wanted one", async () => {
    const other = live("READY", { fields: [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "__name__", order: "ASCENDING" }] });
    const h = harness({ list: [[other]] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "ready", created: true });
    expect(h.admin.create).toHaveBeenCalledTimes(1);
  });

  it("tells the pull-request step whether the repository already has the entry, and never calls an unreadable file absent", async () => {
    const entry = { collectionGroup: "orders", queryScope: "COLLECTION", fields: [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "createdAt", order: "DESCENDING" }] };
    expect(await healIndex(ERROR(), SETTINGS, harness({ file: { indexes: [entry] } }).deps)).toMatchObject({ repoFile: "present" });
    expect(await healIndex(ERROR(), SETTINGS, harness({ file: null }).deps)).toMatchObject({ repoFile: "unknown" });
    const unreadable = harness();
    unreadable.deps.readIndexFile = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    expect(await healIndex(ERROR(), SETTINGS, unreadable.deps)).toMatchObject({ outcome: "ready", repoFile: "unknown" });
  });
});

describe("healIndex: the replayed query (the deterministic probe)", () => {
  it("creates nothing when no probe is configured for the collection: the URL alone is not the query", async () => {
    const h = harness({ probe: [{ state: "not-configured" }] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "refused", rule: "no-probe" });
    expect(h.admin.create).not.toHaveBeenCalled();
    expect(h.deps.onCreating).not.toHaveBeenCalled();
  });

  it("creates nothing when the probe passes already, or fails some other way", async () => {
    for (const verdict of [{ state: "passed", probes: 1 }, { state: "inconclusive", probes: 1, reason: "a probe failed with code 7" }] as ProbeVerdict[]) {
      const h = harness({ probe: [verdict] });
      expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "refused", rule: "probe-not-confirmed" });
      expect(h.admin.create).not.toHaveBeenCalled();
    }
  });

  it("records the attempt before the create and replays the query after READY", async () => {
    const h = harness();
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "ready", created: true, probe: "passed" });
    expect(h.calls.filter((c) => ["probe", "creating", "create", "persist"].includes(c))).toEqual(["probe", "creating", "create", "persist", "probe"]);
  });

  it("says when the index is READY but the query still fails: not healed", async () => {
    const h = harness({ probe: [{ state: "needs-index", probes: 1 }] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "ready", probe: "needs-index" });
  });

  it("checks the probe after reconciling an index that was already READY", async () => {
    const h = harness({ list: [[live("READY")]] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps)).toMatchObject({ outcome: "ready", created: false, probe: "passed" });
  });

  it("reports what the probe says in a dry run, and creates nothing", async () => {
    const h = harness();
    expect(await healIndex(ERROR(), { ...SETTINGS, dryRun: true }, h.deps)).toMatchObject({ outcome: "dry-run", probe: "needs-index" });
    expect(h.admin.create).not.toHaveBeenCalled();
  });
});

describe("healIndex: a restart after the create", () => {
  it("polls the operation an earlier attempt persisted instead of creating a second index", async () => {
    const h = harness({ ops: [{ done: false }, { done: true }] });
    const op = "projects/demo-app-1/databases/(default)/operations/earlier";
    expect(await healIndex(ERROR(), SETTINGS, h.deps, { priorOperation: op })).toMatchObject({ outcome: "ready", created: true, operation: op });
    expect(h.admin.create).not.toHaveBeenCalled();
    expect(h.deps.createdToday).not.toHaveBeenCalled();
    expect(h.admin.getOperation).toHaveBeenCalledWith(op);
  });

  it("reports the persisted operation's failure and never retries the create", async () => {
    const h = harness({ ops: [{ done: true, error: { code: 8, message: "quota" } }] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps, { priorOperation: "projects/demo-app-1/databases/(default)/operations/x" })).toMatchObject({ outcome: "build-failed" });
    expect(h.admin.create).not.toHaveBeenCalled();
  });

  it("never creates again after an earlier attempt that left no operation and no index", async () => {
    const h = harness();
    expect(await healIndex(ERROR(), SETTINGS, h.deps, { priorAttempt: true })).toMatchObject({ outcome: "refused", rule: "unresolved-earlier-create" });
    expect(h.admin.create).not.toHaveBeenCalled();
  });

  it("prefers the live inventory over a persisted operation when the index is listed", async () => {
    const h = harness({ list: [[live("READY")]] });
    expect(await healIndex(ERROR(), SETTINGS, h.deps, { priorOperation: "projects/demo-app-1/databases/(default)/operations/x" })).toMatchObject({ outcome: "ready", created: false });
    expect(h.admin.getOperation).not.toHaveBeenCalled();
  });
});

describe("sameIndex", () => {
  it("ignores the trailing __name__, and compares scope, order and field order", () => {
    expect(sameIndex(SPEC, live("READY"))).toBe(true);
    expect(sameIndex(SPEC, live("READY", { queryScope: "COLLECTION_GROUP" }))).toBe(false);
    expect(sameIndex(SPEC, live("READY", { fields: [{ fieldPath: "createdAt", order: "DESCENDING" }, { fieldPath: "status", order: "ASCENDING" }] }))).toBe(false);
    expect(sameIndex(SPEC, live("READY", { fields: [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "createdAt", order: "OTHER" }] }))).toBe(false);
  });
});
