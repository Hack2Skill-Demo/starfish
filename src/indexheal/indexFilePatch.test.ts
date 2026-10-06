import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IndexSpec } from "./createIndexUrl.js";
import { INDEX_FILE_PATH_RE, indexFilePatch } from "./indexFilePatch.js";

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
const EXISTING = {
  indexes: [{ collectionGroup: "users", queryScope: "COLLECTION", fields: [{ fieldPath: "team", order: "ASCENDING" }, { fieldPath: "name", order: "ASCENDING" }] }],
  fieldOverrides: [{ collectionGroup: "logs", fieldPath: "payload", indexes: [] }],
};

/** Applies the patch with git itself, in a scratch repository: what the PR opener does. */
function applyWithGit(path: string, before: string | null, patch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "starfish-indexpatch-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    if (before !== null) writeFileSync(join(dir, path), before);
    writeFileSync(join(dir, "change.patch"), patch);
    execFileSync("git", ["apply", "--whitespace=nowarn", "change.patch"], { cwd: dir });
    return readFileSync(join(dir, path), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("indexFilePatch", () => {
  it("adds the entry at the end, keeps everything else, and the diff applies with git", () => {
    const before = `${JSON.stringify(EXISTING, null, 2)}\n`;
    const r = indexFilePatch("firestore.indexes.json", before, SPEC);
    if (!r.ok) throw new Error(r.reason);
    const after = JSON.parse(r.after) as typeof EXISTING;
    expect(after.indexes).toEqual([
      EXISTING.indexes[0],
      { collectionGroup: "orders", queryScope: "COLLECTION", fields: SPEC.fields },
    ]);
    expect(after.fieldOverrides).toEqual(EXISTING.fieldOverrides);
    expect(applyWithGit("firestore.indexes.json", before, r.patch)).toBe(r.after);
    // A minimal diff: for a file the CLI wrote, only additions; nothing the file had is shown as removed.
    expect(r.patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"))).toEqual([]);
  });

  it("creates the file when the repository has none", () => {
    const r = indexFilePatch("firestore.indexes.json", null, SPEC);
    if (!r.ok) throw new Error(r.reason);
    expect(r.created).toBe(true);
    expect(applyWithGit("firestore.indexes.json", null, r.patch)).toBe(r.after);
    expect(JSON.parse(r.after)).toEqual({ indexes: [{ collectionGroup: "orders", queryScope: "COLLECTION", fields: SPEC.fields }], fieldOverrides: [] });
  });

  it("handles a file without a trailing newline, and one written on a single line", () => {
    for (const before of [JSON.stringify(EXISTING, null, 2), JSON.stringify(EXISTING)]) {
      const r = indexFilePatch("firestore.indexes.json", before, SPEC);
      if (!r.ok) throw new Error(r.reason);
      expect(applyWithGit("firestore.indexes.json", before, r.patch)).toBe(r.after);
    }
  });

  it("an empty index list works too", () => {
    const before = `${JSON.stringify({ indexes: [], fieldOverrides: [] }, null, 2)}\n`;
    const r = indexFilePatch("firestore.indexes.json", before, SPEC);
    if (!r.ok) throw new Error(r.reason);
    expect(applyWithGit("firestore.indexes.json", before, r.patch)).toBe(r.after);
  });

  it("refuses a file that already has the index, and one it cannot read", () => {
    const has = JSON.stringify({ indexes: [{ collectionGroup: "orders", queryScope: "COLLECTION", fields: SPEC.fields }] });
    expect(indexFilePatch("firestore.indexes.json", has, SPEC)).toMatchObject({ ok: false, rule: "already-present" });
    expect(indexFilePatch("firestore.indexes.json", "{", SPEC)).toMatchObject({ ok: false, rule: "unreadable" });
    expect(indexFilePatch("firestore.indexes.json", "[]", SPEC)).toMatchObject({ ok: false, rule: "unreadable" });
    expect(indexFilePatch("firestore.indexes.json", JSON.stringify({ indexes: [{ fields: [] }] }), SPEC)).toMatchObject({ ok: false, rule: "unreadable" });
    expect(indexFilePatch("firestore.indexes.json", '{\r\n"indexes": []\r\n}', SPEC)).toMatchObject({ ok: false, rule: "unreadable" });
  });

  it("refuses a path that is not a plain relative json path", () => {
    for (const p of ["../firestore.indexes.json", "/etc/x.json", "a/../b.json", "firestore.indexes.yaml", "a//b.json"]) {
      expect(INDEX_FILE_PATH_RE.test(p)).toBe(false);
      expect(indexFilePatch(p, null, SPEC)).toMatchObject({ ok: false, rule: "bad-path" });
    }
    expect(INDEX_FILE_PATH_RE.test("firebase/firestore.indexes.json")).toBe(true);
  });
});
