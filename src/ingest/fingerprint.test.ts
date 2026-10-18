import { describe, it, expect } from "vitest";
import {
  computeErrorFingerprint,
  earlierFingerprints,
  errorCore,
  FINGERPRINT_VERSION,
  fingerprintOf,
  fingerprintOfLogEntry,
  fingerprintsOfLogEntry,
  overflowDayOf,
} from "./fingerprint.js";

// #318: one coupon-less checkout in the demo app logged ONE bug as two ERROR entries, which became two incidents,
// two cycles and two GitHub issues. These are the two shapes, with a realistic stack suffix on each.
const CORE =
  'Value for argument "data" is not a valid Firestore document. Cannot use "undefined" as a Firestore value (found in field "couponCode"). If you want to ignore undefined values, enable `ignoreUndefinedProperties`.';
const FIREBASE_UNHANDLED =
  `Unhandled error Error: ${CORE}\n` +
  "    at validateUserInput (/workspace/node_modules/@google-cloud/firestore/build/src/serializer.js:417:15)\n" +
  "    at createOrder (/workspace/lib/orders/createOrder.js:58:11)";
const HANDLER_RETHROW =
  `Error: orders-createOrder failed: ${CORE}\n` + "    at /workspace/lib/orders/createOrder.js:91:13\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)";
// The function as a second-generation function's log labels it (service_name: lowercased).
const FN = "orders-createorder";

describe("fingerprint: one bug logged under two wrappers is one incident (#318)", () => {
  it("gives Firebase's `Unhandled error` line and the handler's `<function> failed:` rethrow one fingerprint", () => {
    expect(computeErrorFingerprint(FN, FIREBASE_UNHANDLED)).toBe(computeErrorFingerprint(FN, HANDLER_RETHROW));
    // ... the same one ingest groups by and the store keys on.
    expect(fingerprintOfLogEntry(FN, FIREBASE_UNHANDLED)).toBe(fingerprintOfLogEntry(FN, HANDLER_RETHROW));
    expect(fingerprintOf(FN, FIREBASE_UNHANDLED)).toBe(fingerprintOf(FN, HANDLER_RETHROW));
  });

  it("is the fingerprint of the core text itself, under either spelling of the function", () => {
    expect(computeErrorFingerprint(FN, FIREBASE_UNHANDLED)).toBe(computeErrorFingerprint(FN, CORE));
    expect(computeErrorFingerprint("orders-createOrder", HANDLER_RETHROW)).toBe(computeErrorFingerprint(FN, CORE));
  });

  it("takes off every wrapper at the start, in any order, up to the bound", () => {
    expect(errorCore("Unhandled error Error: orders-createOrder failed: boom", FN)).toBe("boom");
    expect(errorCore("Error: orders-createOrder failed: TypeError: boom", FN)).toBe("boom");
    expect(errorCore("Unhandled error: FirebaseError: boom", FN)).toBe("boom");
    expect(errorCore("unhandled error\nError:  boom", FN)).toBe("boom");
    // A pathological pile of wrappers stops at the bound (8) instead of looping over the whole text.
    const pile = `${"Error: ".repeat(20)}boom`;
    expect(errorCore(pile, FN)).toBe(`${"Error: ".repeat(12)}boom`);
  });

  it("keeps the core's own words: two different bugs under the same wrapper stay apart", () => {
    expect(computeErrorFingerprint(FN, "Unhandled error Error: boom")).not.toBe(computeErrorFingerprint(FN, "Unhandled error Error: bang"));
    expect(computeErrorFingerprint(FN, `Error: orders-createOrder failed: ${CORE}`)).not.toBe(
      computeErrorFingerprint(FN, "Error: orders-createOrder failed: Cannot read properties of undefined (reading 'total')")
    );
  });

  it("strips `<x> failed:` only when x is the incident's own function", () => {
    // Another function's name, a word, or a phrase is ordinary text.
    expect(errorCore("orders-createOrder failed: boom", "api")).toBe("orders-createOrder failed: boom");
    expect(errorCore("Upload failed: timeout", "api")).toBe("Upload failed: timeout");
    expect(errorCore("order 1001 failed: boom", "ordersCreate")).toBe("order 1001 failed: boom");
    expect(errorCore("Checkout for orders-createOrder failed: boom", FN)).toBe("Checkout for orders-createOrder failed: boom");
    // A name with no function to compare it with is never stripped.
    expect(errorCore("x failed: boom", "")).toBe("x failed: boom");
    // So `Upload failed: timeout` and `Download failed: timeout` in one function stay two incidents.
    expect(computeErrorFingerprint("api", "Upload failed: timeout")).not.toBe(computeErrorFingerprint("api", "Download failed: timeout"));
  });

  it("never strips a wrapper that would leave nothing, nor prose that only looks like one", () => {
    for (const message of [
      "Error:",
      "Error: ",
      "Unhandled error",
      "Unhandled errors: 3 jobs dropped",
      "Errors: 2 of 5 writes rejected",
      "Error:no space after the colon",
      "Request error: upstream reset",
      "error: lowercase is a log level, not an error class",
      "An Error: in the middle is not a wrapper",
      "orders-createOrder failed:no space",
    ]) {
      expect(errorCore(message, FN)).toBe(message);
    }
    // The last wrapper stays when taking it would leave nothing.
    expect(errorCore("Unhandled error Error: ", FN)).toBe("Error: ");
  });

  it("does not move the namespaced fingerprints, even for a message that looks wrapped", () => {
    expect(fingerprintOf("api", "Error: wrapped text in a monitoring description", "monitoring")).toBe("mon-3b9635ccc15b6c22");
    expect(fingerprintOf("api", "Error: api failed: wrapped text", "platform-quota")).toBe("pq-e70b2853c37516ab");
  });
});

