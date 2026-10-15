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
  collectionGroup,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  Timestamp,
} from "firebase/firestore";
import { validateSettings } from "../src/runtimeSettings.js";
import { readPublicSettings, readRecentChanges, saveSettings, settingsCollections } from "../web/src/lib/settingsWrite";
import { addPerson, readOnCall, removePerson, savePolicy, updatePerson } from "../web/src/lib/onCallWrite";
import { readCorrections, saveCorrection } from "../web/src/lib/correctionWrite";
import { DEFAULT_POLICY } from "../src/oncallSchema.js";

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
    await seedStatus("logged"); // the agent filed its issue; a person still takes it
    await assertSucceeds(triage("op1", { status: "acknowledged" }));
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

  it("can't change the status of a retired incident: retiring closes it for good", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "incidents/i1"), { functionName: "mailDrainer", status: "resolved", retired: true, updatedAt: Timestamp.now() })
    );
    await assertFails(triage("op1", { status: "ignored", resolvedAt: deleteField() }));
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "incidents/i1"), { functionName: "mailDrainer", status: "new", retired: true, updatedAt: Timestamp.now() })
    );
    await assertFails(triage("op1"));
    await assertFails(triage("admin1"));
    // retired: false is an ordinary incident.
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "incidents/i1"), { functionName: "mailDrainer", status: "new", retired: false, updatedAt: Timestamp.now() })
    );
    await assertSucceeds(triage("op1"));
  });

  it("a user without a role can't triage", async () => {
    await assertFails(triage("nobody"));
  });

  it("nobody creates or deletes incidents from the client", async () => {
    await assertFails(setDoc(doc(as("admin1"), "incidents/new"), { status: "new" }));
    await assertFails(deleteDoc(doc(as("admin1"), "incidents/i1")));
  });
});

describe("incidents: retriage requests (#8)", () => {
  const retriage = (db: ReturnType<typeof as>, uid: string, extra: Record<string, unknown> = {}) =>
    updateDoc(doc(db, "incidents/i1"), { retriageRequestedAt: serverTimestamp(), retriageRequestedBy: uid, ...extra });

  it("an operator or an admin asks for a retriage of an open incident, naming themselves, at the server's time", async () => {
    await assertSucceeds(retriage(as("op1"), "op1"));
    await assertSucceeds(retriage(as("admin1"), "admin1"));
    for (const status of ["acknowledged", "logged", "recurred"]) {
      await seedStatus(status);
      await assertSucceeds(retriage(as("op1"), "op1"));
    }
  });

  it("never on a closed incident: a request cannot reopen what an operator resolved or ignored", async () => {
    for (const status of ["resolved", "ignored"]) {
      await seedStatus(status);
      await assertFails(retriage(as("op1"), "op1"));
    }
  });

  it("never on a retired incident", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "incidents/i1"), { functionName: "mailDrainer", status: "new", retired: true, updatedAt: Timestamp.now() })
    );
    await assertFails(retriage(as("op1"), "op1"));
  });

  it("can't backdate or forward-date the request, or attribute it to someone else", async () => {
    await assertFails(retriage(as("op1"), "op1", { retriageRequestedAt: Timestamp.fromMillis(0) }));
    await assertFails(retriage(as("op1"), "op1", { retriageRequestedAt: Timestamp.fromMillis(Date.now() + 3_600_000) }));
    await assertFails(retriage(as("op1"), "admin1"));
    await assertFails(updateDoc(doc(as("op1"), "incidents/i1"), { retriageRequestedAt: serverTimestamp() })); // nobody named
  });

  it("carries nothing else: no status, no evidence, no engine field", async () => {
    await assertFails(retriage(as("op1"), "op1", { status: "acknowledged", updatedAt: serverTimestamp(), statusChangedBy: "op1" }));
    await assertFails(retriage(as("op1"), "op1", { occurrenceCount: 0 }));
    await assertFails(retriage(as("op1"), "op1", { updatedAt: serverTimestamp() }));
    await assertFails(retriage(as("op1"), "op1", { triageState: "pending" }));
  });

  it("guests, role-less users and strangers can't ask", async () => {
    await assertFails(retriage(as("nobody"), "nobody"));
    await assertFails(retriage(as("stranger"), "stranger"));
    await assertFails(retriage(env.authenticatedContext("guest1", { firebase: { sign_in_provider: "anonymous" } }).firestore(), "guest1"));
    await assertFails(retriage(anon(), "x"));
  });
});

