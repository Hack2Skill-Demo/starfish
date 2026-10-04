import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { buildLoopSubject, incidentFromDoc, readSourceFiles } from "./subject.js";
import type { EntryReader } from "../ingest/counterCheck.js";
import { testConfig } from "../testConfig.js";

let dir: string;
let outside: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subject-src-"));
  outside = mkdtempSync(join(tmpdir(), "subject-out-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "orders.ts"), "export function createOrder() {}\n");
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET-VALUE");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("incidentFromDoc", () => {
  it("maps a stored incident to what the stages read, with timestamps as ISO strings", () => {
    const i = incidentFromDoc("inc1", {
      environment: "demo",
      functionName: "orders-createOrder",
      errorMessage: "Cannot use undefined",
      stackTrace: "at src/orders.ts:3:1",
      occurrenceCount: 12,
      httpStatus: 500,
      firstOccurredAt: Timestamp.fromMillis(Date.UTC(2026, 9, 4, 10)),
      lastOccurredAt: "2026-10-04T11:00:00.000Z",
    });
    expect(i).toEqual({
      id: "inc1",
      environment: "demo",
      functionName: "orders-createOrder",
      message: "Cannot use undefined",
      stackTrace: "at src/orders.ts:3:1",
      occurrenceCount: 12,
      httpStatus: 500,
      firstOccurredAt: "2026-10-04T10:00:00.000Z",
      lastOccurredAt: "2026-10-04T11:00:00.000Z",
    });
  });

  it("leaves out what is missing or the wrong type, and invents no counter-check", () => {
    const i = incidentFromDoc("x", { environment: "demo", occurrenceCount: "many", stackTrace: "", firstOccurredAt: { toDate: () => new Date("garbage") } });
    expect(i).toEqual({ id: "x", environment: "demo" });
    expect(i).not.toHaveProperty("logCounterCheck");
  });
});

describe("readSourceFiles", () => {
  it("reads regular files inside the checkout", async () => {
    expect(await readSourceFiles(dir, ["src/orders.ts"])).toEqual([{ path: "src/orders.ts", content: "export function createOrder() {}\n" }]);
  });

  it("never follows a link out of the checkout, and skips a path that climbs out of it", async () => {
    symlinkSync(join(outside, "secret.txt"), join(dir, "src", "link.ts"));
    symlinkSync(outside, join(dir, "linkdir"));
    const files = await readSourceFiles(dir, ["src/link.ts", "linkdir/secret.txt", "../" + outside.split("/").pop() + "/secret.txt", "src/orders.ts"]);
    expect(files.map((f) => f.path)).toEqual(["src/orders.ts"]);
    expect(JSON.stringify(files)).not.toContain("TOP-SECRET");
  });

  it("skips a directory, a binary file and a missing one, and cuts a very long file", async () => {
    writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, "big.ts"), "a".repeat(300_000));
    const files = await readSourceFiles(dir, ["src", "bin.dat", "nope.ts", "big.ts"]);
    expect(files.map((f) => f.path)).toEqual(["big.ts"]);
    expect(files[0]!.content.length).toBe(100_000);
  });
});

describe("buildLoopSubject", () => {
  const checkout = (files: string[]) => ({ dir, revision: "a".repeat(40), files, cleanup: async () => undefined });
  const logging = (entries: unknown[]): EntryReader => ({ getEntries: async () => [entries, null] });
  const incident = { id: "inc1", environment: "demo", functionName: "orders-createOrder", message: "boom", stackTrace: "Error: boom\n    at createOrder (/workspace/src/orders.ts:3:9)" };

  it("takes the counter-check now (the ingest stores none), and picks the file the stack names", async () => {
    const entries = [{ metadata: { timestamp: new Date(), severity: "ERROR" }, data: { message: "boom" } }];
    const s = await buildLoopSubject(testConfig(), logging(entries), checkout(["src/orders.ts", "README.md"]), incident, "new");
    expect(s.subject.incident.logCounterCheck).toMatchObject({ window: "24h", count: 1 });
    expect(s.files.map((f) => f.path)).toEqual(["src/orders.ts"]);
    expect(s.baseRevision).toBe("a".repeat(40));
    expect(s.sourceDir).toBe(dir);
  });

  it("leaves the counter-check out when Logging failed: missing is not zero", async () => {
    const down: EntryReader = {
      getEntries: async () => {
        throw new Error("logging is down");
      },
    };
    const s = await buildLoopSubject(testConfig(), down, checkout(["src/orders.ts"]), incident, "new");
    expect(s.subject.incident).not.toHaveProperty("logCounterCheck");
    expect(s.subject.samples).toEqual([]);
  });

  it("never reads a file the deployment excludes, even when the stack names it", async () => {
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "deploy.ts"), "x");
    const inc = { ...incident, stackTrace: "at f (/app/.github/deploy.ts:1:1)" };
    const s = await buildLoopSubject(testConfig({ patchExcludedPaths: [".github/"] }), logging([]), checkout([".github/deploy.ts"]), inc, "new");
    expect(s.files).toEqual([]);
  });
});
