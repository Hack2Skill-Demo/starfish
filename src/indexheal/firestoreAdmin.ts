/**
 * The Firestore Admin API calls the missing-index heal needs (#11), kept thin because this is the part that talks to
 * Google and has never run against a real project: list a collection group's indexes, create ONE index, read the
 * long-running operation that building it starts. Nothing here decides anything; `heal.ts` does.
 *
 * It creates a single index through `collectionGroups.indexes.create` and never deploys an index file (a stale
 * file deployed whole can delete indexes made elsewhere). Nothing here deletes an index, ever.
 *
 * A failed call throws a FirestoreAdminError that names the HTTP status and nothing from the response body.
 * The access token is passed in, never fetched here, except by the default which uses application default credentials.
 */
import { applicationDefault } from "firebase-admin/app";
import type { IndexOrder, IndexSpec, QueryScope } from "./createIndexUrl.js";

export class FirestoreAdminError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "FirestoreAdminError";
  }
}

export type LiveIndexState = "READY" | "CREATING" | "NEEDS_REPAIR" | "STATE_UNSPECIFIED";

export interface LiveIndex {
  /** The full resource name; the last segment is the index id. */
  name: string;
  state: LiveIndexState;
  queryScope: QueryScope;
  /** A field with an array or vector config is kept apart, so it can never equal a plain spec. */
  fields: { fieldPath: string; order: IndexOrder | "OTHER" }[];
}

export interface OperationStatus {
  done: boolean;
  /** Set when the operation finished with an error. */
  error?: { code: number; message: string };
}

/** The port `heal.ts` talks to; a fake in tests, `createFirestoreAdmin` in production. */
export interface IndexAdmin {
  /** Every index of the spec's collection group, including ones still building. Throws on any failure. */
  list(spec: Pick<IndexSpec, "project" | "database" | "collectionGroup">): Promise<LiveIndex[]>;
  /** Starts building one index and returns the operation's name. Throws on any failure, including ALREADY_EXISTS (409). */
  create(spec: IndexSpec): Promise<{ operation: string }>;
  getOperation(operation: string): Promise<OperationStatus>;
}

const ROOT = "https://firestore.googleapis.com/v1";
const OPERATION_RE = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/databases\/(?:\(default\)|[a-z][a-z0-9-]{0,61}[a-z0-9])\/operations\/[A-Za-z0-9_=.-]+$/;

const parentOf = (s: Pick<IndexSpec, "project" | "database" | "collectionGroup">) =>
  `${ROOT}/projects/${encodeURIComponent(s.project)}/databases/${encodeURIComponent(s.database)}/collectionGroups/${encodeURIComponent(s.collectionGroup)}/indexes`;

export function createFirestoreAdmin(deps: { token?: () => Promise<string>; fetch?: typeof fetch } = {}): IndexAdmin {
  const doFetch = deps.fetch ?? fetch;
  const token = deps.token ?? (async () => (await applicationDefault().getAccessToken()).access_token);

  async function call(what: string, url: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: init.method,
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new FirestoreAdminError(`${what}: the request did not complete`);
    }
    if (!res.ok) throw new FirestoreAdminError(`${what}: HTTP ${res.status}`, res.status);
    try {
      return await res.json();
    } catch {
      throw new FirestoreAdminError(`${what}: the response was not JSON`, res.status);
    }
  }

  return {
    async list(spec) {
      const out: LiveIndex[] = [];
      let pageToken = "";
      // Bounded: a collection group has far fewer than 20 pages of indexes (the database limit is a few hundred).
      for (let page = 0; page < 20; page++) {
        const body = (await call("list indexes", `${parentOf(spec)}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, { method: "GET" })) as {
          indexes?: unknown;
          nextPageToken?: unknown;
        };
        if (body.indexes !== undefined && !Array.isArray(body.indexes)) throw new FirestoreAdminError("list indexes: unexpected response shape");
        for (const raw of (body.indexes ?? []) as Record<string, unknown>[]) {
          const fields = Array.isArray(raw.fields) ? (raw.fields as Record<string, unknown>[]) : null;
          if (typeof raw.name !== "string" || fields === null) throw new FirestoreAdminError("list indexes: unexpected index shape");
          out.push({
            name: raw.name,
            state: raw.state === "READY" || raw.state === "CREATING" || raw.state === "NEEDS_REPAIR" ? raw.state : "STATE_UNSPECIFIED",
            queryScope: raw.queryScope === "COLLECTION_GROUP" ? "COLLECTION_GROUP" : "COLLECTION",
            fields: fields.map((f) => ({
              fieldPath: String(f.fieldPath ?? ""),
              order: f.arrayConfig !== undefined || f.vectorConfig !== undefined ? "OTHER" : f.order === "DESCENDING" ? "DESCENDING" : "ASCENDING",
            })),
          });
        }
        if (typeof body.nextPageToken !== "string" || body.nextPageToken === "") return out;
        pageToken = body.nextPageToken;
      }
      throw new FirestoreAdminError("list indexes: more pages than any collection group has");
    },

    async create(spec) {
      const body = (await call("create index", parentOf(spec), {
        method: "POST",
        body: { queryScope: spec.queryScope, fields: spec.fields.map((f) => ({ fieldPath: f.fieldPath, order: f.order })) },
      })) as { name?: unknown };
      if (typeof body.name !== "string" || !OPERATION_RE.test(body.name)) throw new FirestoreAdminError("create index: the response named no operation");
      return { operation: body.name };
    },

    async getOperation(operation) {
      if (!OPERATION_RE.test(operation)) throw new FirestoreAdminError("get operation: not an operation name");
      const body = (await call("get operation", `${ROOT}/${operation}`, { method: "GET" })) as {
        done?: unknown;
        error?: { code?: unknown; message?: unknown };
      };
      if (body.done !== true) return { done: false };
      return body.error === undefined
        ? { done: true }
        : { done: true, error: { code: Number(body.error.code ?? 2), message: String(body.error.message ?? "").slice(0, 300) } };
    },
  };
}