describe("incidents: corrections (the feedback engine, src/triageRules.ts)", () => {
  const correct = (uid: string, level: "noise" | "log" | "fix" | "merge" = "log", note = "") => saveCorrection(as(uid), "incidents", "i1", uid, level, note);
  /** A hand-made batch, to try what the page's write never sends. */
  const batch = async (uid: string, incident: Record<string, unknown>, entry: Record<string, unknown> | null, id = "corr-0001") => {
    const db = as(uid);
    const b = writeBatch(db);
    b.update(doc(db, "incidents/i1"), { correctedLevel: "log", correctedBy: uid, correctedAt: serverTimestamp(), correctionId: id, ...incident });
    if (entry) b.set(doc(db, `incidents/i1/corrections/${id}`), { level: "log", by: uid, at: serverTimestamp(), ...entry });
    await b.commit();
  };

  it("an operator or an admin corrects an incident, with its history entry, and both read it back", async () => {
    await assertSucceeds(correct("op1", "log", "a person fixes payments"));
    await assertSucceeds(correct("admin1", "noise"));
    const stored = (await getDoc(doc(as("op1"), "incidents/i1"))).data()!;
    expect(stored).toMatchObject({ correctedLevel: "noise", correctedBy: "admin1" });
    expect(stored.correctionNote).toBeUndefined(); // the earlier note went with the earlier correction
    const history = await readCorrections(as("op1"), "incidents", "i1");
    expect(history.map((h) => [h.level, h.by, h.note])).toEqual([
      ["noise", "admin1", undefined],
      ["log", "op1", "a person fixes payments"],
    ]);
  });

  it("whatever the status, but never on a retired incident", async () => {
    for (const status of ["resolved", "ignored"]) {
      await seedStatus(status);
      await assertSucceeds(correct("op1", "fix"));
    }
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "incidents/i1"), { functionName: "mailDrainer", status: "new", retired: true, updatedAt: Timestamp.now() })
    );
    await assertFails(correct("op1"));
  });

  it("never without its history entry, nor with one that disagrees or already exists", async () => {
    await assertFails(batch("op1", {}, null));
    await assertFails(batch("op1", {}, { level: "fix" }));
    await assertFails(batch("op1", { correctionNote: "a" }, { note: "b" }));
    await assertFails(batch("op1", {}, { by: "admin1" }));
    await assertSucceeds(batch("op1", {}, {}));
    await assertFails(batch("op1", {}, {})); // the same entry id again: history can't be rewritten
  });

  it("can't name someone else, a level that isn't one, a backdated time, or carry anything else", async () => {
    await assertFails(batch("op1", { correctedBy: "admin1" }, {}, "corr-0002"));
    await assertFails(batch("op1", { correctedLevel: "page" }, { level: "page" }, "corr-0003"));
    await assertFails(batch("op1", { correctedAt: Timestamp.fromMillis(0) }, {}, "corr-0004"));
    await assertFails(batch("op1", { status: "resolved" }, {}, "corr-0005"));
    await assertFails(batch("op1", { triageState: "x" }, {}, "corr-0006"));
    await assertFails(batch("op1", { correctionNote: "n".repeat(301) }, { note: "n".repeat(301) }, "corr-0007"));
  });

  it("history entries are immutable", async () => {
    await assertSucceeds(batch("op1", {}, {}));
    await assertFails(updateDoc(doc(as("op1"), "incidents/i1/corrections/corr-0001"), { level: "noise" }));
    await assertFails(deleteDoc(doc(as("admin1"), "incidents/i1/corrections/corr-0001")));
  });

  it("guests, role-less users and strangers can't correct or read the history", async () => {
    await assertSucceeds(batch("op1", {}, {}));
    for (const uid of ["nobody", "stranger"]) {
      await assertFails(correct(uid));
      await assertFails(getDoc(doc(as(uid), "incidents/i1/corrections/corr-0001")));
    }
    const guest = env.authenticatedContext("guest1", { firebase: { sign_in_provider: "anonymous" } }).firestore();
    await assertFails(saveCorrection(guest, "incidents", "i1", "guest1", "log", ""));
    await assertFails(getDoc(doc(guest, "incidents/i1/corrections/corr-0001")));
    await assertFails(getDoc(doc(anon(), "incidents/i1/corrections/corr-0001")));
  });

  it("the page refuses a note that is too long or spans lines before writing", async () => {
    await expect(correct("op1", "log", "n".repeat(301))).rejects.toThrow("at most 300");
    await expect(correct("op1", "log", "two\nlines")).rejects.toThrow("one line");
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
    /** Write the operator copy without its `settings` (as a build from before it carried them would). */
    publicWithoutSettings?: boolean;
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
        ...(!o.publicWithoutSettings && { settings: settingsOf(written) }),
        ...o.publicDoc,
      });
    }
    return batch.commit();
  }

  /** The settings fields of a written document: what the operator copy carries for the read-only view. */
  const BOOKKEEPING = ["version", "revision", "auditId", "updatedAt", "updatedBy"];
  const settingsOf = (d: Doc): Doc => Object.fromEntries(Object.entries(d).filter(([k]) => !BOOKKEEPING.includes(k)));

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

    it("the operator copy's settings are exactly the saved settings: none added, left out, changed, or bookkeeping", async () => {
      const full = { ...settings, dryRun: false, ignoredMessages: ["noise"], servicePatterns: { billing: "payments" } };
      await assertFails(save("admin1", full, { publicWithoutSettings: true }));
      await assertFails(save("admin1", full, { publicDoc: { settings: "everything" } }));
      await assertFails(save("admin1", full, { publicDoc: { settings: { ...full, dryRun: true } } }));
      await assertFails(save("admin1", full, { publicDoc: { settings: { ...full, ignoredMessages: [] } } }));
      await assertFails(save("admin1", full, { publicDoc: { settings: { ...full, servicePatterns: { billing: "x" } } } }));
      await assertFails(save("admin1", full, { publicDoc: { settings: { ...full, autoMerge: true } } }));
      await assertFails(save("admin1", full, { publicDoc: { settings: { ...settings, ignoredMessages: ["noise"], servicePatterns: { billing: "payments" } } } }));
      await assertFails(save("admin1", full, { publicDoc: { settings: { ...full, updatedBy: "admin1" } } }));
      await assertFails(save("admin1", full, { publicDoc: { settings: { ...full, githubToken: "ghp_x" } } }));
      await assertSucceeds(save("admin1", full));
      // A reset: the copy's settings are empty, like the document's.
      await assertFails(save("admin1", {}, { publicDoc: { settings: full } }));
      await assertSucceeds(save("admin1", {}));
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
      ["a dry run switch that isn't a boolean", { dryRun: "false" }],
      ["a review switch that isn't a boolean", { reviewRequired: 0 }],
      ["a kill switch that isn't a boolean", { automationEnabled: "off" }],
      ["an auto-merge switch that isn't a boolean", { autoMerge: "true" }],
      ["a merge freeze that isn't a boolean", { mergeFreeze: 1 }],
      ["a merge target list, which only the environment may set", { autoMergeTargets: ["acme/prod"] }],
      ["merge cases that aren't a list", { mergeCases: { id: "missing-index", description: "d" } }],
      ["more than 20 merge cases", { mergeCases: Array.from({ length: 21 }, (_, i) => ({ id: `case-${i}`, description: "d" })) }],
      ["a model call budget of zero", { modelCallBudget: 0 }],
      ["a model call budget above fifty", { modelCallBudget: 51 }],
      ["a fractional model call budget", { modelCallBudget: 2.5 }],
      ["a model call budget that is a string", { modelCallBudget: "6" }],
      ["a model id with capitals", { model: "Gemini-Pro" }],
      ["a model id that is a resource path", { model: "publishers/google/models/gemini" }],
      ["a model id longer than 64 characters", { model: "g".repeat(65) }],
      ["a model id that isn't a string", { model: 3 }],
      ["a region that isn't a GCP region", { location: "us-central1.evil.example" }],
      ["a region with no number", { location: "us-central" }],
      ["a region that isn't a string", { location: true }],
      ["a Vertex project that isn't a project id", { vertexProjectId: "Vertex-Home" }],
      ["a Vertex project that is a resource path", { vertexProjectId: "projects/vertex-project" }],
      ["a Vertex project that isn't a string", { vertexProjectId: 7 }],
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

    it("accepts the pipeline switches at their bounds, and the engine agrees", async () => {
      await assertSucceeds(save("admin1", { ...settings, dryRun: false, reviewRequired: false, automationEnabled: false, modelCallBudget: 50 }));
      expect(validateSettings(await stored())).toMatchObject({
        ok: true,
        settings: { dryRun: false, reviewRequired: false, automationEnabled: false, modelCallBudget: 50 },
      });
      await assertSucceeds(save("admin1", { ...settings, dryRun: true, modelCallBudget: 1 }));
    });

    it("accepts the merge switches, and the engine agrees (#9)", async () => {
      await assertSucceeds(save("admin1", { ...settings, autoMerge: true, mergeFreeze: false }));
      expect(validateSettings(await stored())).toMatchObject({ ok: true, settings: { autoMerge: true, mergeFreeze: false } });
    });

    it("accepts the admin's merge cases, and the engine agrees", async () => {
      const mergeCases = [{ id: "missing-index", description: "a Firestore query fails because a composite index is missing" }];
      await assertSucceeds(save("admin1", { ...settings, mergeCases }));
      expect(validateSettings(await stored())).toMatchObject({ ok: true, settings: { mergeCases } });
      await assertSucceeds(save("admin1", { ...settings, mergeCases: [] }));
    });

    it("accepts a model and region, and the engine agrees (#7)", async () => {
      await assertSucceeds(save("admin1", { ...settings, model: "gemini-3.1-pro-preview", location: "europe-west4" }));
      expect(validateSettings(await stored())).toMatchObject({
        ok: true,
        settings: { model: "gemini-3.1-pro-preview", location: "europe-west4" },
      });
      await assertSucceeds(save("admin1", { ...settings, model: "g", location: "global" }));
      expect(validateSettings(await stored())).toMatchObject({ ok: true, settings: { model: "g", location: "global" } });
    });

    it("accepts a Vertex project, and the engine agrees (#7)", async () => {
      await assertSucceeds(save("admin1", { ...settings, vertexProjectId: "vertex-project" }));
      expect(validateSettings(await stored())).toMatchObject({ ok: true, settings: { vertexProjectId: "vertex-project" } });
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
    const guest = () => env.authenticatedContext("guest1", { firebase: { sign_in_provider: "anonymous" } }).firestore();
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
      // The read-only view's copy: the settings as saved, never who saved them.
      expect(copy.get("settings")).toEqual({ ...settings, servicePatterns: { billing: "payments" } });
      expect(copy.get("settings")).not.toHaveProperty("updatedBy");
      expect(copy.data()).not.toHaveProperty("updatedBy");
      const asGuest = await readPublicSettings(guest(), cols);
      expect(asGuest?.settings).toEqual({ ...settings, servicePatterns: { billing: "payments" } });

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
      // The trimmed copy guests read (src/publicView.ts, #18). A copy of a prod incident is never written; one is
      // planted here to prove the rules would not serve it anyway.
      await setDoc(doc(db, "starfish_public_incidents/demo-1"), { publicView: 1, environment: "demo", status: "new", functionName: "f", lastOccurredAt: Timestamp.now() });
      await setDoc(doc(db, "starfish_public_incidents/prod-1"), { publicView: 1, environment: "prod", status: "new", functionName: "f", lastOccurredAt: Timestamp.now() });
      await setDoc(doc(db, "starfish_settings_public/current"), { version: 1, revision: 1, environment: "demo", updatedAt: Timestamp.now() });
      await setDoc(doc(db, "starfish_settings/current"), { version: 1, revision: 1, environment: "demo" });
      await setDoc(doc(db, "starfish_settings/last_good"), { version: 1, environment: "demo" });
      await setDoc(doc(db, "starfish_settings_audit/a1"), { revision: 1, by: "admin1" });
      await setDoc(doc(db, "incident_keys/k1"), { incidentId: "demo-1" });
    });
  });

  it("never reads a stored incident, not even a demo one: only its trimmed copy (#18)", async () => {
    await assertFails(getDoc(doc(guest(), "incidents/demo-1")));
    await assertFails(getDocs(query(collection(guest(), "incidents"), where("environment", "==", "demo"))));
    await assertFails(getDoc(doc(guest(), "incidents/no-such-incident")));
    await assertFails(getDoc(doc(guest(), "incidents/prod-1")));
    await assertFails(getDocs(collection(guest(), "incidents")));
  });

  it("reads the demo's incident copies, one by one and by the Incidents page's own query", async () => {
    await assertSucceeds(getDoc(doc(guest(), "starfish_public_incidents/demo-1")));
    const listed = await assertSucceeds(
      getDocs(query(collection(guest(), "starfish_public_incidents"), where("environment", "==", "demo"), where("lastOccurredAt", ">=", Timestamp.fromMillis(0)), orderBy("lastOccurredAt", "desc"), limit(200)))
    );
    expect(listed.docs.map((d) => d.id)).toEqual(["demo-1"]);
  });

  it("reads no copy outside the demo environment: not a prod one, not an unfiltered query", async () => {
    await assertFails(getDoc(doc(guest(), "starfish_public_incidents/prod-1")));
    await assertFails(getDocs(query(collection(guest(), "starfish_public_incidents"), where("environment", "==", "prod"))));
    await assertFails(getDocs(collection(guest(), "starfish_public_incidents"))); // would include prod-1
  });

  it("gets an incident copy that doesn't exist as missing, not as a refusal (#142)", async () => {
    const snap = await assertSucceeds(getDoc(doc(guest(), "starfish_public_incidents/no-such-incident")));
    expect(snap.exists()).toBe(false);
    // Still nothing for a visitor with no session or an account with no role.
    await assertFails(getDoc(doc(anon(), "starfish_public_incidents/no-such-incident")));
    await assertFails(getDoc(doc(emailNoRole(), "starfish_public_incidents/no-such-incident")));
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

  it("nobody writes a trimmed copy from a client, an admin included: only the engine does", async () => {
    for (const db of [guest(), as("op1"), as("admin1"), anon()]) {
      await assertFails(setDoc(doc(db, "starfish_public_incidents/demo-2"), { environment: "demo", status: "new" }));
      await assertFails(updateDoc(doc(db, "starfish_public_incidents/demo-1"), { errorMessage: "rewritten" }));
      await assertFails(deleteDoc(doc(db, "starfish_public_incidents/demo-1")));
    }
  });

  it("is a guest only by being anonymous: a signed-in email account with no role reads nothing", async () => {
    await assertFails(getDoc(doc(emailNoRole(), "incidents/demo-1")));
    await assertFails(getDoc(doc(emailNoRole(), "starfish_public_incidents/demo-1")));
    await assertFails(getDoc(doc(emailNoRole(), "starfish_settings_public/current")));
  });

  it("leaves operators and admins exactly as they were: they read the stored incidents of every environment", async () => {
    for (const uid of ["op1", "admin1"]) {
      await assertSucceeds(getDoc(doc(as(uid), "incidents/prod-1")));
      await assertSucceeds(getDoc(doc(as(uid), "incidents/demo-1")));
      await assertSucceeds(getDocs(query(collection(as(uid), "incidents"), where("environment", "==", "demo"))));
      // The copies too: no harm, and an operator may compare.
      await assertSucceeds(getDoc(doc(as(uid), "starfish_public_incidents/demo-1")));
    }
    await assertFails(getDoc(doc(as("op1"), "starfish_settings/current")));
    await assertSucceeds(getDoc(doc(as("admin1"), "starfish_settings/current")));
  });

  it("an unauthenticated visitor still reads nothing", async () => {
    await assertFails(getDoc(doc(anon(), "incidents/demo-1")));
    await assertFails(getDoc(doc(anon(), "starfish_public_incidents/demo-1")));
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

  it("the integrations record reads like the last run: operators, and a guest on the demo only; nobody writes it", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "starfish_runs/integrations"), { environment: "demo", github: true })
    );
    await assertSucceeds(getDoc(doc(as("op1"), "starfish_runs/integrations")));
    await assertSucceeds(getDoc(doc(guest(), "starfish_runs/integrations")));
    await assertFails(getDoc(doc(anon(), "starfish_runs/integrations")));
    await assertFails(getDoc(doc(as("nobody"), "starfish_runs/integrations")));
    await assertFails(setDoc(doc(as("admin1"), "starfish_runs/integrations"), { environment: "demo", github: false }));
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "starfish_runs/integrations"), { environment: "prod", github: true })
    );
    await assertFails(getDoc(doc(guest(), "starfish_runs/integrations")));
  });

  it("the agent's last pass reads like the last run: operators, and a guest on the demo only; nobody writes it (#274)", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "starfish_runs/agent_last_run"), { environment: "demo", outcome: "ok", considered: 1 })
    );
    await assertSucceeds(getDoc(doc(as("op1"), "starfish_runs/agent_last_run")));
    await assertSucceeds(getDoc(doc(as("admin1"), "starfish_runs/agent_last_run")));
    await assertSucceeds(getDoc(doc(guest(), "starfish_runs/agent_last_run")));
    await assertFails(getDoc(doc(anon(), "starfish_runs/agent_last_run")));
    await assertFails(getDoc(doc(as("nobody"), "starfish_runs/agent_last_run")));
    for (const db of [as("admin1"), as("op1"), guest()]) {
      await assertFails(setDoc(doc(db, "starfish_runs/agent_last_run"), { environment: "demo", outcome: "ok" }));
      await assertFails(updateDoc(doc(db, "starfish_runs/agent_last_run"), { outcome: "failed" }));
      await assertFails(deleteDoc(doc(db, "starfish_runs/agent_last_run")));
    }
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "starfish_runs/agent_last_run"), { environment: "prod", outcome: "ok" })
    );
    await assertFails(getDoc(doc(guest(), "starfish_runs/agent_last_run")));
    // Never recorded: a guest is told it is missing, not refused (#142).
    await env.withSecurityRulesDisabled((ctx) => deleteDoc(doc(ctx.firestore(), "starfish_runs/agent_last_run")));
    const snap = await assertSucceeds(getDoc(doc(guest(), "starfish_runs/agent_last_run")));
    expect(snap.exists()).toBe(false);
    await assertFails(getDoc(doc(anon(), "starfish_runs/agent_last_run")));
  });

  it("a guest reads a last run that was never recorded as missing, not as a refusal (#142)", async () => {
    await env.withSecurityRulesDisabled((ctx) => deleteDoc(doc(ctx.firestore(), "starfish_runs/last_run")));
    const snap = await assertSucceeds(getDoc(doc(guest(), "starfish_runs/last_run")));
    expect(snap.exists()).toBe(false);
    await assertFails(getDoc(doc(anon(), "starfish_runs/last_run")));
    await assertFails(getDoc(doc(as("nobody"), "starfish_runs/last_run")));
    // The checkpoint stays closed whether or not it exists.
    await env.withSecurityRulesDisabled((ctx) => deleteDoc(doc(ctx.firestore(), "starfish_runs/state")));
    await assertFails(getDoc(doc(guest(), "starfish_runs/state")));
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
  const PUB_CYCLE = "starfish_public_cycles/inc1_r0";
  const PUB_EVENT = "starfish_public_events/inc1_r0_000001";

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, CYCLE), { incidentId: "inc1", environment: "demo", state: "running", owner: "worker-a", updatedAt: Timestamp.now() });
      await setDoc(doc(db, EVENT), { seq: 1, environment: "demo", stage: "triage", type: "decision", summary: "declined" });
      await setDoc(doc(db, "starfish_cycles/inc2_r0"), { incidentId: "inc2", environment: "prod", state: "running", updatedAt: Timestamp.now() });
      await setDoc(doc(db, "starfish_cycles/inc2_r0/events/000001"), { seq: 1, environment: "prod", summary: "x" });
      // The trimmed copies guests read (#18); prod ones are planted only to prove the rules would not serve them.
      await setDoc(doc(db, PUB_CYCLE), { publicView: 1, incidentId: "inc1", environment: "demo", state: "running", updatedAt: Timestamp.now() });
      await setDoc(doc(db, PUB_EVENT), { publicView: 1, cycleId: "inc1_r0", seq: 1, environment: "demo", stage: "triage", type: "decision", at: Timestamp.now() });
      await setDoc(doc(db, "starfish_public_cycles/inc2_r0"), { publicView: 1, incidentId: "inc2", environment: "prod", state: "running", updatedAt: Timestamp.now() });
      await setDoc(doc(db, "starfish_public_events/inc2_r0_000001"), { publicView: 1, cycleId: "inc2_r0", seq: 1, environment: "prod", at: Timestamp.now() });
    });
  });

  it("operators and admins read cycles and their events, of every environment, as before", async () => {
    for (const uid of ["op1", "admin1"]) {
      await assertSucceeds(getDoc(doc(as(uid), CYCLE)));
      await assertSucceeds(getDoc(doc(as(uid), EVENT)));
      await assertSucceeds(getDoc(doc(as(uid), "starfish_cycles/inc2_r0")));
      await assertSucceeds(getDocs(query(collection(as(uid), "starfish_cycles"), where("environment", "==", "demo"), orderBy("updatedAt", "desc"), limit(50))));
      await assertSucceeds(getDocs(query(collection(as(uid), `${CYCLE}/events`), where("environment", "==", "demo"))));
      // The Runs page's own read of a run's events: newest first, one more than it draws (EVENT_LIMIT + 1, #326).
      await assertSucceeds(getDocs(query(collection(as(uid), `${CYCLE}/events`), where("environment", "==", "demo"), orderBy("seq", "desc"), limit(201))));
      await assertSucceeds(getDoc(doc(as(uid), PUB_CYCLE)));
      await assertSucceeds(getDoc(doc(as(uid), PUB_EVENT)));
    }
  });

  it("a guest never reads a stored cycle or event, not even a demo one: only their trimmed copies (#18)", async () => {
    await assertFails(getDoc(doc(guest(), CYCLE)));
    await assertFails(getDoc(doc(guest(), EVENT)));
    await assertFails(getDocs(query(collection(guest(), `${CYCLE}/events`), where("environment", "==", "demo"))));
    await assertFails(getDocs(query(collection(guest(), "starfish_cycles"), where("environment", "==", "demo"), orderBy("updatedAt", "desc"), limit(50))));
    await assertFails(getDoc(doc(guest(), "starfish_cycles/never-run_r0")));
    await assertFails(getDoc(doc(guest(), "starfish_cycles/inc2_r0")));
  });

  it("a guest reads the demo environment's cycle and event copies, and no other", async () => {
    await assertSucceeds(getDoc(doc(guest(), PUB_CYCLE)));
    await assertSucceeds(getDoc(doc(guest(), PUB_EVENT)));
    // The Runs page's own queries (web/src/lib/runs.ts): the environment filter is what lets the rules serve them.
    const listed = await assertSucceeds(
      getDocs(query(collection(guest(), "starfish_public_cycles"), where("environment", "==", "demo"), orderBy("updatedAt", "desc"), limit(50)))
    );
    expect(listed.docs.map((d) => d.id)).toEqual(["inc1_r0"]);
    // A run's events: newest first by seq, one more than the page draws (EVENT_LIMIT + 1 in web/src/lib/runs.ts, #326).
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "starfish_public_events/inc1_r0_000002"), { publicView: 1, cycleId: "inc1_r0", seq: 2, environment: "demo", stage: "fix", type: "declined", at: Timestamp.now() });
    });
    const runEvents = (n: number) =>
      query(collection(guest(), "starfish_public_events"), where("cycleId", "==", "inc1_r0"), where("environment", "==", "demo"), orderBy("seq", "desc"), limit(n));
    const events = await assertSucceeds(getDocs(runEvents(201)));
    expect(events.docs.map((d) => d.id)).toEqual(["inc1_r0_000002", "inc1_r0_000001"]);
    // The limit is what keeps the newest: a capped read drops the oldest, not the latest.
    expect((await assertSucceeds(getDocs(runEvents(1)))).docs.map((d) => d.id)).toEqual(["inc1_r0_000002"]);
    await assertFails(
      getDocs(query(collection(guest(), "starfish_public_events"), where("cycleId", "==", "inc1_r0"), where("environment", "==", "demo"), orderBy("seq", "desc")))
    );
    await assertFails(getDoc(doc(guest(), "starfish_public_cycles/inc2_r0")));
    await assertFails(getDoc(doc(guest(), "starfish_public_events/inc2_r0_000001")));
    await assertFails(getDocs(collection(guest(), "starfish_public_cycles")));
    await assertFails(getDocs(collection(guest(), "starfish_public_events")));
    await assertFails(
      getDocs(query(collection(guest(), "starfish_public_cycles"), where("environment", "==", "prod"), orderBy("updatedAt", "desc"), limit(50)))
    );
  });

  it("a guest's query must carry a limit of at most 500 documents: anyone can be a guest, and a query is billed per document", async () => {
    const demo = (name: string) => query(collection(guest(), name), where("environment", "==", "demo"));
    for (const name of ["starfish_public_incidents", "starfish_public_cycles", "starfish_public_events"]) {
      await assertFails(getDocs(demo(name)));
      await assertFails(getDocs(query(demo(name), limit(501))));
      await assertSucceeds(getDocs(query(demo(name), limit(500))));
    }
    // The Runs page's "show more" asks for the most (CYCLE_LIMIT_MAX in web/src/lib/runs.ts).
    await assertSucceeds(getDocs(query(collection(guest(), "starfish_public_cycles"), where("environment", "==", "demo"), orderBy("updatedAt", "desc"), limit(500))));
  });

  it("a guest gets a cycle or event copy that doesn't exist as missing, not as a refusal (#142)", async () => {
    // Every demo incident the agent never reached: the evidence page must say "Not reached".
    const cycle = await assertSucceeds(getDoc(doc(guest(), "starfish_public_cycles/never-run_r0")));
    expect(cycle.exists()).toBe(false);
    const event = await assertSucceeds(getDoc(doc(guest(), "starfish_public_events/inc1_r0_999999")));
    expect(event.exists()).toBe(false);
    // Lists stay constrained: a missing-document allowance is not a way around the environment filter.
    await assertFails(getDocs(collection(guest(), "starfish_public_cycles")));
    await assertFails(getDocs(query(collection(guest(), "starfish_public_events"), where("cycleId", "==", "inc2_r0"))));
    await assertFails(getDocs(query(collection(guest(), "starfish_public_events"), where("environment", "==", "prod"))));
    for (const db of [anon(), as("nobody")]) {
      await assertFails(getDoc(doc(db, "starfish_public_cycles/never-run_r0")));
    }
  });

  it("nobody else reads them: not an unauthenticated visitor, not an account with no role", async () => {
    for (const db of [anon(), as("nobody")]) {
      await assertFails(getDoc(doc(db, CYCLE)));
      await assertFails(getDoc(doc(db, EVENT)));
      await assertFails(getDoc(doc(db, PUB_CYCLE)));
      await assertFails(getDoc(doc(db, PUB_EVENT)));
    }
  });

  // The Overview's activity feed (subscribeLatestEvents in web/src/lib/runs.ts): one collection-group query.
  const feed = (db: ReturnType<typeof guest>, environment?: string) =>
    getDocs(
      environment === undefined
        ? query(collectionGroup(db, "events"), orderBy("at", "desc"), limit(10))
        : query(collectionGroup(db, "events"), where("environment", "==", environment), orderBy("at", "desc"), limit(10))
    );

  it("an operator lists the newest events across cycles", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, EVENT), { seq: 1, environment: "demo", stage: "triage", type: "decision", summary: "declined", at: Timestamp.fromMillis(1000) });
      await setDoc(doc(db, "starfish_cycles/inc3_r0"), { incidentId: "inc3", environment: "demo", state: "done", updatedAt: Timestamp.now() });
      await setDoc(doc(db, "starfish_cycles/inc3_r0/events/000001"), { seq: 1, environment: "demo", stage: "fix", summary: "y", at: Timestamp.fromMillis(2000) });
    });
    for (const uid of ["op1", "admin1"]) {
      const listed = await assertSucceeds(feed(as(uid), "demo"));
      expect(listed.docs.map((d) => d.ref.path)).toEqual(["starfish_cycles/inc3_r0/events/000001", EVENT]);
      await assertSucceeds(feed(as(uid), "prod"));
    }
  });

  it("a guest never lists the stored events across cycles; the guest feed reads the event copies, demo only (#18)", async () => {
    await assertFails(feed(guest(), "demo"));
    await assertFails(feed(guest()));
    await assertFails(feed(guest(), "prod"));
    // The guest feed's own query (subscribeLatestEvents for a guest).
    const listed = await assertSucceeds(
      getDocs(query(collection(guest(), "starfish_public_events"), where("environment", "==", "demo"), orderBy("at", "desc"), limit(10)))
    );
    expect(listed.docs.map((d) => d.id)).toEqual(["inc1_r0_000001"]);
    await assertFails(getDocs(query(collection(guest(), "starfish_public_events"), orderBy("at", "desc"), limit(10))));
  });

  it("nobody else lists the feed: not an unauthenticated visitor, not an account with no role", async () => {
    for (const db of [anon(), as("nobody")]) {
      await assertFails(feed(db, "demo"));
      await assertFails(feed(db));
    }
  });

  it("the feed's rule grants a list, never a single read of an events document outside a cycle", async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "incidents/i1/events/e1"), { environment: "demo", at: Timestamp.now() })
    );
    for (const db of [as("op1"), guest()]) await assertFails(getDoc(doc(db, "incidents/i1/events/e1")));
  });

  it("no client writes a cycle, its lease or its events, an admin included", async () => {
    for (const db of [as("admin1"), as("op1"), guest(), anon()]) {
      await assertFails(setDoc(doc(db, CYCLE), { state: "done" }));
      await assertFails(updateDoc(doc(db, CYCLE), { owner: "me", leaseExpiresAt: Timestamp.now() }));
      await assertFails(deleteDoc(doc(db, CYCLE)));
      await assertFails(setDoc(doc(db, `${CYCLE}/events/000002`), { seq: 2, environment: "demo" }));
      await assertFails(updateDoc(doc(db, EVENT), { summary: "rewritten" }));
      await assertFails(deleteDoc(doc(db, EVENT)));
      // Nor their trimmed copies: only the engine writes those (#18).
      await assertFails(setDoc(doc(db, PUB_CYCLE), { environment: "demo", state: "done" }));
      await assertFails(updateDoc(doc(db, PUB_CYCLE), { state: "done" }));
      await assertFails(deleteDoc(doc(db, PUB_CYCLE)));
      await assertFails(setDoc(doc(db, "starfish_public_events/inc1_r0_000002"), { environment: "demo", seq: 2 }));
      await assertFails(updateDoc(doc(db, PUB_EVENT), { summary: "rewritten" }));
      await assertFails(deleteDoc(doc(db, PUB_EVENT)));
    }
  });
});

