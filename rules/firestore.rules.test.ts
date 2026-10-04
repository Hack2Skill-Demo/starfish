/**
 * firestore.rules against the real emulator. These rules are the only thing
 * standing between the web UI and the incident store, so every allow and every
 * deny that matters is pinned here.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  Timestamp,
} from "firebase/firestore";
import { validateSettings } from "../src/runtimeSettings.js";
import { readRecentChanges, saveSettings, settingsCollections } from "../web/src/lib/settingsWrite";

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

  it("includes the engine's incident keys: a client can't repoint one", async () => {
    await assertFails(getDoc(doc(as("admin1"), "incident_keys/k")));
    await assertFails(setDoc(doc(as("admin1"), "incident_keys/k"), { incidentId: "i1" }));
  });
});

describe("runtime settings", () => {
  const CURRENT = "starfish_settings/current";
  const PUBLIC = "starfish_settings_public/current";
  const auditPath = (id: string) => `starfish_settings_audit/${id}`;

  type Doc = Record<string, unknown>;
  interface SaveOptions {
    revision?: number;
    auditId?: string;
    /** Fields of the document being written, replacing the defaults. */
    current?: Doc;
    audit?: Doc;
    publicDoc?: Doc;
    skipAudit?: boolean;
    skipPublic?: boolean;
    /** What the audit entry claims the document was before; defaults to what it really was. */
    before?: unknown;
  }

  /** The stored settings document, bypassing the rules, or null. */
  const stored = async (): Promise<Doc | null> => {
    // withSecurityRulesDisabled returns nothing, so the value is carried out in a closure.
    let found: Doc | null = null;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(doc(ctx.firestore(), CURRENT));
      found = snap.exists() ? (snap.data() as Doc) : null;
    });
    return found;
  };

  /**
   * One save, written the way the Settings editor writes it: the document, its
   * audit entry and the operator copy in a single batch. Defaults are a correct
   * save; each test breaks one thing.
   */
  async function save(uid: string, fields: Doc = {}, o: SaveOptions = {}) {
    const db = as(uid);
    const prev = await stored();
    const revision = o.revision ?? ((prev?.revision as number | undefined) ?? 0) + 1;
    const auditId = o.auditId ?? `audit-${revision}-${Math.random().toString(36).slice(2, 10)}`;
    // `o.current` replaces fields of the document itself. The audit entry and the
    // operator copy are built from the document as written, so a test that breaks
    // the document breaks only the rule it means to, not the equalities between the three.
    const stamp = () => ("updatedAt" in (o.current ?? {}) ? o.current!.updatedAt : serverTimestamp());
    const current = (): Doc => ({
      version: 1,
      revision,
      auditId,
      updatedAt: stamp(),
      updatedBy: uid,
      ...fields,
      ...o.current,
    });
    const written = current();
    const batch = writeBatch(db);
    batch.set(doc(db, CURRENT), current());
    if (!o.skipAudit) {
      batch.set(doc(db, auditPath(String(written.auditId))), {
        revision: written.revision,
        by: uid,
        at: serverTimestamp(),
        before: "before" in o ? o.before : prev,
        after: current(),
        ...o.audit,
      });
    }
    if (!o.skipPublic) {
      batch.set(doc(db, PUBLIC), {
        version: 1,
        revision: written.revision,
        updatedAt: stamp(),
        ...(written.watchedProjectId !== undefined && { watchedProjectId: written.watchedProjectId }),
        ...(written.environment !== undefined && { environment: written.environment }),
        ...o.publicDoc,
      });
    }
    return batch.commit();
  }

  const settings = { watchedProjectId: "watched-app-1", environment: "prod", logResourceTypes: ["cloud_function"] };

  describe("who may save", () => {
    it("an admin saves the first settings, with their audit entry and operator copy", async () => {
      await assertSucceeds(save("admin1", settings));
      expect(await stored()).toMatchObject({ revision: 1, updatedBy: "admin1", environment: "prod" });
    });

    it("an operator, a user without a role and an anonymous visitor can't", async () => {
      await assertFails(save("op1", settings));
      await assertFails(save("nobody", settings));
      const anonDb = anon();
      const batch = writeBatch(anonDb);
      batch.set(doc(anonDb, CURRENT), { version: 1 });
      await assertFails(batch.commit());
    });

    it("an admin saves again, revision by revision", async () => {
      await assertSucceeds(save("admin1", settings));
      await assertSucceeds(save("admin1", { ...settings, environment: "staging" }));
      expect(await stored()).toMatchObject({ revision: 2, environment: "staging" });
    });

    it("rejects a stale tab and a skipped revision, so one admin can't overwrite another", async () => {
      await assertSucceeds(save("admin1", settings));
      await assertSucceeds(save("admin1", settings)); // revision 2
      await assertFails(save("admin1", settings, { revision: 2 })); // a tab still on revision 1
      await assertFails(save("admin1", settings, { revision: 4 }));
      await assertSucceeds(save("admin1", settings)); // revision 3
    });

    it("the first save over a document made from the console is revision 1", async () => {
      await env.withSecurityRulesDisabled((ctx) =>
        setDoc(doc(ctx.firestore(), CURRENT), { version: 1, environment: "console-made" })
      );
      await assertSucceeds(save("admin1", settings));
      expect(await stored()).toMatchObject({ revision: 1, environment: "prod" });
    });

    it("a reset is saving an empty document, and the operator copy follows", async () => {
      await assertSucceeds(save("admin1", settings));
      await assertSucceeds(save("admin1", {}));
      const op = await getDoc(doc(as("op1"), PUBLIC));
      expect(op.data()).not.toHaveProperty("environment");
      expect(op.get("revision")).toBe(2);
    });
  });

  describe("the three documents change together", () => {
    it("a settings change with no audit entry fails", async () => {
      await assertFails(save("admin1", settings, { skipAudit: true }));
    });

    it("a settings change that leaves the operator copy behind fails", async () => {
      await assertFails(save("admin1", settings, { skipPublic: true }));
      await assertSucceeds(save("admin1", settings));
      await assertFails(save("admin1", { ...settings, environment: "staging" }, { skipPublic: true }));
    });

    it("an audit entry with no settings change fails", async () => {
      await assertSucceeds(save("admin1", settings));
      const db = as("admin1");
      const prev = await stored();
      const batch = writeBatch(db);
      batch.set(doc(db, auditPath("forged-0001")), {
        revision: 2,
        by: "admin1",
        at: serverTimestamp(),
        before: prev,
        after: { ...prev, revision: 2, auditId: "forged-0001" },
      });
      await assertFails(batch.commit());
    });

    it("a change can't be recorded by pointing at an old audit entry instead of writing its own", async () => {
      await assertSucceeds(save("admin1", settings, { auditId: "audit-reused-1" }));
      // No new entry is written: the old one exists, but it describes a different change.
      await assertFails(save("admin1", { ...settings, environment: "staging" }, { auditId: "audit-reused-1", skipAudit: true }));
      // And writing it again is an overwrite of an immutable entry.
      await assertFails(save("admin1", settings, { auditId: "audit-reused-1" }));
    });

    it("the operator copy can't differ from the settings", async () => {
      await assertFails(save("admin1", settings, { publicDoc: { environment: "something-else" } }));
      await assertFails(save("admin1", settings, { publicDoc: { watchedProjectId: "another-proj-1" } }));
      await assertFails(save("admin1", settings, { publicDoc: { revision: 9 } }));
      await assertFails(save("admin1", settings, { publicDoc: { logResourceTypes: ["cloud_function"] } }));
    });

    it("only an admin writes the operator copy, and not on its own", async () => {
      await assertSucceeds(save("admin1", settings));
      const stale = (uid: string) =>
        setDoc(doc(as(uid), PUBLIC), { version: 1, revision: 1, updatedAt: serverTimestamp(), environment: "hijacked" });
      await assertFails(stale("op1"));
      await assertFails(stale("admin1")); // differs from the settings
    });
  });

  describe("what the audit entry must say", () => {
    it("is attributed to the caller and stamped by the server", async () => {
      await assertFails(save("admin1", settings, { audit: { by: "op1" } }));
      await assertFails(save("admin1", settings, { audit: { at: Timestamp.fromMillis(0) } }));
    });

    it("records what the document really was before, and what it became", async () => {
      await assertSucceeds(save("admin1", settings));
      await assertFails(save("admin1", { ...settings, environment: "staging" }, { before: null }));
      await assertFails(save("admin1", { ...settings, environment: "staging" }, { before: { version: 1 } }));
      await assertFails(
        save("admin1", { ...settings, environment: "staging" }, { audit: { after: { version: 1 } } })
      );
      await assertFails(save("admin1", settings, { audit: { revision: 7 } }));
    });

    it("is immutable: not even an admin edits or removes it", async () => {
      await assertSucceeds(save("admin1", settings, { auditId: "audit-immutable" }));
      await assertFails(updateDoc(doc(as("admin1"), auditPath("audit-immutable")), { by: "someone" }));
      await assertFails(deleteDoc(doc(as("admin1"), auditPath("audit-immutable"))));
    });
  });

  describe("the settings schema", () => {
    const rejected: [string, Doc][] = [
      ["a credential-shaped key: secrets don't live here", { slackToken: "xoxb-not-a-real-token" }],
      ["an unknown key", { lookbackHours: 24 }],
      ["another schema version", { version: 2 }],
      ["a project id that isn't one", { watchedProjectId: "Not A Project" }],
      ["an environment with a newline", { environment: "prod\nNOT severity" }],
      ["an empty resource type list", { logResourceTypes: [] }],
      ["more than 20 resource types", { logResourceTypes: Array(21).fill("cloud_function") }],
      ["a resource type list that isn't a list", { logResourceTypes: "cloud_function" }],
      ["more than 100 noise fragments", { ignoredMessages: Array(101).fill("x") }],
      ["a pattern table that isn't a map", { servicePatterns: ["x"] }],
      ["someone else's name on the change", { updatedBy: "op1" }],
      ["a backdated change", { updatedAt: Timestamp.fromMillis(0) }],
      ["a revision that isn't an integer", { revision: 1.5 }],
      ["an audit id too short to be unique", { auditId: "a" }],
    ];
    it.each(rejected)("rejects %s", async (_name, bad) => {
      // The helper mirrors the document into its audit entry, so only the schema can be what fails.
      await assertFails(save("admin1", settings, { current: bad }));
    });

    it("accepts the whole settings document", async () => {
      await assertSucceeds(
        save("admin1", {
          ...settings,
          servicePatterns: { billing: "payments" },
          ignoredMessages: ["probe"],
        })
      );
    });

    it("a document the rules accept is one the engine accepts", async () => {
      await assertSucceeds(
        save("admin1", { ...settings, servicePatterns: { billing: "payments" }, ignoredMessages: ["probe"] })
      );
      expect(validateSettings(await stored())).toMatchObject({
        ok: true,
        settings: { watchedProjectId: "watched-app-1", environment: "prod", ignoredMessages: ["probe"] },
      });
    });
  });

  describe("who may read", () => {
    beforeEach(async () => {
      await save("admin1", settings, { auditId: "audit-readable" });
      await env.withSecurityRulesDisabled((ctx) =>
        setDoc(doc(ctx.firestore(), "starfish_settings/last_good"), { version: 1, environment: "prod" })
      );
    });

    it("admins read the settings and the audit trail", async () => {
      await assertSucceeds(getDoc(doc(as("admin1"), CURRENT)));
      await assertSucceeds(getDoc(doc(as("admin1"), auditPath("audit-readable"))));
    });

    it("operators read only the operator copy", async () => {
      await assertSucceeds(getDoc(doc(as("op1"), PUBLIC)));
      await assertFails(getDoc(doc(as("op1"), CURRENT)));
      await assertFails(getDoc(doc(as("op1"), auditPath("audit-readable"))));
    });

    it("users without a role and anonymous visitors read nothing", async () => {
      for (const db of [as("nobody"), as("stranger"), anon()]) {
        await assertFails(getDoc(doc(db, CURRENT)));
        await assertFails(getDoc(doc(db, PUBLIC)));
        await assertFails(getDoc(doc(db, auditPath("audit-readable"))));
      }
    });

    it("the engine's last-good copy is closed to every client, admins included", async () => {
      const lastGood = "starfish_settings/last_good";
      await assertFails(getDoc(doc(as("admin1"), lastGood)));
      await assertFails(setDoc(doc(as("admin1"), lastGood), { version: 1 }));
      await assertFails(deleteDoc(doc(as("admin1"), lastGood)));
    });

    it("nobody deletes the settings from a client", async () => {
      await assertFails(deleteDoc(doc(as("admin1"), CURRENT)));
      await assertFails(deleteDoc(doc(as("admin1"), PUBLIC)));
    });
  });

  // The tests above write with a helper built to be broken one rule at a time. This
  // block runs the Settings editor's OWN save (web/src/lib/settingsWrite.ts), so what
  // the rules are proven to accept is what the UI actually sends.
  describe("the Settings editor's own save", () => {
    const cols = settingsCollections("starfish_settings");
    const adminReads = async () => (await getDoc(doc(as("admin1"), CURRENT))).data() ?? null;

    it("is accepted: first save, a second one, and a reset, each the next revision of what the admin read", async () => {
      await assertSucceeds(saveSettings(as("admin1"), cols, "admin1", settings, await adminReads()));
      await assertSucceeds(
        saveSettings(as("admin1"), cols, "admin1", { ...settings, ignoredMessages: [] }, await adminReads())
      );
      await assertSucceeds(saveSettings(as("admin1"), cols, "admin1", {}, await adminReads()));
      expect(await stored()).toMatchObject({ revision: 3 });
      expect(await stored()).not.toHaveProperty("environment");
    });

    it("is accepted over a document made from the console, which has no revision", async () => {
      await env.withSecurityRulesDisabled((ctx) =>
        setDoc(doc(ctx.firestore(), CURRENT), { version: 1, environment: "console-made" })
      );
      await assertSucceeds(saveSettings(as("admin1"), cols, "admin1", settings, await adminReads()));
      expect(await stored()).toMatchObject({ revision: 1, environment: "prod" });
    });

    it("writes a document the engine accepts, the operator copy operators read, and an audit entry the editor can list", async () => {
      await assertSucceeds(
        saveSettings(as("admin1"), cols, "admin1", { ...settings, servicePatterns: { billing: "payments" } }, null)
      );
      expect(validateSettings(await stored())).toMatchObject({ ok: true, settings: { environment: "prod" } });
      const copy = await getDoc(doc(as("op1"), PUBLIC));
      expect(copy.data()).toMatchObject({ environment: "prod", watchedProjectId: "watched-app-1", revision: 1 });
      expect(copy.data()).not.toHaveProperty("servicePatterns");

      await assertSucceeds(
        saveSettings(as("admin1"), cols, "admin1", { environment: "staging" }, await adminReads())
      );
      const changes = await readRecentChanges(as("admin1"), cols);
      expect(changes.map((c) => [c.revision, c.by, c.changed])).toEqual([
        [2, "admin1", ["environment", "logResourceTypes", "servicePatterns", "watchedProjectId"]],
        [1, "admin1", ["environment", "logResourceTypes", "servicePatterns", "watchedProjectId"]],
      ]);
    });

    it("is refused for a stale tab, an operator and a user without a role", async () => {
      const first = await adminReads(); // null: nothing saved yet
      await assertSucceeds(saveSettings(as("admin1"), cols, "admin1", settings, first));
      const tabOpenedBeforeThatSave = first;
      await assertFails(saveSettings(as("admin1"), cols, "admin1", { environment: "x" }, tabOpenedBeforeThatSave));
      await assertFails(saveSettings(as("op1"), cols, "op1", settings, await adminReads()));
      await assertFails(saveSettings(as("nobody"), cols, "nobody", settings, null));
    });

    it("an admin can't put someone else's name on a save", async () => {
      await assertFails(saveSettings(as("admin1"), cols, "op1", settings, null));
    });
  });
});

