/**
 * firestore.rules against the real emulator. These rules are the only thing
 * standing between the web UI and the incident store, so every allow and every
 * deny that matters is pinned here.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, deleteField, doc, getDoc, serverTimestamp, setDoc, updateDoc, Timestamp } from "firebase/firestore";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-starfish-rules",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8085 },
  });
});
afterAll(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "starfish_users/admin1"), { roles: ["admin"] });
    await setDoc(doc(db, "starfish_users/op1"), { roles: ["operator"] });
    await setDoc(doc(db, "starfish_users/nobody"), { roles: [] });
    await setDoc(doc(db, "incidents/i1"), {
      functionName: "mailDrainer",
      errorMessage: "send failed",
      status: "new",
      occurrenceCount: 3,
      updatedAt: Timestamp.now(),
    });
  });
});

const as = (uid: string) => env.authenticatedContext(uid).firestore();

/** Put incidents/i1 into a given stored status, bypassing the rules. */
const seedStatus = (status: string) =>
  env.withSecurityRulesDisabled((ctx) =>
    setDoc(doc(ctx.firestore(), "incidents/i1"), { functionName: "mailDrainer", status, updatedAt: Timestamp.now() })
  );
const anon = () => env.unauthenticatedContext().firestore();

describe("operator records", () => {
  it("a user reads only their own record", async () => {
    await assertSucceeds(getDoc(doc(as("op1"), "starfish_users/op1")));
    await assertFails(getDoc(doc(as("op1"), "starfish_users/admin1")));
    await assertFails(getDoc(doc(anon(), "starfish_users/op1")));
  });

  it("nobody grants themselves a role from the client", async () => {
    await assertFails(setDoc(doc(as("nobody"), "starfish_users/nobody"), { roles: ["admin"] }));
    await assertFails(updateDoc(doc(as("op1"), "starfish_users/op1"), { roles: ["admin"] }));
  });
});

describe("incidents: read", () => {
  it("operators and admins read; users without a role and anonymous visitors don't", async () => {
    await assertSucceeds(getDoc(doc(as("op1"), "incidents/i1")));
    await assertSucceeds(getDoc(doc(as("admin1"), "incidents/i1")));
    await assertFails(getDoc(doc(as("nobody"), "incidents/i1")));
    await assertFails(getDoc(doc(as("stranger"), "incidents/i1")));
    await assertFails(getDoc(doc(anon(), "incidents/i1")));
  });
});

describe("incidents: triage writes", () => {
  const triage = (uid: string, extra: Record<string, unknown> = {}) =>
    updateDoc(doc(as(uid), "incidents/i1"), {
      status: "acknowledged",
      updatedAt: serverTimestamp(),
      statusChangedBy: uid,
      ...extra,
    });

  it("an operator changes status, naming themselves", async () => {
    await assertSucceeds(triage("op1"));
    await assertSucceeds(triage("op1", { status: "resolved", resolvedAt: serverTimestamp() }));
  });

  it("allows exactly the operator transitions, checked against the stored status", async () => {
    await seedStatus("new");
    await assertSucceeds(triage("op1", { status: "ignored", resolvedAt: deleteField() }));
    await assertSucceeds(triage("op1", { status: "new", resolvedAt: deleteField() })); // ignored -> new
    await seedStatus("logged");
    await assertSucceeds(triage("op1", { status: "resolved", resolvedAt: serverTimestamp() }));
    await seedStatus("recurred"); // a regression is open: resolve or ignore it
    await assertSucceeds(triage("op1", { status: "resolved", resolvedAt: serverTimestamp() }));
    await seedStatus("recurred");
    await assertSucceeds(triage("op1", { status: "ignored", resolvedAt: deleteField() }));
  });

  it("never lets a client set logged or recurred, or reopen a resolved incident", async () => {
    await assertFails(triage("op1", { status: "logged" })); // new -> logged
    await assertFails(triage("op1", { status: "recurred" })); // new -> recurred
    await seedStatus("resolved");
    await assertFails(triage("op1", { status: "new" }));
    await assertFails(triage("op1", { status: "acknowledged" }));
    await assertFails(triage("op1", { status: "recurred" })); // only the engine re-opens
  });

  it("rejects a stale tab overwriting another operator's resolve", async () => {
    // Operator B resolved it; operator A's tab still shows "new" and clicks Ignore.
    await seedStatus("resolved");
    await assertFails(triage("op1", { status: "ignored", resolvedAt: deleteField() }));
  });

  it("stamps resolvedAt exactly when resolved, and only with server time", async () => {
    await assertFails(triage("op1", { status: "resolved" })); // no resolvedAt
    await assertFails(triage("op1", { status: "resolved", resolvedAt: Timestamp.fromMillis(0) }));
    await assertFails(triage("op1", { status: "acknowledged", resolvedAt: "lol" }));
  });

  it("can't touch anything but status and its bookkeeping", async () => {
    await assertFails(triage("op1", { errorMessage: "rewritten" }));
    await assertFails(triage("op1", { occurrenceCount: 0 }));
  });

  it("can't attribute the change to someone else, or backdate it", async () => {
    await assertFails(triage("op1", { statusChangedBy: "admin1" }));
    await assertFails(triage("op1", { updatedAt: Timestamp.fromMillis(0) }));
  });

  it("can't set an unknown status", async () => {
    await assertFails(triage("op1", { status: "deleted" }));
  });

  it("a user without a role can't triage", async () => {
    await assertFails(triage("nobody"));
  });

  it("nobody creates or deletes incidents from the client", async () => {
    await assertFails(setDoc(doc(as("admin1"), "incidents/new"), { status: "new" }));
    await assertFails(deleteDoc(doc(as("admin1"), "incidents/i1")));
  });
});

describe("everything else", () => {
  it("is closed", async () => {
    await assertFails(getDoc(doc(as("admin1"), "config/anything")));
    await assertFails(setDoc(doc(as("admin1"), "config/anything"), { x: 1 }));
  });
});