describe("the audit trail of admin actions", () => {
  const guest = () =>
    env.authenticatedContext("guest1", { firebase: { sign_in_provider: "anonymous" } }).firestore();

  beforeEach(async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "starfish_audit/e1"), { action: "retire-incident", incidentId: "i1", actorUid: "admin1" })
    );
  });

  it("an admin reads it", async () => {
    await assertSucceeds(getDoc(doc(as("admin1"), "starfish_audit/e1")));
  });

  it("nobody else does: not an operator, an account with no role, a guest, or a visitor", async () => {
    for (const db of [as("op1"), as("nobody"), guest(), anon()]) await assertFails(getDoc(doc(db, "starfish_audit/e1")));
  });

  it("no client writes it, an admin included", async () => {
    for (const db of [as("admin1"), as("op1"), guest(), anon()]) {
      await assertFails(setDoc(doc(db, "starfish_audit/e2"), { action: "x" }));
      await assertFails(updateDoc(doc(db, "starfish_audit/e1"), { actorUid: "someone-else" }));
      await assertFails(deleteDoc(doc(db, "starfish_audit/e1")));
    }
  });

  it("an operator still cannot retire or un-retire an incident through the triage update", async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "incidents/i1"), { functionName: "f", status: "new", updatedAt: Timestamp.now() }));
    await assertFails(updateDoc(doc(as("op1"), "incidents/i1"), { retired: true, status: "resolved", resolvedAt: serverTimestamp(), statusChangedBy: "op1", updatedAt: serverTimestamp() }));
  });
});

