import { describe, it, expect } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  LAST_GOOD_DOC,
  RuntimeConfigLoader,
  SETTINGS_DOC,
  applySettings,
  validateSettings,
} from "./runtimeSettings.js";
import { DEFAULT_IGNORED_MESSAGES, DEFAULT_LOG_RESOURCE_TYPES, type StarfishConfig } from "./config.js";
import { SEEDED_SECRETS } from "./ingest/testSecrets.js";

const base: StarfishConfig = {
  projectId: "starfish-home",
  watchedProjectId: "starfish-home",
  vertexProjectId: "starfish-home",
  location: "us-central1",
  model: "m",
  environment: "dev",
  incidentCollection: "incidents",
  incidentKeyCollection: "incident_keys",
  settingsCollection: "starfish_settings",
  databaseId: "starfish",
  servicePatterns: { api: "api" },
  defaultLookbackHours: 24,
  ingestLagMinutes: 5,
  ingestMaxWindowHours: 6,
  runCollection: "starfish_runs",
  logResourceTypes: [...DEFAULT_LOG_RESOURCE_TYPES],
  ignoredMessages: [...DEFAULT_IGNORED_MESSAGES],
};

const valid = { version: 1, watchedProjectId: "watched-app-1", environment: "prod" };

/** Just enough Firestore for the loader: documents by id, with failures on demand. */
function fakeDb(docs: Record<string, unknown> = {}, opts: { failRead?: Error; failSet?: boolean } = {}) {
  // `opts` is read on every call, so a test can heal a failing save by clearing it.
  const writes: { id: string; data: unknown }[] = [];
  const reads: string[] = [];
  const deleted: string[] = [];
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          reads.push(`${name}/${id}`);
          if (opts.failRead && id === SETTINGS_DOC) throw opts.failRead;
          return { exists: id in docs, data: () => docs[id] };
        },
        set: async (data: unknown) => {
          if (opts.failSet) throw new Error("write denied");
          writes.push({ id, data });
          docs[id] = data;
        },
        delete: async () => {
          deleted.push(id);
          delete docs[id];
        },
      }),
    }),
  } as unknown as Firestore;
  return { db, docs, writes, reads, deleted };
}

describe("validateSettings", () => {
  it("accepts the version alone, and a full document", () => {
    expect(validateSettings({ version: 1 })).toEqual({ ok: true, settings: {} });
    const full = {
      version: 1,
      watchedProjectId: "watched-app-1",
      environment: "prod-eu.1",
      logResourceTypes: ["cloud_function", "gae_app"],
      servicePatterns: { " Billing ": " payments " },
      ignoredMessages: ["probe"],
      updatedBy: "uid1",
      updatedAt: { toMillis: () => 1 },
      revision: 3,
      auditId: "audit-0001",
    };
    expect(validateSettings(full)).toEqual({
      ok: true,
      settings: {
        watchedProjectId: "watched-app-1",
        environment: "prod-eu.1",
        logResourceTypes: ["cloud_function", "gae_app"],
        // Patterns match against a lowercased function name, so they are stored lowercased.
        servicePatterns: { billing: "payments" },
        ignoredMessages: ["probe"],
      },
    });
  });

  it("accepts an explicitly empty noise list: suppress nothing", () => {
    expect(validateSettings({ version: 1, ignoredMessages: [] })).toEqual({
      ok: true,
      settings: { ignoredMessages: [] },
    });
  });

  it.each([
    ["not an object", "settings"],
    [[], "settings"],
    [null, "settings"],
  ])("rejects %j", (raw, field) => {
    const v = validateSettings(raw);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.problems[0]).toContain(field);
  });

  it("rejects a document of another version, so an old engine ignores a newer schema", () => {
    expect(validateSettings({ version: 2 })).toMatchObject({ ok: false, problems: ["version: must be 1"] });
    expect(validateSettings({})).toMatchObject({ ok: false });
  });

  it("rejects unknown settings, so a typo surfaces instead of doing nothing", () => {
    const v = validateSettings({ version: 1, logResourceType: ["cloud_function"] });
    expect(v).toEqual({ ok: false, problems: ["logResourceType: unknown setting"] });
  });

  it("rejects values that could break out of the log filter or aren't what the field means", () => {
    const bad = {
      version: 1,
      watchedProjectId: "Not A Project",
      environment: "prod\nNOT severity",
      logResourceTypes: ['cloud_function" OR resource.type="gce_instance'],
      servicePatterns: { ok: "line\nbreak" },
      ignoredMessages: ["fine", "bad\rone"],
    };
    const v = validateSettings(bad);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.problems.map((p) => p.split(":")[0]).sort()).toEqual([
      "environment",
      "ignoredMessages",
      "logResourceTypes",
      "servicePatterns",
      "watchedProjectId",
    ]);
  });

  it("rejects a __proto__ pattern instead of silently dropping it", () => {
    const raw = JSON.parse('{"version":1,"servicePatterns":{"__proto__":"x"}}');
    expect(validateSettings(raw).ok).toBe(false);
  });

  it("enforces list shape and size", () => {
    expect(validateSettings({ version: 1, logResourceTypes: [] }).ok).toBe(false);
    expect(validateSettings({ version: 1, logResourceTypes: "cloud_function" }).ok).toBe(false);
    expect(validateSettings({ version: 1, ignoredMessages: Array(101).fill("x") }).ok).toBe(false);
    expect(validateSettings({ version: 1, servicePatterns: ["x"] }).ok).toBe(false);
    expect(validateSettings({ version: 1, updatedAt: "yesterday" }).ok).toBe(false);
    expect(validateSettings({ version: 1, revision: 1.5 }).ok).toBe(false);
    expect(validateSettings({ version: 1, revision: -1 }).ok).toBe(false);
    expect(validateSettings({ version: 1, auditId: 7 }).ok).toBe(false);
  });

  it("never echoes a value into its problems: a bad value may be a pasted credential", () => {
    const secret = SEEDED_SECRETS.google!;
    const v = validateSettings({
      version: 1,
      watchedProjectId: secret,
      environment: secret,
      logResourceTypes: [secret],
      servicePatterns: { [secret]: 1 },
      ignoredMessages: [secret + "\n"],
      updatedBy: 5,
    });
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v)).not.toContain(secret);
  });
});