describe("guests (anonymous sessions)", () => {
  const guest = () =>
    env.authenticatedContext("guest1", { firebase: { sign_in_provider: "anonymous" } }).firestore();
  /** A signed-in email account that holds no Starfish role: NOT a guest. */
  const emailNoRole = () =>
    env.authenticatedContext("nobody", { firebase: { sign_in_provider: "password" } }).firestore();

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "incidents/demo-1"), { environment: "demo", status: "new", functionName: "f", updatedAt: Timestamp.now() });
      await setDoc(doc(db, "incidents/prod-1"), { environment: "prod", status: "new", functionName: "f", updatedAt: Timestamp.now() });
      await setDoc(doc(db, "starfish_settings_public/current"), { version: 1, revision: 1, environment: "demo", updatedAt: Timestamp.now() });
      await setDoc(doc(db, "starfish_settings/current"), { version: 1, revision: 1, environment: "demo" });
      await setDoc(doc(db, "starfish_settings/last_good"), { version: 1, environment: "demo" });
      await setDoc(doc(db, "starfish_settings_audit/a1"), { revision: 1, by: "admin1" });
      await setDoc(doc(db, "incident_keys/k1"), { incidentId: "demo-1" });
    });
  });

  it("reads demo incidents, one by one and by a query that filters on the demo environment", async () => {
    await assertSucceeds(getDoc(doc(guest(), "incidents/demo-1")));
    await assertSucceeds(getDocs(query(collection(guest(), "incidents"), where("environment", "==", "demo"))));
  });

  it("reads nothing outside the demo environment: not a prod incident, not an unfiltered query, not a record with no environment", async () => {
    await assertFails(getDoc(doc(guest(), "incidents/prod-1")));
    await assertFails(getDocs(query(collection(guest(), "incidents"), where("environment", "==", "prod"))));
    await assertFails(getDocs(collection(guest(), "incidents"))); // would include prod-1
    await assertFails(getDoc(doc(guest(), "incidents/i1"))); // i1 has no environment at all
  });

  it("reads the operator copy of the settings, so the UI knows which environment to ask for", async () => {
    await assertSucceeds(getDoc(doc(guest(), "starfish_settings_public/current")));
  });

  it("can't read the settings, the audit trail, the engine's copies, the keys, or anyone's operator record", async () => {
    for (const path of [
      "starfish_settings/current",
      "starfish_settings/last_good",
      "starfish_settings_audit/a1",
      "incident_keys/k1",
      "starfish_users/admin1",
      "starfish_users/op1",
      "config/anything",
    ]) {
      await assertFails(getDoc(doc(guest(), path)));
    }
  });

  it("can't write anything: no triage, no create, no delete, no settings, no operator record", async () => {
    const db = guest();
    await assertFails(
      updateDoc(doc(db, "incidents/demo-1"), {
        status: "acknowledged",
        updatedAt: serverTimestamp(),
        statusChangedBy: "guest1",
      })
    );
    await assertFails(setDoc(doc(db, "incidents/new-one"), { environment: "demo", status: "new" }));
    await assertFails(deleteDoc(doc(db, "incidents/demo-1")));
    await assertFails(setDoc(doc(db, "starfish_settings_public/current"), { version: 1, revision: 2, environment: "x", updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(db, "starfish_settings/current"), { version: 1 }));
    await assertFails(setDoc(doc(db, "starfish_users/guest1"), { roles: ["admin"] }));
  });

  it("is a guest only by being anonymous: a signed-in email account with no role reads nothing", async () => {
    await assertFails(getDoc(doc(emailNoRole(), "incidents/demo-1")));
    await assertFails(getDoc(doc(emailNoRole(), "starfish_settings_public/current")));
  });

  it("leaves operators and admins exactly as they were", async () => {
    await assertSucceeds(getDoc(doc(as("op1"), "incidents/prod-1")));
    await assertSucceeds(getDoc(doc(as("op1"), "incidents/demo-1")));
    await assertFails(getDoc(doc(as("op1"), "starfish_settings/current")));
    await assertSucceeds(getDoc(doc(as("admin1"), "starfish_settings/current")));
  });

  it("an unauthenticated visitor still reads nothing", async () => {
    await assertFails(getDoc(doc(anon(), "incidents/demo-1")));
    await assertFails(getDoc(doc(anon(), "starfish_settings_public/current")));
  });
});