describe("the on-call rota (#37): phone numbers are personal data", () => {
  const cols = { policy: "starfish_oncall", people: "starfish_oncall_people" };
  const guest = () => env.authenticatedContext("guest1", { firebase: { sign_in_provider: "anonymous" } }).firestore();
  const PHONE = "+15550000142";
  const seedPerson = (state: string) =>
    env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), "starfish_oncall_people/p1"), { name: "Ada", role: "primary", phone: PHONE, state, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), updatedBy: "admin1" })
    );

  it("an admin adds a person (unconfirmed), reads the rota masked, edits, and removes them, with the editor's own writes", async () => {
    const id = await assertSucceeds(addPerson(as("admin1"), cols, "admin1", { name: "Ada", role: "primary", phone: PHONE }));
    const view = await readOnCall(as("admin1"), cols);
    expect(view.people).toEqual([{ id, name: "Ada", role: "primary", maskedPhone: "+1 ••• ••• ••42", state: "pending" }]);
    expect(JSON.stringify(view)).not.toContain(PHONE);
    await assertSucceeds(updatePerson(as("admin1"), cols, "admin1", id, { name: "Ada L.", role: "secondary" }));
    await assertSucceeds(updatePerson(as("admin1"), cols, "admin1", id, { name: "Ada L.", role: "secondary", phone: "+15550000199" }));
    await assertSucceeds(removePerson(as("admin1"), cols, id));
  });

  it("never lets a client mark a number confirmed, or touch the code the engine keeps", async () => {
    await assertFails(
      setDoc(doc(as("admin1"), "starfish_oncall_people/x"), { name: "Ada", role: "primary", phone: PHONE, state: "confirmed", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: "admin1" })
    );
    await seedPerson("pending");
    await assertFails(updateDoc(doc(as("admin1"), "starfish_oncall_people/p1"), { state: "confirmed", updatedAt: serverTimestamp(), updatedBy: "admin1" }));
    await assertFails(updateDoc(doc(as("admin1"), "starfish_oncall_people/p1"), { codeHash: "x", updatedAt: serverTimestamp(), updatedBy: "admin1" }));
  });

  it("a new number on a confirmed person must be confirmed again", async () => {
    await seedPerson("confirmed");
    await assertFails(updateDoc(doc(as("admin1"), "starfish_oncall_people/p1"), { phone: "+15550000199", updatedAt: serverTimestamp(), updatedBy: "admin1" }));
    await assertSucceeds(updatePerson(as("admin1"), cols, "admin1", "p1", { name: "Ada", role: "primary", phone: "+15550000199" }));
    // A rename keeps the confirmation.
    await seedPerson("confirmed");
    await assertSucceeds(updatePerson(as("admin1"), cols, "admin1", "p1", { name: "Ada Lovelace", role: "primary" }));
  });

  it("refuses a number that is not E.164 and a role that does not exist", async () => {
    await assertFails(addPerson(as("admin1"), cols, "admin1", { name: "Ada", role: "primary", phone: "555-0142" }));
    await assertFails(addPerson(as("admin1"), cols, "admin1", { name: "Ada", role: "boss" as "primary", phone: PHONE }));
  });

  it("operators, guests, role-less users and visitors read and write none of it", async () => {
    await seedPerson("confirmed");
    for (const [who, db] of [["op1", as("op1")], ["nobody", as("nobody")], ["guest", guest()], ["anon", anon()]] as const) {
      await assertFails(getDoc(doc(db, "starfish_oncall_people/p1")));
      await assertFails(getDocs(collection(db, "starfish_oncall_people")));
      await assertFails(getDoc(doc(db, "starfish_oncall/policy")));
      await assertFails(addPerson(db, cols, who, { name: "Eve", role: "primary", phone: PHONE }));
      await assertFails(savePolicy(db, cols, who, { ...DEFAULT_POLICY, enabled: true }));
      await assertFails(deleteDoc(doc(db, "starfish_oncall_people/p1")));
    }
  });

  it("an admin saves a valid policy and nothing else; nobody but the engine reads the call sequences", async () => {
    await assertSucceeds(savePolicy(as("admin1"), cols, "admin1", { ...DEFAULT_POLICY, enabled: true, quietStart: "22:00", quietEnd: "07:00", timeZone: "Europe/London" }));
    expect((await readOnCall(as("admin1"), cols)).policy).toMatchObject({ enabled: true, quietStart: "22:00", timeZone: "Europe/London" });
    await assertFails(savePolicy(as("admin1"), cols, "admin1", { ...DEFAULT_POLICY, waitMinutes: 0 }));
    await assertFails(savePolicy(as("admin1"), cols, "admin1", { ...DEFAULT_POLICY, quietStart: "7am", quietEnd: "08:00" }));
    await assertFails(setDoc(doc(as("admin1"), "starfish_oncall/policy"), { enabled: true, phone: PHONE, updatedAt: serverTimestamp(), updatedBy: "admin1" }));
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "starfish_escalations/inc1_r0"), { environment: "demo", open: true }));
    await assertFails(getDoc(doc(as("admin1"), "starfish_escalations/inc1_r0")));
    await assertFails(getDoc(doc(guest(), "starfish_escalations/inc1_r0")));
  });

  // #302: a code's hash on the admin-readable person document let an admin try all million codes offline and confirm a
  // number its owner never agreed to. The code state and the daily text count live in an engine-only collection.
  it("nobody, an admin included, reads or writes the opt-in codes or the daily text count (#302, #306)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "starfish_oncall_codes/p1"), { codeHash: "a".repeat(64), sentAt: Timestamp.now(), expiresAt: Timestamp.now(), tries: 0 });
      await setDoc(doc(ctx.firestore(), "starfish_oncall_codes/texts.2026-10-11"), { day: "2026-10-11", count: 3 });
    });
    for (const db of [as("admin1"), as("op1"), as("nobody"), guest(), anon()]) {
      await assertFails(getDoc(doc(db, "starfish_oncall_codes/p1")));
      await assertFails(getDoc(doc(db, "starfish_oncall_codes/texts.2026-10-11")));
      await assertFails(getDocs(collection(db, "starfish_oncall_codes")));
      await assertFails(setDoc(doc(db, "starfish_oncall_codes/p2"), { codeHash: "b".repeat(64), tries: 0 }));
      await assertFails(updateDoc(doc(db, "starfish_oncall_codes/p1"), { tries: 0 }));
      await assertFails(updateDoc(doc(db, "starfish_oncall_codes/texts.2026-10-11"), { count: 0 }));
      await assertFails(deleteDoc(doc(db, "starfish_oncall_codes/p1")));
    }
    // The person's document an admin reads carries no code state.
    await seedPerson("pending");
    const person = await assertSucceeds(getDoc(doc(as("admin1"), "starfish_oncall_people/p1")));
    expect(Object.keys(person.data() ?? {}).filter((k) => k.startsWith("code"))).toEqual([]);
  });
});


