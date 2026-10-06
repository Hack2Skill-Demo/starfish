/**
 * The deterministic half of healing a missing Firestore index (#11): read the create-index URL that
 * Google puts in a FAILED_PRECONDITION error, decode it into a spec, and decide whether that spec may be
 * acted on. No model is involved, and nothing here creates anything: it only parses and refuses.
 *
 * The URL carries `create_composite=<base64url of a google.firestore.admin.v1.Index>`: the index's name
 * (`projects/P/databases/D/collectionGroups/C/indexes/_`), its query scope and its fields. The wire format
 * is decoded by hand and STRICTLY: any field, wire type or enum value this file does not know is a
 * refusal, because an index spec nobody understood must not become an Admin API call. Only plain
 * ascending/descending field indexes are supported; array-contains, vector and anything else go to a
 * person (`unsupported-spec`).
 *
 * Tested on URLs built here from the documented `Index` message, not on one captured from a real error:
 * a real one is the first thing to check against before this is wired to anything.
 *
 * The target guard is separate and default-deny: a spec is only `allowed` when its project and database
 * are on the configured allowlist AND are not Starfish's own database (a rules or index change there
 * would hit Starfish itself, and the watched app's rules live in another database).
 */

export type IndexOrder = "ASCENDING" | "DESCENDING";
export type QueryScope = "COLLECTION" | "COLLECTION_GROUP";

export interface IndexSpec {
  project: string;
  /** `(default)` or a named database. */
  database: string;
  collectionGroup: string;
  queryScope: QueryScope;
  fields: { fieldPath: string; order: IndexOrder }[];
}

export type ParseRule =
  | "no-url"
  | "bad-url"
  | "bad-encoding"
  | "bad-name"
  | "project-mismatch"
  | "unsupported-spec"
  | "invalid-field";

export type ParseResult = { ok: true; spec: IndexSpec; url: string } | { ok: false; rule: ParseRule; reason: string };

