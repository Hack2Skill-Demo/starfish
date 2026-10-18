import { describe, expect, it } from "vitest";
import {
  checkTarget,
  findCreateIndexUrl,
  inIndexFile,
  parseAllowedTargets,
  parseCreateIndexUrl,
  parseExistingIndexUrl,
  toIndexFileEntry,
  type IndexSpec,
} from "./createIndexUrl.js";

// ---- Build create-index URLs from the documented Index message (name=1, query_scope=2, fields=3) ----------

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
const num = (field: number, n: number) => [...varint(field * 8), ...varint(n)];

interface Build {
  name?: string;
  scope?: number;
  fields?: { path?: string; order?: number; arrayConfig?: number; extra?: number[] }[];
  extra?: number[];
}
function encode(b: Build = {}): string {
  const bytes: number[] = [];
  bytes.push(...str(1, b.name ?? "projects/demo-app-1/databases/(default)/collectionGroups/orders/indexes/_"));
  bytes.push(...num(2, b.scope ?? 1));
  for (const f of b.fields ?? [
    { path: "status", order: 1 },
    { path: "createdAt", order: 2 },
    { path: "__name__", order: 2 },
  ]) {
    const fb: number[] = [];
    if (f.path !== undefined) fb.push(...str(1, f.path));
    if (f.order !== undefined) fb.push(...num(2, f.order));
    if (f.arrayConfig !== undefined) fb.push(...num(3, f.arrayConfig));
    if (f.extra) fb.push(...f.extra);
    bytes.push(...lenDelimited(3, fb));
  }
  if (b.extra) bytes.push(...b.extra);
  return Buffer.from(bytes).toString("base64url");
}
const url = (b: Build = {}, host = "console.firebase.google.com", path = "/v1/r/project/demo-app-1/firestore/indexes") =>
  `https://${host}${path}?create_composite=${encode(b)}`;

const SPEC: IndexSpec = {
  project: "demo-app-1",
  database: "(default)",
  collectionGroup: "orders",
  queryScope: "COLLECTION",
  fields: [
    { fieldPath: "status", order: "ASCENDING" },
    { fieldPath: "createdAt", order: "DESCENDING" },
    { fieldPath: "__name__", order: "DESCENDING" },
  ],
};

