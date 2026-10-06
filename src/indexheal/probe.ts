/**
 * The deterministic probe of the missing-index heal (#11): the failing query, replayed exactly as configured.
 *
 * A create-index URL names the index Google wants, not the query that wanted it: the filters' values, the cursor and
 * the limit are not in it, so the query cannot be rebuilt from the error. It is not guessed either. An operator writes
 * the query down (`STARFISH_INDEX_PROBES`), and the heal runs it, read-only and with a limit of one document:
 *
 *   - BEFORE creating anything, a configured probe for the spec's target and collection group must fail with Google's
 *     own "requires an index" error naming exactly the spec being created. No probe, or a probe that passes or fails
 *     some other way, and nothing is created.
 *   - AFTER the index is READY, the same probes must pass: the query that failed now works.
 *
 * The probe only reads, and only the one query the operator wrote; it never writes and never runs anything the incident
 * text said. Errors come back as a code and a rule, never Google's message text (which is not shown anywhere).
 */
import { COLLECTION_RE, DATABASE_RE, FIELD_PATH_RE, findCreateIndexUrl, parseCreateIndexUrl, PROJECT_RE, type IndexSpec, type QueryScope } from "./createIndexUrl.js";

export type ProbeOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
const OPS: readonly ProbeOp[] = ["==", "!=", "<", "<=", ">", ">="];

/** One query an operator wrote down, to be replayed with a limit of one. */
export interface IndexProbeSpec {
  project: string;
  database: string;
  /**
   * COLLECTION scope: the collection's path (`orders`, or `users/u1/orders` for a subcollection), whose last segment is
   * the collection group. COLLECTION_GROUP scope: the collection group id alone.
   */
  collection: string;
  scope: QueryScope;
  where: { field: string; op: ProbeOp; value: string | number | boolean }[];
  orderBy: { field: string; direction: "asc" | "desc" }[];
}

const MAX_PROBES = 20;
const MAX_CLAUSES = 10;
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STRING_VALUE = 200;

/** The collection group a probe queries: the last segment of its path. */
export function probeCollectionGroup(p: Pick<IndexProbeSpec, "collection">): string {
  return p.collection.split("/").pop() ?? "";
}

function fail(i: number, what: string): never {
  throw new Error(`STARFISH_INDEX_PROBES entry ${i + 1}: ${what}`);
}

/**
 * `STARFISH_INDEX_PROBES`: a JSON array of probes. Unset or empty: none, so no index can be created (the gate needs a
 * probe). Anything malformed throws at startup: a probe nobody can read must not become a query, or a pass.
 */
export function parseIndexProbes(raw: string | undefined): IndexProbeSpec[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("STARFISH_INDEX_PROBES is not JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("STARFISH_INDEX_PROBES must be a JSON array");
  if (parsed.length > MAX_PROBES) throw new Error(`STARFISH_INDEX_PROBES holds more than ${MAX_PROBES} probes`);
  return parsed.map((item: unknown, i): IndexProbeSpec => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) fail(i, "is not an object");
    const o = item as Record<string, unknown>;
    const known = ["target", "collection", "scope", "where", "orderBy"];
    for (const k of Object.keys(o)) if (!known.includes(k)) fail(i, `unknown key "${k}"`);
    const [project, database, ...rest] = typeof o.target === "string" ? o.target.split("/") : [];
    if (rest.length > 0 || !project || !database || !PROJECT_RE.test(project) || !DATABASE_RE.test(database)) fail(i, "target must be project/database");
    const scope = o.scope === undefined ? "COLLECTION" : o.scope;
    if (scope !== "COLLECTION" && scope !== "COLLECTION_GROUP") fail(i, "scope must be COLLECTION or COLLECTION_GROUP");
    if (typeof o.collection !== "string") fail(i, "collection is missing");
    const segs = o.collection.split("/");
    const pathOk =
      scope === "COLLECTION_GROUP"
        ? segs.length === 1 && COLLECTION_RE.test(segs[0]!)
        : segs.length % 2 === 1 && segs.length <= 11 && segs.every((s, j) => (j % 2 === 0 ? COLLECTION_RE.test(s) : DOC_ID_RE.test(s)));
    if (!pathOk) fail(i, "collection is not a collection path (or, for COLLECTION_GROUP, a collection id)");
    const where = o.where ?? [];
    const orderBy = o.orderBy ?? [];
    if (!Array.isArray(where) || !Array.isArray(orderBy) || where.length + orderBy.length === 0 || where.length + orderBy.length > MAX_CLAUSES) {
      fail(i, `needs between 1 and ${MAX_CLAUSES} where/orderBy clauses`);
    }
    return {
      project,
      database,
      collection: o.collection,
      scope,
      where: where.map((w: unknown) => {
        if (!Array.isArray(w) || w.length !== 3) fail(i, "a where clause is [field, op, value]");
        const [field, op, value] = w as unknown[];
        if (typeof field !== "string" || !FIELD_PATH_RE.test(field)) fail(i, "a where field is not a plain field path");
        if (!OPS.includes(op as ProbeOp)) fail(i, `a where op must be one of ${OPS.join(" ")}`);
        const okValue =
          (typeof value === "string" && value.length <= MAX_STRING_VALUE) || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
        if (!okValue) fail(i, "a where value must be a short string, a number or a boolean");
        return { field, op: op as ProbeOp, value: value as string | number | boolean };
      }),
      orderBy: orderBy.map((ob: unknown) => {
        if (!Array.isArray(ob) || ob.length !== 2) fail(i, "an orderBy clause is [field, asc|desc]");
        const [field, direction] = ob as unknown[];
        if (typeof field !== "string" || !FIELD_PATH_RE.test(field)) fail(i, "an orderBy field is not a plain field path");
        if (direction !== "asc" && direction !== "desc") fail(i, "an orderBy direction must be asc or desc");
        return { field, direction };
      }),
    };
  });
}

