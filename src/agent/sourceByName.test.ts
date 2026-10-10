import { describe, expect, it, vi } from "vitest";
import { definesExport, exportNameOf, findSourceByFunctionName, nameSearchCandidates } from "./sourceByName.js";

/** A repository as a map of path -> content; `read` returns what is there, like assemble.ts's readSource. */
const repo = (files: Record<string, string>) => {
  const read = vi.fn(async (rel: string) => (rel in files ? { path: rel, content: files[rel]! } : null));
  return { paths: Object.keys(files), read };
};
const find = (name: string | undefined, files: Record<string, string>, opts: Partial<Parameters<typeof findSourceByFunctionName>[3]> = {}) => {
  const r = repo(files);
  return findSourceByFunctionName(name, r.paths, r.read, { roots: [], excluded: [], ...opts });
};

describe("exportNameOf", () => {
  it("takes the last part of a grouped name as the export and the rest as its groups", () => {
    expect(exportNameOf("orders-createOrder")).toEqual({ name: "createOrder", groups: ["orders"] });
    expect(exportNameOf("admin-orders-refund")).toEqual({ name: "refund", groups: ["admin", "orders"] });
    expect(exportNameOf("createOrder")).toEqual({ name: "createOrder", groups: [] });
  });

  it("refuses a name that is not identifiers joined by '-'", () => {
    for (const bad of [undefined, "", "-x", "x-", "a--b", "orders/create", "a b", "1abc", "x".repeat(201)]) expect(exportNameOf(bad)).toBeNull();
  });
});

describe("nameSearchCandidates", () => {
  const files = [
    "functions/src/orders.ts",
    "functions/src/orders.test.ts",
    "functions/src/__tests__/x.ts",
    "functions/src/types.d.ts",
    "functions/node_modules/dep/index.js",
    "functions/README.md",
    "web/src/App.tsx",
    "functions/src/secrets/key.ts",
    "a.mjs",
  ];
  it("keeps code files that are not tests, declarations, dependencies or excluded, sorted", () => {
    expect(nameSearchCandidates(files, [], ["secrets/"])).toEqual(["a.mjs", "functions/src/orders.ts", "web/src/App.tsx"]);
  });
  it("keeps only files under the configured roots", () => {
    expect(nameSearchCandidates(files, ["functions/src"], [])).toEqual(["functions/src/orders.ts", "functions/src/secrets/key.ts"]);
    // A root is a directory, not a prefix of a name.
    expect(nameSearchCandidates(["functions/srcx/a.ts"], ["functions/src"], [])).toEqual([]);
  });
});

describe("definesExport", () => {
  it.each([
    "export const createOrder = onCall(async () => {});",
    "export let createOrder = 1;",
    "export async function createOrder(req) {}",
    "export function* createOrder() {}",
    "export class createOrder {}",
    "export declare const createOrder: unknown;",
    "const createOrder = 1;\nexport { createOrder };",
    "const impl = 1;\nexport { other, impl as createOrder };",
    "exports.createOrder = functions.https.onCall(() => {});",
    "module.exports.createOrder = functions.https.onCall(() => {});",
    "module.exports = { createOrder, other: x };",
    "module.exports = { createOrder: handler };",
  ])("finds the definition in %j", (src) => expect(definesExport(src, "createOrder")).toBe("exact"));

  it.each([
    'export { createOrder } from "./orders";',
    'export { impl as createOrder } from "./orders";',
    'export * from "./orders";',
    "export const createOrderV2 = 1;",
    "export const xcreateOrder = 1;",
    "const createOrder = 1;",
    "foo.exports.createOrder = 1;",
    "exports.createOrder == x;",
    "export { createOrder as other };",
    "export { type createOrder };",
    "createOrder();",
  ])("does not count %j", (src) => expect(definesExport(src, "createOrder")).toBeNull());

  it("matches ignoring case only as a weaker 'folded' hit (a gen2 service name is lowercased)", () => {
    expect(definesExport("export const createOrder = 1;", "createorder")).toBe("folded");
    expect(definesExport("export const createorder = 1;\nexport const createOrder = 2;", "createorder")).toBe("exact");
  });

  it("escapes a '$' in the name", () => {
    expect(definesExport("export const $create = 1;", "$create")).toBe("exact");
    expect(definesExport("export const xcreate = 1;", "$create")).toBeNull();
  });
});

