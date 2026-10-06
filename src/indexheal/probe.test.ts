import { describe, expect, it, vi } from "vitest";
import type { IndexSpec } from "./createIndexUrl.js";
import { createIndexProbe, parseIndexProbes, probesFor, runProbe, type IndexProbeSpec } from "./probe.js";

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
function urlFor(fields: [string, number][] = [["status", 1], ["createdAt", 2]]): string {
  const bytes = [...str(1, "projects/demo-app-1/databases/(default)/collectionGroups/orders/indexes/_"), ...int(2, 1)];
  for (const [path, order] of fields) bytes.push(...lenDelimited(3, [...str(1, path), ...int(2, order)]));
  return `https://console.firebase.google.com/v1/r/project/demo-app-1/firestore/indexes?create_composite=${Buffer.from(bytes).toString("base64url")}`;
}
const needsIndex = (u = urlFor()) => Object.assign(new Error(`9 FAILED_PRECONDITION: The query requires an index. You can create it here: ${u}`), { code: 9 });

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
const PROBE_JSON = JSON.stringify([{ target: "demo-app-1/(default)", collection: "orders", where: [["status", "==", "open"]], orderBy: [["createdAt", "desc"]] }]);

describe("parseIndexProbes", () => {
  it("is empty when unset, so no index can be confirmed or created", () => {
    expect(parseIndexProbes(undefined)).toEqual([]);
    expect(parseIndexProbes("  ")).toEqual([]);
  });

  it("reads a probe, COLLECTION scope by default", () => {
    expect(parseIndexProbes(PROBE_JSON)).toEqual([
      {
        project: "demo-app-1",
        database: "(default)",
        collection: "orders",
        scope: "COLLECTION",
        where: [{ field: "status", op: "==", value: "open" }],
        orderBy: [{ field: "createdAt", direction: "desc" }],
      },
    ]);
  });

  it("accepts a subcollection path and a collection-group id", () => {
    const [a, b] = parseIndexProbes(
      JSON.stringify([
        { target: "demo-app-1/(default)", collection: "users/u1/orders", orderBy: [["createdAt", "asc"]] },
        { target: "demo-app-1/(default)", collection: "orders", scope: "COLLECTION_GROUP", where: [["n", ">", 3]] },
      ])
    );
    expect(probesFor({ ...SPEC }, [a!])).toHaveLength(1);
    expect(b!.scope).toBe("COLLECTION_GROUP");
  });

  it.each([
    ["not JSON", "{", "not JSON"],
    ["not an array", "{}", "JSON array"],
    ["an unknown key", JSON.stringify([{ target: "demo-app-1/(default)", collection: "orders", where: [["a", "==", 1]], limit: 5 }]), "unknown key"],
    ["a bad target", JSON.stringify([{ target: "demo-app-1", collection: "orders", where: [["a", "==", 1]] }]), "target"],
    ["a document path", JSON.stringify([{ target: "demo-app-1/(default)", collection: "orders/o1", where: [["a", "==", 1]] }]), "collection"],
    ["a group id with slashes", JSON.stringify([{ target: "demo-app-1/(default)", collection: "a/b/c", scope: "COLLECTION_GROUP", where: [["a", "==", 1]] }]), "collection"],
    ["no clauses", JSON.stringify([{ target: "demo-app-1/(default)", collection: "orders" }]), "clauses"],
    ["a bad op", JSON.stringify([{ target: "demo-app-1/(default)", collection: "orders", where: [["a", "in", [1]]] }]), "op"],
    ["an object value", JSON.stringify([{ target: "demo-app-1/(default)", collection: "orders", where: [["a", "==", { x: 1 }]] }]), "value"],
    ["a bad field", JSON.stringify([{ target: "demo-app-1/(default)", collection: "orders", where: [["a b", "==", 1]] }]), "field"],
    ["a bad direction", JSON.stringify([{ target: "demo-app-1/(default)", collection: "orders", orderBy: [["a", "up"]] }]), "direction"],
  ])("refuses %s at startup", (_name, raw, msg) => {
    expect(() => parseIndexProbes(raw)).toThrow(msg);
  });
});

describe("runProbe", () => {
  const probe = parseIndexProbes(PROBE_JSON)[0]!;

  it("passes when the query returns", async () => {
    expect(await runProbe(probe, async () => undefined)).toEqual({ state: "passed" });
  });

  it("reads Google's own error into the spec it names", async () => {
    expect(await runProbe(probe, async () => Promise.reject(needsIndex()))).toEqual({ state: "needs-index", spec: SPEC });
  });

  it("does not take the words alone, or another code, for a missing index; keeps no message text", async () => {
    const words = Object.assign(new Error("The query requires an index."), { code: 9 });
    expect(await runProbe(probe, async () => Promise.reject(words))).toEqual({ state: "error", code: "9" });
    const denied = Object.assign(new Error(`denied ${urlFor()}`), { code: 7 });
    expect(await runProbe(probe, async () => Promise.reject(denied))).toEqual({ state: "error", code: "7" });
    expect(await runProbe(probe, async () => Promise.reject(new Error("boom")))).toEqual({ state: "error", code: "unknown" });
  });
});

describe("createIndexProbe", () => {
  const probes: IndexProbeSpec[] = parseIndexProbes(PROBE_JSON);

  it("is not-configured, and runs nothing, for a collection with no probe", async () => {
    const run = vi.fn(async () => undefined);
    expect(await createIndexProbe(probes, run)({ ...SPEC, collectionGroup: "invoices" })).toEqual({ state: "not-configured" });
    expect(await createIndexProbe(probes, run)({ ...SPEC, project: "demo-other-app" })).toEqual({ state: "not-configured" });
    expect(await createIndexProbe(probes, run)({ ...SPEC, queryScope: "COLLECTION_GROUP" })).toEqual({ state: "not-configured" });
    expect(run).not.toHaveBeenCalled();
  });

  it("confirms only exactly this index", async () => {
    expect(await createIndexProbe(probes, async () => Promise.reject(needsIndex()))(SPEC)).toEqual({ state: "needs-index", probes: 1 });
    const other = needsIndex(urlFor([["status", 1], ["total", 1]]));
    expect(await createIndexProbe(probes, async () => Promise.reject(other))(SPEC)).toMatchObject({ state: "inconclusive", reason: "a probe needs a different index" });
  });

  it("passes when the query works, and is inconclusive when it could not run", async () => {
    expect(await createIndexProbe(probes, async () => undefined)(SPEC)).toEqual({ state: "passed", probes: 1 });
    expect(await createIndexProbe(probes, async () => Promise.reject(Object.assign(new Error("x"), { code: 14 })))(SPEC)).toMatchObject({ state: "inconclusive" });
  });
});