/** What one probe run said. */
export type ProbeRun =
  | { state: "passed" }
  /** Google's own "requires an index" error; `spec` is the index it names, or null when its link could not be read. */
  | { state: "needs-index"; spec: IndexSpec | null }
  | { state: "error"; code: string };

/** What the probes for one spec said, taken together. */
export type ProbeVerdict =
  /** No probe is configured for this target and collection group: the query is not known, so nothing is replayed. */
  | { state: "not-configured" }
  /** At least one probe failed with the error naming exactly this spec. */
  | { state: "needs-index"; probes: number }
  /** Every probe for this spec ran and none failed. */
  | { state: "passed"; probes: number }
  /** A probe failed some other way, or with a different index: the replay says nothing reliable about this one. */
  | { state: "inconclusive"; probes: number; reason: string };

/** Runs one probe's query: resolves when it returned (any number of documents), throws what Firestore threw. */
export type ProbeQueryRunner = (probe: IndexProbeSpec) => Promise<void>;

/** Firestore's FAILED_PRECONDITION, as the Admin SDK reports it (gRPC code 9) or as text. */
function isFailedPrecondition(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 9 || code === "9" || code === "failed-precondition" || code === "FAILED_PRECONDITION";
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" || (typeof code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(code)) ? String(code) : "unknown";
}

/** One probe, run; never throws. */
export async function runProbe(probe: IndexProbeSpec, run: ProbeQueryRunner): Promise<ProbeRun> {
  try {
    await run(probe);
    return { state: "passed" };
  } catch (err) {
    const message = (err as { message?: unknown } | null)?.message;
    const url = typeof message === "string" ? findCreateIndexUrl(message) : null;
    if (isFailedPrecondition(err) && url !== null) {
      const parsed = parseCreateIndexUrl(url);
      return { state: "needs-index", spec: parsed.ok ? parsed.spec : null };
    }
    return { state: "error", code: errorCode(err) };
  }
}

const sameSpec = (a: IndexSpec, b: IndexSpec): boolean =>
  a.project === b.project &&
  a.database === b.database &&
  a.collectionGroup === b.collectionGroup &&
  a.queryScope === b.queryScope &&
  JSON.stringify(a.fields.filter((f) => f.fieldPath !== "__name__")) === JSON.stringify(b.fields.filter((f) => f.fieldPath !== "__name__"));

/** The configured probes whose target, scope and collection group are the spec's. */
export function probesFor(spec: IndexSpec, probes: readonly IndexProbeSpec[]): IndexProbeSpec[] {
  return probes.filter((p) => p.project === spec.project && p.database === spec.database && p.scope === spec.queryScope && probeCollectionGroup(p) === spec.collectionGroup);
}

/**
 * The probe the heal calls: every configured probe for the spec is run, and their results judged together.
 *   needs-index  one of them failed naming exactly this spec (the "confirmed" the gate wants before creating);
 *   passed       every one ran without an error;
 *   inconclusive anything else (a probe failed some other way, or wants another index).
 * Never throws: a query that could not run is `inconclusive`, which creates nothing and heals nothing.
 */
export function createIndexProbe(probes: readonly IndexProbeSpec[], run: ProbeQueryRunner): (spec: IndexSpec) => Promise<ProbeVerdict> {
  return async (spec) => {
    const mine = probesFor(spec, probes);
    if (mine.length === 0) return { state: "not-configured" };
    const runs: ProbeRun[] = [];
    for (const p of mine) runs.push(await runProbe(p, run));
    if (runs.some((r) => r.state === "needs-index" && r.spec !== null && sameSpec(r.spec, spec))) return { state: "needs-index", probes: mine.length };
    if (runs.every((r) => r.state === "passed")) return { state: "passed", probes: mine.length };
    const first = runs.find((r) => r.state !== "passed")!;
    const reason = first.state === "error" ? `a probe failed with code ${first.code}` : "a probe needs a different index";
    return { state: "inconclusive", probes: mine.length, reason };
  };
}