describe("parseCreateIndexUrl", () => {
  it("decodes a well-formed create-index URL into its spec", () => {
    expect(parseCreateIndexUrl(url())).toEqual({ ok: true, spec: SPEC, url: url() });
  });

  it("reads a named database, a collection-group scope and the older console path", () => {
    const r = parseCreateIndexUrl(
      url(
        { name: "projects/demo-app-1/databases/shop-db/collectionGroups/items/indexes/_", scope: 2 },
        "console.cloud.google.com",
        "/project/demo-app-1/database/firestore/indexes"
      )
    );
    expect(r).toMatchObject({ ok: true, spec: { database: "shop-db", collectionGroup: "items", queryScope: "COLLECTION_GROUP" } });
  });

  it("accepts the padded and url-encoded forms of the same value", () => {
    const b64 = encode();
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    expect(parseCreateIndexUrl(`https://console.firebase.google.com/x?create_composite=${encodeURIComponent(padded)}`).ok).toBe(true);
  });

  it("never throws on junk, and says which rule refused it", () => {
    for (const bad of ["", "not a url", "https://console.firebase.google.com/x", "https://console.firebase.google.com/x?create_composite=", "https://console.firebase.google.com/x?create_composite=%%%"]) {
      expect(parseCreateIndexUrl(bad)).toMatchObject({ ok: false });
    }
    expect(parseCreateIndexUrl("https://console.firebase.google.com/x?create_composite=%%%")).toMatchObject({ ok: false, rule: "bad-encoding" });
    expect(parseCreateIndexUrl("https://console.firebase.google.com/x?create_composite=AAAA")).toMatchObject({ ok: false, rule: "unsupported-spec" });
    expect(parseCreateIndexUrl("https://console.firebase.google.com/x?create_composite=/////")).toMatchObject({ ok: false });
  });

  it.each([
    ["another host", "https://evil.example/v1/r/project/demo-app-1/firestore/indexes", "bad-url"],
    ["a look-alike host", "https://console.firebase.google.com.evil.example/x", "bad-url"],
    ["plain http", "http://console.firebase.google.com/x", "bad-url"],
  ])("refuses %s", (_n, base, rule) => {
    expect(parseCreateIndexUrl(`${base}?create_composite=${encode()}`)).toMatchObject({ ok: false, rule });
  });

  it("refuses credentials, a port and an overlong URL in the link", () => {
    expect(parseCreateIndexUrl(`https://user:pw@console.firebase.google.com/x?create_composite=${encode()}`)).toMatchObject({ rule: "bad-url" });
    expect(parseCreateIndexUrl(`https://console.firebase.google.com:8443/x?create_composite=${encode()}`)).toMatchObject({ rule: "bad-url" });
    expect(parseCreateIndexUrl(`https://console.firebase.google.com/x?create_composite=${"A".repeat(5000)}`)).toMatchObject({ rule: "bad-url" });
  });

  it("refuses a link whose project differs from the specification's", () => {
    expect(parseCreateIndexUrl(url({}, "console.firebase.google.com", "/v1/r/project/someone-elses/firestore/indexes"))).toMatchObject({ ok: false, rule: "project-mismatch" });
  });

  it("refuses names that are not exactly projects/P/databases/D/collectionGroups/C/indexes/_", () => {
    for (const name of [
      "projects/demo-app-1/databases/(default)/collectionGroups/orders/indexes/abc",
      "projects/demo-app-1/databases/(default)/collectionGroups/orders",
      "projects/demo-app-1/databases/(default)/collectionGroups/a/b/indexes/_",
      "projects/BAD PROJECT/databases/(default)/collectionGroups/orders/indexes/_",
      "projects/demo-app-1/databases/(default)/collectionGroups/or ders/indexes/_",
      "projects/demo-app-1/databases/(default)/collectionGroups/../indexes/_",
    ]) {
      expect(parseCreateIndexUrl(url({ name }))).toMatchObject({ ok: false, rule: "bad-name" });
    }
  });

  it("sends array, vector and unknown shapes to a person", () => {
    expect(parseCreateIndexUrl(url({ fields: [{ path: "tags", arrayConfig: 1 }, { path: "createdAt", order: 1 }] }))).toMatchObject({ ok: false, rule: "unsupported-spec", reason: expect.stringContaining("Array") });
    // An unknown field is refused whatever its wire type, never skipped over.
    expect(parseCreateIndexUrl(url({ extra: lenDelimited(5, [1, 2, 3]) }))).toMatchObject({ ok: false, rule: "unsupported-spec" });
    expect(parseCreateIndexUrl(url({ fields: [{ path: "a", order: 1, extra: num(9, 1) }] }))).toMatchObject({ ok: false, rule: "unsupported-spec" });
    expect(parseCreateIndexUrl(url({ fields: [{ path: "v", extra: [...lenDelimited(4, [8, 3])] }] }))).toMatchObject({ ok: false, rule: "unsupported-spec" });
    expect(parseCreateIndexUrl(url({ extra: num(5, 1) }))).toMatchObject({ ok: false, rule: "unsupported-spec" });
    expect(parseCreateIndexUrl(url({ scope: 3 }))).toMatchObject({ ok: false, rule: "unsupported-spec" });
    expect(parseCreateIndexUrl(url({ scope: 0 }))).toMatchObject({ ok: false, rule: "unsupported-spec" });
    expect(parseCreateIndexUrl(url({ fields: [{ path: "a", order: 3 }] }))).toMatchObject({ ok: false, rule: "unsupported-spec" });
    expect(parseCreateIndexUrl(url({ fields: [] }))).toMatchObject({ ok: false, rule: "unsupported-spec" });
    expect(parseCreateIndexUrl(url({ fields: Array.from({ length: 11 }, (_, i) => ({ path: `f${i}`, order: 1 })) }))).toMatchObject({ ok: false, rule: "unsupported-spec" });
  });

  it("refuses a field path that is not a plain one, a repeated field and a misplaced __name__", () => {
    for (const path of ["a b", "`quoted`", "a..b", "", "a/b", "1abc", "x;drop"]) {
      expect(parseCreateIndexUrl(url({ fields: [{ path, order: 1 }] }))).toMatchObject({ ok: false, rule: "invalid-field" });
    }
    expect(parseCreateIndexUrl(url({ fields: [{ path: "a", order: 1 }, { path: "a", order: 2 }] }))).toMatchObject({ rule: "invalid-field" });
    expect(parseCreateIndexUrl(url({ fields: [{ path: "__name__", order: 1 }, { path: "a", order: 1 }] }))).toMatchObject({ rule: "invalid-field" });
    expect(parseCreateIndexUrl(url({ fields: [{ order: 1 }] }))).toMatchObject({ rule: "invalid-field" });
  });

  it("keeps a nested field path", () => {
    const r = parseCreateIndexUrl(url({ fields: [{ path: "customer.address.city", order: 1 }] }));
    expect(r).toMatchObject({ ok: true, spec: { fields: [{ fieldPath: "customer.address.city" }] } });
  });

  it("refuses bytes that are not valid utf-8 instead of guessing", () => {
    const bad = Buffer.from([0x0a, 0x02, 0xff, 0xfe, 0x10, 0x01]).toString("base64url");
    expect(parseCreateIndexUrl(`https://console.firebase.google.com/x?create_composite=${bad}`)).toMatchObject({ ok: false });
  });
});