const HOSTS = new Set(["console.firebase.google.com", "console.cloud.google.com"]);
const MAX_URL = 4000;
const MAX_FIELDS = 10;
export const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const DATABASE_RE = /^(?:\(default\)|[a-z][a-z0-9-]{0,61}[a-z0-9])$/;
export const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
export const FIELD_PATH_RE = /^(?:__name__|[A-Za-z_][A-Za-z0-9_]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_]{0,127}){0,19})$/;
const NAME_RE = /^projects\/([^/]+)\/databases\/([^/]+)\/collectionGroups\/([^/]+)\/indexes\/_$/;
const URL_IN_TEXT_RE = /https:\/\/console\.(?:firebase|cloud)\.google\.com\/[^\s"'<>)\]]*create_composite=[A-Za-z0-9_\-%=]+/;

const refuse = (rule: ParseRule, reason: string): ParseResult => ({ ok: false, rule, reason });

/** The first create-index URL in an error message, or null. Bounded, so a huge message costs nothing. */
export function findCreateIndexUrl(text: string): string | null {
  const m = URL_IN_TEXT_RE.exec(String(text ?? "").slice(0, 20_000));
  return m && m[0].length <= MAX_URL ? m[0] : null;
}

// ---- A strict reader for the one protobuf shape we accept ------------------------------------------------

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  done(): boolean {
    return this.pos >= this.buf.length;
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      if (this.pos >= this.buf.length) throw new Error("truncated varint");
      const byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
    throw new Error("varint too long");
  }
  bytes(): Uint8Array {
    const len = this.varint();
    if (this.pos + len > this.buf.length) throw new Error("truncated field");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

interface RawIndex {
  name?: string;
  scope?: number;
  fields: { path?: string; order?: number; arrayConfig?: number }[];
}

function readIndex(buf: Uint8Array): RawIndex {
  const r = new Reader(buf);
  const out: RawIndex = { fields: [] };
  while (!r.done()) {
    const tag = r.varint();
    const num = Math.floor(tag / 8);
    const wire = tag % 8;
    if (num === 1 && wire === 2) out.name = utf8.decode(r.bytes());
    else if (num === 2 && wire === 0) out.scope = r.varint();
    else if (num === 3 && wire === 2) {
      const f = new Reader(r.bytes());
      const field: RawIndex["fields"][number] = {};
      while (!f.done()) {
        const ft = f.varint();
        const fnum = Math.floor(ft / 8);
        const fwire = ft % 8;
        if (fnum === 1 && fwire === 2) field.path = utf8.decode(f.bytes());
        else if (fnum === 2 && fwire === 0) field.order = f.varint();
        else if (fnum === 3 && fwire === 0) field.arrayConfig = f.varint();
        else throw new Error("unknown field in index field");
      }
      out.fields.push(field);
    } else throw new Error("unknown field in index");
  }
  return out;
}

/** Decode a create-index URL into a spec, or say exactly why it may not be used. Never throws. */
export function parseCreateIndexUrl(rawUrl: string): ParseResult {
  if (typeof rawUrl !== "string" || rawUrl === "") return refuse("no-url", "There is no create-index URL.");
  if (rawUrl.length > MAX_URL) return refuse("bad-url", "The URL is too long to be a create-index URL.");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refuse("bad-url", "That is not a URL.");
  }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username !== "" || url.password !== "" || url.port !== "") {
    return refuse("bad-url", "The URL is not a Google console URL.");
  }
  const param = url.searchParams.get("create_composite");
  if (param === null || param === "" || !/^[A-Za-z0-9_-]+={0,2}$/.test(param)) return refuse("bad-encoding", "The index specification is not base64url.");

  let raw: RawIndex;
  try {
    raw = readIndex(new Uint8Array(Buffer.from(param.replace(/=+$/, ""), "base64url")));
  } catch (err) {
    return refuse("unsupported-spec", `The index specification has a shape this parser does not accept (${err instanceof Error ? err.message : "unreadable"}).`);
  }

  const nameMatch = raw.name === undefined ? null : NAME_RE.exec(raw.name);
  if (!nameMatch) return refuse("bad-name", "The index name is not projects/P/databases/D/collectionGroups/C/indexes/_.");
  const [, project, database, collectionGroup] = nameMatch as unknown as [string, string, string, string];
  if (!PROJECT_RE.test(project) || !DATABASE_RE.test(database) || !COLLECTION_RE.test(collectionGroup)) {
    return refuse("bad-name", "The project, database or collection in the index name is not valid.");
  }
  // The project in the link's own path (where the console sends you) must agree with the spec's.
  const pathProject = /\/project\/([^/]+)\//.exec(url.pathname)?.[1];
  if (pathProject !== undefined && pathProject !== project) return refuse("project-mismatch", "The URL and the index specification name different projects.");

  const queryScope: QueryScope | null = raw.scope === 1 ? "COLLECTION" : raw.scope === 2 ? "COLLECTION_GROUP" : null;
  if (queryScope === null) return refuse("unsupported-spec", "The query scope is not collection or collection group.");
  if (raw.fields.length < 1 || raw.fields.length > MAX_FIELDS) return refuse("unsupported-spec", `An index needs between 1 and ${MAX_FIELDS} fields.`);

  const fields: IndexSpec["fields"] = [];
  for (const f of raw.fields) {
    if (f.arrayConfig !== undefined) return refuse("unsupported-spec", "Array and vector indexes are for a person, not this parser.");
    if (f.path === undefined || !FIELD_PATH_RE.test(f.path)) return refuse("invalid-field", "A field path is missing or not a plain field path.");
    if (f.order !== 1 && f.order !== 2) return refuse("unsupported-spec", "A field is neither ascending nor descending.");
    fields.push({ fieldPath: f.path, order: f.order === 1 ? "ASCENDING" : "DESCENDING" });
  }
  const names = fields.map((f) => f.fieldPath);
  if (new Set(names).size !== names.length) return refuse("invalid-field", "A field appears twice.");
  if (names.includes("__name__") && names.indexOf("__name__") !== names.length - 1) return refuse("invalid-field", "__name__ may only be the last field.");

  return { ok: true, spec: { project, database, collectionGroup, queryScope, fields }, url: rawUrl };
}

// ---- The target guard: default-deny ------------------------------------------------------------------------

export interface IndexTarget {
  project: string;
  database: string;
}