// The public demo's open reads (src/publicDemo.ts): a guest reads the demo's FULL stored records only while the
// engine-written gate document says so; a guest still writes nothing, and the gate itself is closed to every client.
describe("public demo: open reads behind the gate document", () => {
  const guest = () => env.authenticatedContext("guest1", { firebase: { sign_in_provider: "anonymous" } }).firestore();
  const emailNoRole = () => env.authenticatedContext("nobody", { firebase: { sign_in_provider: "password" } }).firestore();
  const GATE = "starfish_runs/public_access";
  const setGate = (data: Record<string, unknown> | null) =>
    env.withSecurityRulesDisabled((ctx) => (data === null ? deleteDoc(doc(ctx.firestore(), GATE)) : setDoc(doc(ctx.firestore(), GATE), data)));

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "incidents/demo-1"), { environment: "demo", status: "new", functionName: "f", lastOccurredAt: Timestamp.now(), updatedAt: Timestamp.now() });
      await setDoc(doc(db, "incidents/prod-1"), { environment: "prod", status: "new", functionName: "f", lastOccurredAt: Timestamp.now(), updatedAt: Timestamp.now() });
      await setDoc(doc(db, "incidents/demo-1/corrections/corr-0001"), { level: "log", by: "op1", at: Timestamp.now() });
      await setDoc(doc(db, "incidents/prod-1/corrections/corr-0001"), { level: "log", by: "op1", at: Timestamp.now() });
      await setDoc(doc(db, "starfish_cycles/demo-1_r0"), { incidentId: "demo-1", environment: "demo", state: "done", updatedAt: Timestamp.now() });
      await setDoc(doc(db, "starfish_cycles/demo-1_r0/events/000001"), { seq: 1, environment: "demo", stage: "triage", at: Timestamp.now() });
      await setDoc(doc(db, "starfish_cycles/prod-1_r0"), { incidentId: "prod-1", environment: "prod", state: "done", updatedAt: Timestamp.now() });
      await setDoc(doc(db, "starfish_cycles/prod-1_r0/events/000001"), { seq: 1, environment: "prod", stage: "triage", at: Timestamp.now() });
    });
  });

  /** Every read the UI makes of the stored records, as a guest would make it. */
  const demoReads = (db: ReturnType<typeof guest>) => [
    getDoc(doc(db, "incidents/demo-1")),
    getDocs(query(collection(db, "incidents"), where("environment", "==", "demo"), where("lastOccurredAt", ">=", Timestamp.fromMillis(0)), orderBy("lastOccurredAt", "desc"), limit(200))),
    readCorrections(db, "incidents", "demo-1"),
    getDoc(doc(db, "starfish_cycles/demo-1_r0")),
    getDocs(query(collection(db, "starfish_cycles"), where("environment", "==", "demo"), orderBy("updatedAt", "desc"), limit(50))),
    getDocs(query(collection(db, "starfish_cycles/demo-1_r0/events"), where("environment", "==", "demo"), orderBy("seq", "desc"), limit(201))),
    getDocs(query(collectionGroup(db, "events"), where("environment", "==", "demo"), orderBy("at", "desc"), limit(10))),
  ];

  it("with no gate document (the default), a guest reads none of the stored records, as before", async () => {
    for (const read of demoReads(guest())) await assertFails(read);
  });

  it("with the gate off, for another environment, or malformed, a guest still reads none of them", async () => {
    for (const gate of [{ enabled: false, environment: "demo" }, { enabled: true, environment: "prod" }, { enabled: "true", environment: "demo" }, { enabled: true }]) {
      await setGate(gate);
      for (const read of demoReads(guest())) await assertFails(read);
    }
  });

  it("with the gate on for the demo, a guest reads the demo's stored incidents, corrections, cycles and events", async () => {
    await setGate({ enabled: true, environment: "demo", updatedAt: Timestamp.now() });
    for (const read of demoReads(guest())) await assertSucceeds(read);
    // A missing one reads as missing, as the copies do (#142).
    expect((await assertSucceeds(getDoc(doc(guest(), "incidents/no-such")))).exists()).toBe(false);
  });

  it("with the gate on, still nothing outside the demo, nothing unbounded, and nothing for anyone but a guest", async () => {
    await setGate({ enabled: true, environment: "demo" });
    const db = guest();
    await assertFails(getDoc(doc(db, "incidents/prod-1")));
    await assertFails(getDocs(query(collection(db, "incidents"), where("environment", "==", "prod"), limit(10))));
    await assertFails(getDocs(query(collection(db, "incidents"), where("environment", "==", "demo")))); // no limit
    await assertFails(getDocs(query(collection(db, "incidents"), where("environment", "==", "demo"), limit(501))));
    await assertFails(getDocs(collection(db, "incidents")));
    await assertFails(readCorrections(db, "incidents", "prod-1"));
    await assertFails(getDoc(doc(db, "incidents/prod-1/corrections/corr-0001")));
    await assertFails(getDoc(doc(db, "starfish_cycles/prod-1_r0")));
    await assertFails(getDoc(doc(db, "starfish_cycles/prod-1_r0/events/000001")));
    await assertFails(getDocs(query(collectionGroup(db, "events"), where("environment", "==", "prod"), limit(10))));
    // A role-less email account and a visitor with no session are not guests.
    for (const other of [emailNoRole(), anon()]) for (const read of demoReads(other)) await assertFails(read);
  });

  it("with the gate on, a guest still writes nothing: no triage, retry, correction, cycle or gate", async () => {
    await setGate({ enabled: true, environment: "demo" });
    const db = guest();
    await assertFails(updateDoc(doc(db, "incidents/demo-1"), { status: "acknowledged", updatedAt: serverTimestamp(), statusChangedBy: "guest1" }));
    await assertFails(updateDoc(doc(db, "incidents/demo-1"), { retriageRequestedAt: serverTimestamp(), retriageRequestedBy: "guest1" }));
    await assertFails(saveCorrection(db, "incidents", "demo-1", "guest1", "log", ""));
    await assertFails(setDoc(doc(db, "incidents/demo-1/corrections/corr-0002"), { level: "log", by: "guest1", at: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, "starfish_cycles/demo-1_r0"), { state: "running" }));
    await assertFails(setDoc(doc(db, "starfish_cycles/demo-1_r0/events/000002"), { seq: 2, environment: "demo" }));
    await assertFails(setDoc(doc(db, GATE), { enabled: false, environment: "demo" }));
  });

  it("nobody reads or writes the gate or the visitors' counters from a client, an admin included: only the engine", async () => {
    await setGate({ enabled: true, environment: "demo" });
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "starfish_public_actions/salt"), { value: "a".repeat(64) }));
    for (const db of [as("admin1"), as("op1"), guest(), anon()]) {
      await assertFails(getDoc(doc(db, GATE)));
      await assertFails(setDoc(doc(db, GATE), { enabled: true, environment: "demo" }));
      await assertFails(getDoc(doc(db, "starfish_public_actions/salt")));
      await assertFails(setDoc(doc(db, "starfish_public_actions/ip-runs.2026-10-15T09.x"), { count: 0 }));
    }
  });

  it("leaves operators and admins exactly as they were, gate or no gate", async () => {
    for (const gate of [null, { enabled: true, environment: "demo" }]) {
      await setGate(gate);
      for (const uid of ["op1", "admin1"]) {
        for (const read of demoReads(as(uid))) await assertSucceeds(read);
        await assertSucceeds(getDoc(doc(as(uid), "incidents/prod-1")));
        await assertSucceeds(readCorrections(as(uid), "incidents", "prod-1"));
      }
    }
  });
});
