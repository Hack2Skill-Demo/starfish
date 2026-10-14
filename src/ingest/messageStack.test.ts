import { describe, it, expect } from "vitest";
import { messageTitle, splitMessageStack } from "./messageStack.js";
import { computeErrorFingerprint, fingerprintOf, fingerprintOfLogEntry } from "./fingerprint.js";
import { detectErrorType, extractErrorCode } from "./classify.js";
import { parseLogEntry, type RawLogEntry } from "./parseLogEntry.js";

// #361: the demo app's orders-getOrder logged ONE bug in two shapes, each with its stack INSIDE the message. Its core
// is short, so before the split the differing frames entered the 100 hashed characters: two fingerprints.
const CORE = "Cannot read properties of undefined (reading 'toString')";
/** onCall's `logger.error("Unhandled error", err)`: the message, then err.stack (the app's frames). */
const UNHANDLED =
  `Unhandled error TypeError: ${CORE}\n` +
  "    at getOrder (/workspace/lib/orders/getOrder.js:22:31)\n" +
  "    at /workspace/node_modules/firebase-functions/lib/common/providers/https.js:544:32\n" +
  "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)";
/** The handler's `logger.error("orders-getOrder failed: ...")`: the logger writes `new Error(message).stack` (its own frames). */
const RETHROW =
  `Error: orders-getOrder failed: ${CORE}\n` +
  "    at entryFromArgs (/workspace/node_modules/firebase-functions/lib/logger/index.js:133:19)\n" +
  "    at Object.error (/workspace/node_modules/firebase-functions/lib/logger/index.js:164:11)\n" +
  "    at /workspace/lib/orders/getOrder.js:30:16";
const FN = "orders-getorder";

const at = (data: unknown, labels: Record<string, string> = { service_name: FN }): RawLogEntry => ({
  metadata: { timestamp: "2026-10-12T00:00:00.000Z", resource: { labels } },
  data,
});

describe("splitMessageStack (#361)", () => {
  it("cuts a message at its first V8 frame line and keeps the whole text as the stack", () => {
    expect(splitMessageStack(UNHANDLED)).toEqual({ title: `Unhandled error TypeError: ${CORE}`, stack: UNHANDLED });
    expect(splitMessageStack(RETHROW)).toEqual({ title: `Error: orders-getOrder failed: ${CORE}`, stack: RETHROW });
  });

  it("knows every frame shape V8 prints", () => {
    for (const frame of [
      "    at fn (/workspace/lib/x.js:1:2)",
      "    at /workspace/lib/x.js:1:2",
      "    at node:internal/process/task_queues:95:5",
      "    at async Promise.all (index 0)",
      "    at new Promise (<anonymous>)",
      "\tat <anonymous>",
      "    at Object.<anonymous> (C:\\app\\x.js:1:2)\r",
    ]) {
      expect(splitMessageStack(`boom\n${frame}`)).toEqual({ title: "boom", stack: `boom\n${frame}` });
    }
  });

  it("keeps a multi-line title whole up to the frames, and CRLF text", () => {
    expect(messageTitle("first line\nsecond line\n    at x (/a.js:1:2)")).toBe("first line\nsecond line");
    expect(messageTitle("boom  \r\n    at x (/a.js:1:2)\r\n")).toBe("boom");
  });

  it("leaves alone a text with no frame, prose that only starts like one, and a text that is nothing but frames", () => {
    for (const text of [
      "plain message",
      "Error: failed\n  at least one field is required",
      "Error: failed\nat x (/a.js:1:2)",
      "    at x (/a.js:1:2)\n    at y (/b.js:3:4)",
      "\n   \n    at x (/a.js:1:2)",
      "",
    ]) {
      expect(splitMessageStack(text)).toEqual({ title: text });
    }
    expect(splitMessageStack(undefined as unknown as string)).toEqual({ title: "" });
  });
});