describe("findCreateIndexUrl", () => {
  it("finds the URL inside a real-looking error message", () => {
    const link = url();
    const message = `9 FAILED_PRECONDITION: The query requires an index. You can create it here: ${link}`;
    expect(findCreateIndexUrl(message)).toBe(link);
  });
  it("finds nothing in a message without one, and is not fooled by another host", () => {
    expect(findCreateIndexUrl("9 FAILED_PRECONDITION: something else")).toBeNull();
    expect(findCreateIndexUrl(`see https://evil.example/?create_composite=${encode()}`)).toBeNull();
    expect(findCreateIndexUrl("")).toBeNull();
  });
  it("stops at the end of the link", () => {
    const link = url();
    expect(findCreateIndexUrl(`create it: (${link}) then retry`)).toBe(link);
  });
});

describe("the target guard", () => {
  const own = { project: "starfish-home", database: "starfish" };
  const allowed = parseAllowedTargets(["demo-app-1/(default)", "demo-app-1/shop-db"]);

  it("allows a listed project and database", () => {
    expect(checkTarget({ project: "demo-app-1", database: "(default)" }, allowed, own)).toEqual({ allowed: true });
    expect(checkTarget({ project: "demo-app-1", database: "shop-db" }, allowed, own)).toEqual({ allowed: true });
  });

  it("denies by default: nothing is allowed when nothing is listed, and a near miss is not a match", () => {
    expect(checkTarget({ project: "demo-app-1", database: "(default)" }, [], own)).toMatchObject({ allowed: false, rule: "target-not-allowed" });
    expect(checkTarget({ project: "demo-app-2", database: "(default)" }, allowed, own)).toMatchObject({ allowed: false });
    expect(checkTarget({ project: "demo-app-1", database: "other" }, allowed, own)).toMatchObject({ allowed: false });
  });

  it("never allows Starfish's own database, even when it is listed", () => {
    const withOwn = parseAllowedTargets(["starfish-home/starfish"]);
    expect(checkTarget({ project: "starfish-home", database: "starfish" }, withOwn, own)).toMatchObject({ allowed: false, rule: "own-database" });
    // The same database name in another project is a different database.
    expect(checkTarget({ project: "demo-app-1", database: "starfish" }, parseAllowedTargets(["demo-app-1/starfish"]), own)).toEqual({ allowed: true });
  });

  it("refuses a malformed allowlist entry instead of guessing", () => {
    for (const bad of ["demo-app-1", "demo-app-1/", "/(default)", "a/b/c", "Demo/(default)", "demo-app-1/(default)/x", ""]) {
      expect(() => parseAllowedTargets([bad])).toThrow(/project\/database/);
    }
    expect(parseAllowedTargets([])).toEqual([]);
  });
});