describe("ingest run records", () => {
  const guest = () =>
    env.authenticatedContext("guest1", { firebase: { sign_in_provider: "anonymous" } }).firestore();

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "starfish_runs/last_run"), { environment: "demo", outcome: "ok", windows: 1 });
      await setDoc(doc(db, "starfish_runs/state"), { target: { environment: "demo" }, checkpoint: Timestamp.now() });
    });
  });

  it("operators and admins read the last run", async () => {
    await assertSucceeds(getDoc(doc(as("op1"), "starfish_runs/last_run")));
    await assertSucceeds(getDoc(doc(as("admin1"), "starfish_runs/last_run")));
  });

  it("a guest reads the last run of the demo environment, and no other", async () => {
    await assertSucceeds(getDoc(doc(guest(), "starfish_runs/last_run")));
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "starfish_runs/last_run"), { environment: "prod", outcome: "ok" })
    );
    await assertFails(getDoc(doc(guest(), "starfish_runs/last_run")));
  });

  it("nobody else reads it: not an unauthenticated visitor, not a signed-in account with no role", async () => {
    await assertFails(getDoc(doc(anon(), "starfish_runs/last_run")));
    await assertFails(getDoc(doc(as("nobody"), "starfish_runs/last_run")));
  });

  it("the checkpoint is the engine's alone: no client reads or writes it, an admin included", async () => {
    for (const db of [as("admin1"), as("op1"), guest(), anon()]) {
      await assertFails(getDoc(doc(db, "starfish_runs/state")));
      await assertFails(setDoc(doc(db, "starfish_runs/state"), { checkpoint: Timestamp.now() }));
    }
  });

  it("no client writes the last run, an admin included", async () => {
    for (const db of [as("admin1"), as("op1"), guest()]) {
      await assertFails(setDoc(doc(db, "starfish_runs/last_run"), { environment: "demo", outcome: "ok" }));
      await assertFails(updateDoc(doc(db, "starfish_runs/last_run"), { outcome: "failed" }));
      await assertFails(deleteDoc(doc(db, "starfish_runs/last_run")));
    }
  });
});