describe("fingerprint: a short core with differing frames is one incident (#361)", () => {
  it("gives the demo's two shapes one fingerprint, the core's", () => {
    expect(computeErrorFingerprint(FN, UNHANDLED)).toBe(computeErrorFingerprint(FN, RETHROW));
    expect(fingerprintOfLogEntry(FN, UNHANDLED)).toBe(fingerprintOfLogEntry(FN, RETHROW));
    expect(fingerprintOf(FN, UNHANDLED)).toBe(computeErrorFingerprint(FN, CORE));
  });

  it("gives one shape logged with other frames (another deploy, another caller) one fingerprint", () => {
    const moved = RETHROW.replace("getOrder.js:30:16", "getOrder.js:41:9").replace("index.js:133:19", "index.js:140:3");
    expect(computeErrorFingerprint(FN, moved)).toBe(computeErrorFingerprint(FN, RETHROW));
  });

  it("is the same whether ingest split the message first or a stored record still holds the frames", () => {
    const parsed = parseLogEntry(at(RETHROW))!;
    expect(fingerprintOfLogEntry(parsed.functionName, parsed.errorMessage)).toBe(fingerprintOf(FN, RETHROW));
  });
});

describe("parseLogEntry: a message that carries its own stack (#361)", () => {
  it("keeps the title as the message and the frames as the stack, for a JSON and a plain-text payload", () => {
    for (const data of [{ message: RETHROW }, RETHROW]) {
      const parsed = parseLogEntry(at(data))!;
      expect(parsed.errorMessage).toBe(`Error: orders-getOrder failed: ${CORE}`);
      expect(parsed.stackTrace).toBe(RETHROW);
    }
  });

  it("never overwrites a stack field the entry carried", () => {
    const parsed = parseLogEntry(at({ message: UNHANDLED, stack: "TypeError: x\n    at own (/workspace/lib/own.js:1:1)" }))!;
    expect(parsed.errorMessage).toBe(`Unhandled error TypeError: ${CORE}`);
    expect(parsed.stackTrace).toBe("TypeError: x\n    at own (/workspace/lib/own.js:1:1)");
  });

  it("leaves a message with no frames as it was", () => {
    const parsed = parseLogEntry(at({ message: "Error: failed\n  at least one field is required" }))!;
    expect(parsed.errorMessage).toBe("Error: failed\n  at least one field is required");
    expect(parsed.stackTrace).toBeUndefined();
  });

  it("takes an error equal to the title as no detail, and an error with frames as the message when there is none", () => {
    expect(parseLogEntry(at({ message: RETHROW, error: `Error: orders-getOrder failed: ${CORE}` }))!.errorDetail).toBeUndefined();
    const fromError = parseLogEntry(at({ error: UNHANDLED }))!;
    expect(fromError.errorMessage).toBe(`Unhandled error TypeError: ${CORE}`);
    expect(fromError.errorDetail).toBeUndefined();
    expect(fromError.stackTrace).toBe(UNHANDLED);
  });

  it("still drops an ignored message found only in the frames, as the query side does", () => {
    expect(parseLogEntry(at({ message: RETHROW }), ["entryFromArgs"])).toBeNull();
  });
});

describe("classification reads the title, never the frames (#361)", () => {
  // Every Node stack has `node:internal/...` frames; these also name a timers frame and a permissions file.
  const NODE_STACK =
    `Error: orders-getOrder failed: ${CORE}\n` +
    "    at check (/workspace/lib/users/permissions.js:12:7)\n" +
    "    at listOnTimeout (node:internal/timers:581:17)\n" +
    "    at process.processTimers (node:internal/timers:519:7)";

  it("was misread when the frames were in the message", () => {
    expect(extractErrorCode(NODE_STACK)).toBe("internal");
    expect(["TimeoutError", "AuthError"]).toContain(detectErrorType(NODE_STACK));
  });

  it("gives no `internal` code and no TimeoutError or AuthError from the frames once parsed", () => {
    const parsed = parseLogEntry(at({ message: NODE_STACK }))!;
    expect(extractErrorCode(parsed.errorMessage)).toBeUndefined();
    expect(detectErrorType(parsed.errorMessage)).not.toMatch(/^(TimeoutError|AuthError)$/);
    expect(detectErrorType(parsed.errorMessage)).toBe(detectErrorType(`Error: orders-getOrder failed: ${CORE}`));
  });
});