describe("findSourceByFunctionName", () => {
  const ORDERS = "export const createOrder = onCall(async (req) => {\n  return db.add(req.data);\n});\n";

  it("finds the one file that defines the export a grouped name stands for", async () => {
    const r = await find("orders-createOrder", {
      "functions/src/index.ts": 'export * as orders from "./orders";\nexport { createOrder } from "./orders";\n',
      "functions/src/orders.ts": ORDERS,
      "functions/src/billing.ts": "export const charge = 1;\n",
    });
    expect(r).toEqual({ outcome: "found", file: { path: "functions/src/orders.ts", content: ORDERS } });
  });

  it("finds an ungrouped name", async () => {
    expect((await find("createOrder", { "src/a.ts": ORDERS, "src/b.ts": "export const x = 1;" })).file?.path).toBe("src/a.ts");
  });

  it("finds a gen2 service's lowercased name, and prefers an exact match when there is one", async () => {
    expect((await find("orders-createorder", { "src/orders.ts": ORDERS })).file?.path).toBe("src/orders.ts");
    const both = { "src/orders.ts": ORDERS, "src/legacy.ts": "export const createorder = 1;\n" };
    expect((await find("orders-createorder", both)).file?.path).toBe("src/legacy.ts");
  });

  it("takes the TypeScript source over its compiled twin kept in the repository", async () => {
    const r = await find("orders-createOrder", { "functions/lib/orders.js": "exports.createOrder = x;", "functions/src/orders.ts": ORDERS });
    expect(r.file?.path).toBe("functions/src/orders.ts");
  });

  it("uses the group to choose between files that define the same export", async () => {
    const files = { "src/orders/create.ts": ORDERS, "src/billing/create.ts": ORDERS };
    expect((await find("orders-createOrder", files)).file?.path).toBe("src/orders/create.ts");
    expect((await find("billing-createOrder", files)).file?.path).toBe("src/billing/create.ts");
  });

  it("takes nothing when several files define it and the group does not tell them apart", async () => {
    const files = { "src/a.ts": ORDERS, "src/b.ts": ORDERS };
    expect(await find("createOrder", files)).toEqual({ outcome: "ambiguous" });
    expect(await find("orders-createOrder", files)).toEqual({ outcome: "ambiguous" });
    expect(await find("orders-createOrder", { "src/orders/a.ts": ORDERS, "src/orders/b.ts": ORDERS })).toEqual({ outcome: "ambiguous" });
  });

  it("says why it found nothing: no name, no definition, or a repository larger than it reads", async () => {
    expect(await find(undefined, { "src/a.ts": ORDERS })).toEqual({ outcome: "no-name" });
    expect(await find("orders/createOrder", { "src/a.ts": ORDERS })).toEqual({ outcome: "no-name" });
    expect(await find("orders-createOrder", { "src/a.ts": "export const other = 1;" })).toEqual({ outcome: "no-export" });
    expect(await find("orders-createOrder", { "src/a.ts": ORDERS, "src/b.ts": "" }, { maxFiles: 1 })).toEqual({ outcome: "capped" });
    expect(await find("orders-createOrder", { "src/a.ts": "x".repeat(50), "src/b.ts": ORDERS }, { maxChars: 60 })).toEqual({ outcome: "capped" });
  });

  it("reads nothing at all when there are more candidate files than it may read", async () => {
    const r = repo({ "src/a.ts": ORDERS, "src/b.ts": "" });
    await findSourceByFunctionName("createOrder", r.paths, r.read, { roots: [], excluded: [], maxFiles: 1 });
    expect(r.read).not.toHaveBeenCalled();
  });

  it("never shows an excluded, test, dependency or out-of-root file", async () => {
    expect(await find("createOrder", { "src/orders.test.ts": ORDERS, "node_modules/x/index.js": ORDERS, "src/secret/x.ts": ORDERS }, { excluded: ["secret/"] })).toEqual({ outcome: "no-export" });
    expect(await find("createOrder", { "web/src/a.ts": ORDERS, "functions/src/b.ts": ORDERS }, { roots: ["functions/src"] })).toMatchObject({ file: { path: "functions/src/b.ts" } });
  });

  it("passes over a file it may not read (too big, binary, a symlink) without stopping", async () => {
    const read = vi.fn(async (rel: string) => (rel === "src/a.ts" ? null : { path: rel, content: ORDERS }));
    expect(await findSourceByFunctionName("createOrder", ["src/a.ts", "src/b.ts"], read, { roots: [], excluded: [] })).toMatchObject({ outcome: "found", file: { path: "src/b.ts" } });
  });
});