describe("agent cycles and their run events", () => {
  const guest = () =>
    env.authenticatedContext("guest1", { firebase: { sign_in_provider: "anonymous" } }).firestore();
  const CYCLE = "starfish_cycles/inc1_r0";
  const EVENT = `${CYCLE}/events/000001`;

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, CYCLE), { incidentId: "inc1", environment: "demo", state: "running", owner: "worker-a" });
      await setDoc(doc(db, EVENT), { seq: 1, environment: "demo", stage: "triage", type: "decision", summary: "declined" });
      await setDoc(doc(db, "starfish_cycles/inc2_r0"), { incidentId: "inc2", environment: "prod", state: "running" });
      await setDoc(doc(db, "starfish_cycles/inc2_r0/events/000001"), { seq: 1, environment: "prod", summary: "x" });
    });
  });

  it("operators and admins read cycles and their events", async () => {
    for (const uid of ["op1", "admin1"]) {
      await assertSucceeds(getDoc(doc(as(uid), CYCLE)));
      await assertSucceeds(getDoc(doc(as(uid), EVENT)));
      await assertSucceeds(getDoc(doc(as(uid), "starfish_cycles/inc2_r0")));
    }
  });

  it("a guest reads the demo environment's cycles and events, and no other", async () => {
    await assertSucceeds(getDoc(doc(guest(), CYCLE)));
    await assertSucceeds(getDoc(doc(guest(), EVENT)));
    await assertSucceeds(getDocs(query(collection(guest(), `${CYCLE}/events`), where("environment", "==", "demo"))));
    await assertFails(getDoc(doc(guest(), "starfish_cycles/inc2_r0")));
    await assertFails(getDoc(doc(guest(), "starfish_cycles/inc2_r0/events/000001")));
    await assertFails(getDocs(collection(guest(), "starfish_cycles")));
  });

  it("nobody else reads them: not an unauthenticated visitor, not an account with no role", async () => {
    for (const db of [anon(), as("nobody")]) {
      await assertFails(getDoc(doc(db, CYCLE)));
      await assertFails(getDoc(doc(db, EVENT)));
    }
  });

  it("no client writes a cycle, its lease or its events, an admin included", async () => {
    for (const db of [as("admin1"), as("op1"), guest(), anon()]) {
      await assertFails(setDoc(doc(db, CYCLE), { state: "done" }));
      await assertFails(updateDoc(doc(db, CYCLE), { owner: "me", leaseExpiresAt: Timestamp.now() }));
      await assertFails(deleteDoc(doc(db, CYCLE)));
      await assertFails(setDoc(doc(db, `${CYCLE}/events/000002`), { seq: 2, environment: "demo" }));
      await assertFails(updateDoc(doc(db, EVENT), { summary: "rewritten" }));
      await assertFails(deleteDoc(doc(db, EVENT)));
    }
  });
});