describe("fingerprint: every message without a wrapper hashes as before #318", () => {
  // Pinned with the code before #318. A message that carries no wrapper must keep its fingerprint byte for byte,
  // or its open incident would be forked by its next occurrence.
  const long = `Deadline exceeded while reading ${"segment ".repeat(150)}end`;
  const PINNED: [string, string, string][] = [
    ["api", "boom", "7f115aa23c174746"],
    [
      "orders-createOrder",
      'Cannot use "undefined" as a Firestore value (found in field "couponCode"). If you want to ignore undefined values, enable `ignoreUndefinedProperties`.',
      "226203dfbb7d07e8",
    ],
    ["api", "Upload failed for uploads/t1/docs/run-e53584a0-v1.pdf after 30000ms at 2026-09-24T15:04:05Z", "f99a98ff5be7170f"],
    ["api", "Cannot read properties of undefined (reading 'lrn')", "7006bb37daf669ce"],
    ["api", "provider returned status 401", "775a663f99781a3b"],
    [
      "listRecentOrders",
      "9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/demo-shop/firestore/indexes?create_composite=Ckxwcm9qZWN0cy9kZW1v",
      "5e8c2ead3604abda",
    ],
    ["sendMail", "email send failed", "101d76c9a5ec6331"],
    ["orders-create", "The request failed because the project exceeded its quota limit for run.googleapis.com/cpu_allocation recently.", "773d26714768f0c1"],
    ["lookup", "No user for [redacted-email]", "08409d5d45ceee52"],
    ["syncOrders_v2", "order sync timed out", "8e0088b7d8ce1967"],
    ["ordersCreate", "order 1001 failed: Cannot read properties of undefined (reading 'total')", "31dbdfb5895d52b8"],
    ["api", "Payment capture failed: card declined", "11710715c0d56c35"],
    ["api", "Upload failed: timeout after 30000ms", "b7427e644a929127"],
    ["api", `orders-createOrder failed: ${CORE}`, "70f1a57ea6aaa9a5"],
    ["orders-createOrder", `Checkout for orders-createOrder failed: ${CORE}`, "bc837797c8d6d9e0"],
    ["orders-createOrder", `orders-createOrder failed:${CORE}`, "68620dea7bfb3938"],
    ["api", "Unhandled errors: 3 jobs dropped", "25a0a8d2944204ec"],
    ["api", "Unhandled error", "8534ba268591a9be"],
    ["api", "Error:", "64f5f1d2a6b3a2c8"],
    ["api", "Error: ", "64f5f1d2a6b3a2c8"],
    ["api", "Errors: 2 of 5 writes rejected", "100ac170d2ecf078"],
    ["api", "Error:no space after the colon", "4ba8d5965c677ee2"],
    ["api", "Request error: upstream reset", "af2efaf3c576df94"],
    ["api", "An Error: in the middle is not a wrapper", "1e2f5bd2d6098484"],
    ["api", '{"code":5,"details":"NOT_FOUND"}', "dec336bd576076ba"],
    ["api", "[object Object]", "cd1e445375d69e64"],
    ["api", "", "d212c3feb6897bfc"],
    ["api", long, "7603d4e309b85b43"],
    ["orders-createOrder", `  ${CORE}\n    at createOrder (/workspace/lib/orders/createOrder.js:58:11)`, "8633585fc3d17325"],
  ];

  it.each(PINNED)("%s: %s", (functionName, message, fingerprint) => {
    expect(computeErrorFingerprint(functionName, message)).toBe(fingerprint);
    expect(fingerprintOf(functionName, message)).toBe(fingerprint);
  });

  it("keeps the namespaced fingerprints as they were", () => {
    expect(
      fingerprintOf("orders-create", "Cloud Monitoring counted 5xx responses (run.googleapis.com/request_count) with no ERROR log entry", "monitoring")
    ).toBe("mon-36396b10080cce94");
    expect(
      fingerprintOf(
        "orders-create",
        "Cloud Monitoring counted failed executions (cloudfunctions.googleapis.com/function/execution_count) with no ERROR log entry",
        "monitoring"
      )
    ).toBe("mon-e04b57ebc3c26d8d");
    expect(
      fingerprintOf(
        "cloud-run-platform-quota",
        "Project exceeded its Cloud Run quota (run.googleapis.com/cpu_allocation); requests were rejected before reaching any function. Typically a deploy rolling many revisions at once.",
        "platform-quota"
      )
    ).toBe("pq-34a1ed26ce34d56c");
  });

  it("the wrapped shapes are the ones that move: to their core's fingerprint", () => {
    // Before #318 these were 2d6dd8bbf7a144ab and 90a68f5c4b3d7f78: two incidents for one bug.
    expect(computeErrorFingerprint(FN, FIREBASE_UNHANDLED)).toBe("8633585fc3d17325");
    expect(computeErrorFingerprint(FN, HANDLER_RETHROW)).toBe("8633585fc3d17325");
  });
});