export type TargetRule = "target-not-allowed" | "own-database";
export type TargetResult = { allowed: true } | { allowed: false; rule: TargetRule; reason: string };

/** `project/database` entries from configuration, e.g. `my-demo/(default)`. Bad entries throw: a typo must not widen what is allowed. */
export function parseAllowedTargets(entries: readonly string[]): IndexTarget[] {
  return entries.map((entry) => {
    const [project, database, ...rest] = entry.split("/");
    if (rest.length > 0 || project === undefined || database === undefined || !PROJECT_RE.test(project) || !DATABASE_RE.test(database)) {
      throw new Error(`STARFISH_INDEX_ALLOWED_TARGETS entry "${entry}" is not project/database`);
    }
    return { project, database };
  });
}

/**
 * Whether the spec's project and database are ones indexes may be created in. Nothing is allowed unless it is
 * listed, and Starfish's own database is never allowed even if it is listed: an index there is Starfish
 * changing itself, and an index in the watched app's database is the only thing this heal is for.
 */
export function checkTarget(spec: Pick<IndexSpec, "project" | "database">, allowed: readonly IndexTarget[], own: IndexTarget): TargetResult {
  if (spec.project === own.project && spec.database === own.database) {
    return { allowed: false, rule: "own-database", reason: "That is Starfish's own database; no index is ever created there." };
  }
  if (!allowed.some((t) => t.project === spec.project && t.database === spec.database)) {
    return { allowed: false, rule: "target-not-allowed", reason: "That project and database are not on the allowlist of targets." };
  }
  return { allowed: true };
}

// ---- Against the repository's own index file -----------------------------------------------------------------

export interface IndexFileEntry {
  collectionGroup: string;
  queryScope: QueryScope;
  fields: { fieldPath: string; order: IndexOrder }[];
}

/** The entry for `firestore.indexes.json`: no `__name__` suffix, which Firestore adds itself. */
export function toIndexFileEntry(spec: IndexSpec): IndexFileEntry {
  const fields = spec.fields.filter((f, i) => !(f.fieldPath === "__name__" && i === spec.fields.length - 1));
  return { collectionGroup: spec.collectionGroup, queryScope: spec.queryScope, fields };
}

/**
 * Whether the repository's index file already holds this index. Unreadable or unexpected input is
 * `unknown`, never `absent`: a file nobody could read must not be taken as "not there" (the caller would
 * then open a pull request adding a duplicate).
 */
export function inIndexFile(spec: IndexSpec, file: unknown): "present" | "absent" | "unknown" {
  const indexes = (file as { indexes?: unknown } | null)?.indexes;
  if (!Array.isArray(indexes)) return "unknown";
  const want = toIndexFileEntry(spec);
  const key = (e: IndexFileEntry) => JSON.stringify([e.collectionGroup, e.queryScope, e.fields.map((f) => [f.fieldPath, f.order])]);
  const wanted = key(want);
  for (const item of indexes) {
    const e = item as { collectionGroup?: unknown; queryScope?: unknown; fields?: unknown };
    if (typeof e.collectionGroup !== "string" || !Array.isArray(e.fields)) return "unknown";
    const fields: IndexFileEntry["fields"] = [];
    for (const f of e.fields as { fieldPath?: unknown; order?: unknown; arrayConfig?: unknown }[]) {
      if (typeof f?.fieldPath !== "string") return "unknown";
      if (f.arrayConfig !== undefined) {
        fields.push({ fieldPath: f.fieldPath, order: "ASCENDING" });
        fields.push({ fieldPath: "__array__", order: "ASCENDING" }); // never equals a plain spec
        continue;
      }
      if (f.order !== "ASCENDING" && f.order !== "DESCENDING") return "unknown";
      fields.push({ fieldPath: f.fieldPath, order: f.order });
    }
    const scope: QueryScope = e.queryScope === "COLLECTION_GROUP" ? "COLLECTION_GROUP" : "COLLECTION";
    const normalised = fields.filter((f, i) => !(f.fieldPath === "__name__" && i === fields.length - 1));
    if (key({ collectionGroup: e.collectionGroup, queryScope: scope, fields: normalised }) === wanted) return "present";
  }
  return "absent";
}