describe("against the repository's index file", () => {
  const file = (indexes: unknown[]) => ({ indexes, fieldOverrides: [] });
  const entry = { collectionGroup: "orders", queryScope: "COLLECTION", fields: [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "createdAt", order: "DESCENDING" }] };

  it("builds the entry without the implicit __name__", () => {
    expect(toIndexFileEntry(SPEC)).toEqual({ collectionGroup: "orders", queryScope: "COLLECTION", fields: [{ fieldPath: "status", order: "ASCENDING" }, { fieldPath: "createdAt", order: "DESCENDING" }] });
  });

  it("finds an index that is already there, with or without __name__ and with the default scope", () => {
    expect(inIndexFile(SPEC, file([entry]))).toBe("present");
    expect(inIndexFile(SPEC, file([{ ...entry, fields: [...entry.fields, { fieldPath: "__name__", order: "DESCENDING" }] }]))).toBe("present");
    expect(inIndexFile(SPEC, file([{ collectionGroup: "orders", fields: entry.fields }]))).toBe("present");
  });

  it("says absent when no entry matches: another order, scope, collection or field list", () => {
    expect(inIndexFile(SPEC, file([]))).toBe("absent");
    expect(inIndexFile(SPEC, file([{ ...entry, fields: [entry.fields[0], { fieldPath: "createdAt", order: "ASCENDING" }] }]))).toBe("absent");
    expect(inIndexFile(SPEC, file([{ ...entry, queryScope: "COLLECTION_GROUP" }]))).toBe("absent");
    expect(inIndexFile(SPEC, file([{ ...entry, collectionGroup: "items" }]))).toBe("absent");
    expect(inIndexFile(SPEC, file([{ ...entry, fields: [entry.fields[1], entry.fields[0]] }]))).toBe("absent");
  });

  it("an entry with an array field never matches a plain spec", () => {
    expect(inIndexFile(SPEC, file([{ collectionGroup: "orders", fields: [{ fieldPath: "status", arrayConfig: "CONTAINS" }, { fieldPath: "createdAt", order: "DESCENDING" }] }]))).toBe("absent");
  });

  it("is unknown, never absent, for a file it cannot read", () => {
    for (const bad of [null, undefined, "x", {}, { indexes: "no" }, file([{ fields: [] }]), file([{ collectionGroup: "orders", fields: [{ order: "ASCENDING" }] }]), file([{ collectionGroup: "orders", fields: [{ fieldPath: "a", order: "UP" }] }])]) {
      expect(inIndexFile(SPEC, bad)).toBe("unknown");
    }
  });
});

describe("parseExistingIndexUrl", () => {
  const existing = (id: string) => encode({ name: `projects/demo-app-1/databases/(default)/collectionGroups/orders/indexes/${id}` });
  const link = (b: string) => `https://console.firebase.google.com/v1/r/project/demo-app-1/firestore/indexes?create_composite=${b}`;

  it("reads the link of an index that already exists, with its id", () => {
    const r = parseExistingIndexUrl(link(existing("CICAgJmiJEK")));
    expect(r).toMatchObject({ ok: true, indexId: "CICAgJmiJEK", spec: { project: "demo-app-1", collectionGroup: "orders" } });
  });

  it("is the other parser's opposite on the name: a create link (`_`) is not an existing index, an id is not a create link", () => {
    expect(parseExistingIndexUrl(link(encode()))).toMatchObject({ ok: false, rule: "bad-name" });
    expect(parseCreateIndexUrl(link(existing("CICAgJmiJEK")))).toMatchObject({ ok: false, rule: "bad-name" });
    expect(parseExistingIndexUrl(link(existing("bad id!")))).toMatchObject({ ok: false, rule: "bad-name" });
  });
});
