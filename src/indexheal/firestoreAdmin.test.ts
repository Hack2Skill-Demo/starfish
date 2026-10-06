import { describe, expect, it, vi } from "vitest";
import type { IndexSpec } from "./createIndexUrl.js";
import { createFirestoreAdmin, FirestoreAdminError } from "./firestoreAdmin.js";

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
const OP = "projects/demo-app-1/databases/(default)/operations/ABC123";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function admin(...responses: (Response | Error)[]) {
  const queue = [...responses];
  const fetchFn = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => {
    const next = queue.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  return { api: createFirestoreAdmin({ token: async () => "tok", fetch: fetchFn as unknown as typeof fetch }), fetchFn };
}

describe("createFirestoreAdmin", () => {
  it("creates one index with a POST to the collection group and returns the operation's name", async () => {
    const { api, fetchFn } = admin(json({ name: OP }));
    expect(await api.create(SPEC)).toEqual({ operation: OP });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://firestore.googleapis.com/v1/projects/demo-app-1/databases/(default)/collectionGroups/orders/indexes");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "createdAt", order: "DESCENDING" },
      ],
    });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("throws on a refusal naming the status and nothing from the body", async () => {
    const { api } = admin(json({ error: { message: "secret detail" } }, 409));
    const err = await api.create(SPEC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FirestoreAdminError);
    expect((err as FirestoreAdminError).status).toBe(409);
    expect((err as Error).message).toBe("create index: HTTP 409");
  });

  it("throws when the response names no valid operation, rather than trusting it", async () => {
    await expect(admin(json({ name: "not-an-operation" })).api.create(SPEC)).rejects.toThrow("no operation");
  });

  it("wraps a network failure without leaking its message", async () => {
    await expect(admin(new Error("ECONNRESET 10.0.0.1")).api.create(SPEC)).rejects.toThrow("the request did not complete");
  });

  it("lists every page and keeps array and vector fields apart from plain ones", async () => {
    const idx = (n: string, fields: unknown[], state = "READY") => ({ name: `projects/p/databases/d/collectionGroups/orders/indexes/${n}`, state, queryScope: "COLLECTION", fields });
    const { api, fetchFn } = admin(
      json({ indexes: [idx("a", [{ fieldPath: "status", order: "ASCENDING" }])], nextPageToken: "t2" }),
      json({ indexes: [idx("b", [{ fieldPath: "tags", arrayConfig: "CONTAINS" }], "CREATING")] })
    );
    const out = await api.list(SPEC);
    expect(out.map((i) => [i.state, i.fields[0]!.order])).toEqual([["READY", "ASCENDING"], ["CREATING", "OTHER"]]);
    expect(String(fetchFn.mock.calls[1]![0])).toContain("pageToken=t2");
  });

  it("treats a missing indexes key as none, and a malformed one as an error", async () => {
    expect(await admin(json({})).api.list(SPEC)).toEqual([]);
    await expect(admin(json({ indexes: "x" })).api.list(SPEC)).rejects.toThrow("unexpected response shape");
    await expect(admin(json({ indexes: [{ name: 1 }] })).api.list(SPEC)).rejects.toThrow("unexpected index shape");
  });

  it("reads an operation: running, done, and done with an error (bounded message)", async () => {
    expect(await admin(json({ name: OP })).api.getOperation(OP)).toEqual({ done: false });
    expect(await admin(json({ name: OP, done: true })).api.getOperation(OP)).toEqual({ done: true });
    const failed = await admin(json({ done: true, error: { code: 8, message: "x".repeat(1000) } })).api.getOperation(OP);
    expect(failed.error?.code).toBe(8);
    expect(failed.error?.message.length).toBe(300);
  });

  it("refuses an operation name that is not one, before any request", async () => {
    const { api, fetchFn } = admin();
    await expect(api.getOperation("../../projects/other")).rejects.toThrow("not an operation name");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
