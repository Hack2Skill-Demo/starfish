import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { counterCheckRecord, readBaseFiles, retryWords, roundOf } from "./loop.js";

describe("counterCheckRecord: the recount kept with triage's decision (#39)", () => {
  it("keeps the count, window, cap, time and the exact filter", () => {
    expect(counterCheckRecord({ window: "24h", count: 12, capped: true, filter: 'severity>=ERROR AND resource.labels.function_name="f"', checkedAt: "2026-10-05T10:00:00.000Z" })).toEqual({
      counterCount: 12,
      counterWindow: "24h",
      counterCapped: true,
      counterCheckedAt: "2026-10-05T10:00:00.000Z",
      counterFilter: 'severity>=ERROR AND resource.labels.function_name="f"',
    });
  });

  it("records a missing check as missing, never as zero", () => {
    expect(counterCheckRecord(undefined)).toEqual({ counterCount: null });
    expect(counterCheckRecord({ window: "24h", count: Number.NaN })).toEqual({ counterCount: null });
  });

  it("keeps a realistic filter longer than an ordinary record value whole", () => {
    const filter = `severity>=ERROR AND ${"NOT resource.labels.service_name=\"starfish-ingest\" ".repeat(10)}`;
    expect(filter.length).toBeGreaterThan(300);
    expect(counterCheckRecord({ window: "24h", count: 1, filter }).counterFilter).toBe(filter);
  });

  it("leaves out a filter too long to store whole, rather than keeping a cut one that would count something else", () => {
    const r = counterCheckRecord({ window: "24h", count: 3, filter: "x".repeat(2001) });
    expect(r.counterFilter).toBeUndefined();
    expect(r.counterCount).toBe(3);
  });
});

describe("readBaseFiles: the base content gate 1 judges the enclosing function on (#202)", () => {
  const root = mkdtempSync(join(tmpdir(), "base-files-"));
  const outside = mkdtempSync(join(tmpdir(), "base-outside-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/order.ts"), "export function f() {\n  return 1;\n}\n");
  writeFileSync(join(outside, "secret.ts"), "if (isOwner(x)) return true;\n");
  symlinkSync(join(outside, "secret.ts"), join(root, "src/linked.ts"));
  symlinkSync(outside, join(root, "linkdir"));
  writeFileSync(join(root, "src/binary.ts"), "a\0b");
  const edit = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
  const created = "--- /dev/null\n+++ b/src/new.test.ts\n@@ -0,0 +1 @@\n+x\n";

  it("reads the existing files the patch changes, and nothing else", async () => {
    const got = await readBaseFiles(root, edit("src/order.ts") + created);
    expect([...got.keys()]).toEqual(["src/order.ts"]);
    expect(got.get("src/order.ts")).toContain("return 1;");
  });

  it("leaves out a missing file, a symbolic link, a path through one, and a binary file: gate 1 then refuses", async () => {
    for (const path of ["src/missing.ts", "src/linked.ts", "linkdir/secret.ts", "src/binary.ts"]) {
      expect((await readBaseFiles(root, edit(path))).size, path).toBe(0);
    }
    expect((await readBaseFiles(join(root, "nope"), edit("src/order.ts"))).size).toBe(0);
    expect((await readBaseFiles(root, "garbage")).size).toBe(0);
  });
});

describe("roundOf / retryWords", () => {
  it("counts a run's rounds from its reopenings, reading anything odd as round 1", () => {
    expect(roundOf(undefined)).toBe(1);
    expect(roundOf({})).toBe(1);
    expect(roundOf({ reconsiderCount: 1 })).toBe(2);
    expect(roundOf({ reconsiderCount: 3 })).toBe(4);
    for (const odd of [-1, 0.5, "x", null, Number.NaN]) expect(roundOf({ reconsiderCount: odd }), String(odd)).toBe(1);
  });

  it("words a retry from round 2 only, with why in Starfish's own words, never a stored string it does not know", () => {
    expect(retryWords(1, "operator")).toEqual({});
    expect(retryWords(2, "operator")).toEqual({ round: 2, retriedBecause: "an operator asked for a retriage" });
    expect(retryWords(2, "<!channel> injected")).toEqual({ round: 2 });
    expect(retryWords(3, "toString")).toEqual({ round: 3 });
    expect(retryWords(2, undefined)).toEqual({ round: 2 });
  });
});