describe("the fingerprint's versions (#432)", () => {
  // One onCall error as the firebase-functions logger writes it: its stack inside the message. Ingest stores the title
  // and keeps the whole text as the stack (#361); before #361 it stored the whole text as the message.
  const fn = "orders-createOrder";
  const title = "Error: orders-createOrder failed: Order 1001 has no items";
  const whole = `${title}\n    at validate (/workspace/lib/orders/createOrder.js:58:11)\n    at process (node:internal/process/task_queues:95:5)`;
  // Pinned from the code itself, run at each version: acbdc48 (#26, version 1) and c4b8101 (#318, version 2).
  const V1_WHOLE = "7b62b77b76337e58";
  const V1_TITLE = "8703bbced6713aec";
  const V2_WHOLE = "a624385816724193";

  it("is at version 4", () => {
    expect(FINGERPRINT_VERSION).toBe(4);
  });

  it("gives the fingerprints each earlier version stored for the same occurrence, newest first, the current one left out", () => {
    const current = fingerprintOf(fn, title);
    expect(current).toBe("0e7952de852c22ef");
    // Version 3 is the current one for a log error; version 2 stored the whole text with its wrappers off, version 1
    // the whole text, or the title where the message carried no frames.
    expect(earlierFingerprints({ functionName: fn, errorMessage: title, stackTrace: whole })).toEqual([V2_WHOLE, V1_TITLE, V1_WHOLE]);
  });

  it("reconstructs the whole text only from a stack that is the message's own", () => {
    // A stack field of the entry's own, whose title is not the message: only the message itself is a guess.
    const own = "TypeError: x is undefined\n    at f (/workspace/lib/a.js:1:2)";
    expect(earlierFingerprints({ functionName: fn, errorMessage: title, stackTrace: own })).toEqual([V1_TITLE]);
    expect(earlierFingerprints({ functionName: fn, errorMessage: title })).toEqual([V1_TITLE]);
  });

  it("has nothing earlier for a message no version read differently", () => {
    expect(earlierFingerprints({ functionName: fn, errorMessage: "Order has no items" })).toEqual([]);
  });

  it("has nothing earlier for a Monitoring-only or quota incident: their fingerprints never moved", () => {
    expect(earlierFingerprints({ functionName: "api", errorMessage: "Cloud Monitoring counted failed executions", signalSource: "monitoring" })).toEqual([]);
    expect(earlierFingerprints({ functionName: "cloud-run-platform-quota", errorMessage: "Project exceeded its Cloud Run quota (x)", signalSource: "platform-quota" })).toEqual([]);
  });

  it("keys an overflow incident by function and UTC day, and knows the per-window wording it was keyed by before (#434)", () => {
    const now = "High-cardinality overflow on 2026-10-10 (UTC): distinct errors of this function past the daily cap on new incidents";
    const before =
      "High-cardinality overflow on 2026-10-10 (UTC): distinct errors of this function past the per-window cap on new incidents, each matching no stored incident, are counted here instead of opening one incident each";
    // The wording no longer moves it: both texts name the same day.
    expect(fingerprintOf("api", now, "overflow")).toBe(fingerprintOf("api", before, "overflow"));
    expect(fingerprintOf("api", now, "overflow")).toBe("ovf-913aeaca300f0826");
    expect(fingerprintOf("API", now, "overflow")).toBe(fingerprintOf("api", now, "overflow"));
    expect(fingerprintOf("api", now.replace("10-10", "10-11"), "overflow")).not.toBe(fingerprintOf("api", now, "overflow"));
    // Version 3's fingerprint of that day, pinned from c4b8101.
    expect(earlierFingerprints({ functionName: "api", errorMessage: now, signalSource: "overflow" })).toEqual(["ovf-f5155c03941fa5f1"]);
    expect(overflowDayOf(now)).toBe("2026-10-10");
    expect(overflowDayOf("no day here")).toBeUndefined();
  });

  it("matches a log entry by every fingerprint it has had, the current one first", () => {
    expect(fingerprintsOfLogEntry(fn, title, whole)).toEqual(["0e7952de852c22ef", V2_WHOLE, V1_TITLE, V1_WHOLE]);
  });
});