describe("applySettings", () => {
  it("overrides only what the settings name, replacing lists rather than merging them", () => {
    const config = applySettings(base, {
      watchedProjectId: "watched-app-1",
      logResourceTypes: ["cloud_run_revision"],
      ignoredMessages: [],
    });
    expect(config).toMatchObject({
      projectId: "starfish-home",
      watchedProjectId: "watched-app-1",
      environment: "dev",
      logResourceTypes: ["cloud_run_revision"],
      ignoredMessages: [],
      servicePatterns: { api: "api" },
      databaseId: "starfish",
    });
  });

  it("returns a frozen snapshot that shares nothing mutable with the defaults", () => {
    const config = applySettings(base, {});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.logResourceTypes)).toBe(true);
    expect(Object.isFrozen(config.servicePatterns)).toBe(true);
    // Freezing the snapshot must not freeze the caller's (or the module's) arrays.
    expect(Object.isFrozen(base.logResourceTypes)).toBe(false);
    expect(Object.isFrozen(DEFAULT_IGNORED_MESSAGES)).toBe(false);
    expect(config.logResourceTypes).not.toBe(base.logResourceTypes);
  });
});

describe("RuntimeConfigLoader", () => {
  it("uses the environment defaults when there is no settings document", async () => {
    const { db } = fakeDb();
    const r = await new RuntimeConfigLoader(base).resolve(db);
    expect(r).toMatchObject({ source: "env", problems: [], actionsAllowed: true });
    expect(r.config).toEqual(base);
  });

  it("applies a valid document, and keeps a copy as the last good one", async () => {
    const { db, writes } = fakeDb({ [SETTINGS_DOC]: valid });
    const r = await new RuntimeConfigLoader(base).resolve(db);
    expect(r).toMatchObject({ source: "settings", problems: [], actionsAllowed: true });
    expect(r.config).toMatchObject({ watchedProjectId: "watched-app-1", environment: "prod", projectId: "starfish-home" });
    expect(writes).toEqual([
      { id: LAST_GOOD_DOC, data: { version: 1, watchedProjectId: "watched-app-1", environment: "prod" } },
    ]);
  });

  it("saves the last good copy only when it changes, not on every run", async () => {
    const { db, docs, writes } = fakeDb({ [SETTINGS_DOC]: valid });
    const loader = new RuntimeConfigLoader(base);
    await loader.resolve(db);
    await loader.resolve(db);
    expect(writes).toHaveLength(1);
    docs[SETTINGS_DOC] = { ...valid, environment: "staging" };
    await loader.resolve(db);
    expect(writes).toHaveLength(2);
  });

  it("falls back to the last good document when the current one is invalid", async () => {
    const { db, docs } = fakeDb({ [SETTINGS_DOC]: valid });
    const loader = new RuntimeConfigLoader(base);
    await loader.resolve(db);
    docs[SETTINGS_DOC] = { version: 1, environment: "bad env!" };

    const r = await loader.resolve(db);

    expect(r.source).toBe("last-good");
    expect(r.actionsAllowed).toBe(true);
    expect(r.problems).toEqual([expect.stringContaining("environment")]);
    expect(r.config.environment).toBe("prod");
  });

  it("falls back to the copy a previous instance saved, so a fresh process has one", async () => {
    const { db, docs } = fakeDb({ [SETTINGS_DOC]: valid });
    await new RuntimeConfigLoader(base).resolve(db);
    docs[SETTINGS_DOC] = { version: 1, logResourceTypes: [] };

    const r = await new RuntimeConfigLoader(base).resolve(db);

    expect(r).toMatchObject({ source: "last-good", actionsAllowed: true });
    expect(r.config.watchedProjectId).toBe("watched-app-1");
  });

  it("with an invalid document and nothing known good: the defaults, with actions refused", async () => {
    const { db } = fakeDb({ [SETTINGS_DOC]: { version: 9 } });
    const r = await new RuntimeConfigLoader(base).resolve(db);
    expect(r).toMatchObject({ source: "env", actionsAllowed: false, problems: ["version: must be 1"] });
    expect(r.config).toEqual(base);
  });

  it("ignores a saved last-good copy that no longer validates", async () => {
    const { db } = fakeDb({ [SETTINGS_DOC]: { version: 9 }, [LAST_GOOD_DOC]: { version: 1, environment: "no good!" } });
    const r = await new RuntimeConfigLoader(base).resolve(db);
    expect(r).toMatchObject({ source: "env", actionsAllowed: false });
  });

  it("never throws on a failed read: last good if there is one, else the defaults with actions refused", async () => {
    const { db: healthy } = fakeDb({ [SETTINGS_DOC]: valid });
    const loader = new RuntimeConfigLoader(base);
    await loader.resolve(healthy);

    const err = Object.assign(new Error(`permission denied for ${SEEDED_SECRETS.google}`), { code: 7 });
    const down = fakeDb({}, { failRead: err }).db;

    const r = await loader.resolve(down);
    expect(r).toMatchObject({ source: "last-good", actionsAllowed: true, problems: ["settings read failed: 7"] });
    // The code is reported; the message, which can echo data, is not.
    expect(JSON.stringify(r.problems)).not.toContain(SEEDED_SECRETS.google);

    const fresh = await new RuntimeConfigLoader(base).resolve(down);
    expect(fresh).toMatchObject({ source: "env", actionsAllowed: false });
  });

  it("treats a deleted document as a reset to the defaults, and discards what was good before it", async () => {
    const { db, docs, deleted } = fakeDb({ [SETTINGS_DOC]: valid });
    const loader = new RuntimeConfigLoader(base);
    await loader.resolve(db);
    delete docs[SETTINGS_DOC];

    const reset = await loader.resolve(db);
    expect(reset).toMatchObject({ source: "env", actionsAllowed: true });
    expect(reset.config).toEqual(base);
    expect(deleted).toEqual([LAST_GOOD_DOC]);

    // A bad edit after the reset must not bring back the settings the admin removed,
    // from this process's memory or from a fresh instance reading the saved copy.
    docs[SETTINGS_DOC] = { version: 9 };
    for (const l of [loader, new RuntimeConfigLoader(base)]) {
      expect(await l.resolve(db)).toMatchObject({ source: "env", actionsAllowed: false });
    }
  });

  it("while no settings exist, costs a read and never a write", async () => {
    const { db, reads, writes, deleted } = fakeDb();
    await new RuntimeConfigLoader(base).resolve(db);
    expect(reads).toEqual([`${SETTINGS_DOC}`, LAST_GOOD_DOC].map((id) => `starfish_settings/${id}`));
    expect(writes).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("a failure to save the last good copy doesn't fail the run, and the save is retried", async () => {
    const opts = { failSet: true };
    const { db, writes } = fakeDb({ [SETTINGS_DOC]: valid }, opts);
    const loader = new RuntimeConfigLoader(base);

    const r = await loader.resolve(db);
    expect(r).toMatchObject({ source: "settings", problems: [] });
    expect(writes).toEqual([]);

    // Without the retry, an unchanged document would never be saved after a failed first try.
    opts.failSet = false;
    await loader.resolve(db);
    await loader.resolve(db);
    expect(writes).toHaveLength(1);
  });

  it("hands each run its own snapshot: an edit mid-run can't change one already handed out", async () => {
    const { db, docs } = fakeDb({ [SETTINGS_DOC]: valid });
    const loader = new RuntimeConfigLoader(base);
    const first = await loader.resolve(db);
    docs[SETTINGS_DOC] = { ...valid, environment: "staging" };
    const second = await loader.resolve(db);
    expect(first.config.environment).toBe("prod");
    expect(second.config.environment).toBe("staging");
  });
});
