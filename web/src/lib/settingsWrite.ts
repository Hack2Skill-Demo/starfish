/**
 * Reading and saving the runtime settings (src/runtimeSettings.ts on the engine).
 *
 * Only firebase/firestore and the shared schema are imported here, never the web
 * config, so firestore.rules' test suite can run THIS save against the emulator:
 * the editor's real write is what the rules are proven to accept.
 *
 * A save is one batch of three documents that firestore.rules ties together:
 * the settings, its audit entry (the real before and after of this change), and
 * the copy operators and guests read (the environment label, and the settings for
 * the read-only view). See the "Runtime settings" block in firestore.rules.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
import { SETTINGS_DOC, SETTINGS_VERSION, type RuntimeSettings } from "../../../src/settingsSchema";

export interface SettingsCollections {
  settings: string;
  public: string;
  audit: string;
}

/** The three collections that hang off the configured settings collection. */
export function settingsCollections(base: string): SettingsCollections {
  return { settings: base, public: `${base}_public`, audit: `${base}_audit` };
}

/** The settings document as stored, with its bookkeeping fields. Admin only. */
export type StoredSettings = Record<string, unknown>;

export async function readSettings(db: Firestore, cols: SettingsCollections): Promise<StoredSettings | null> {
  const snap = await getDoc(doc(db, cols.settings, SETTINGS_DOC));
  return snap.exists() ? snap.data() : null;
}

/**
 * What operators and guests may know. Anyone with a role or a guest session reads it, so nothing
 * here may be sensitive: secrets are never in the settings (firestore.rules rejects any key outside
 * the schema), and the copy leaves out who saved it.
 */
export interface PublicSettings {
  environment?: string;
  watchedProjectId?: string;
  revision?: number;
  /**
   * The settings in force: every field of the stored document except its bookkeeping, for the
   * read-only view. Absent on a copy written before the copy carried them (no admin has saved since).
   */
  settings?: StoredSettings;
}

export async function readPublicSettings(db: Firestore, cols: SettingsCollections): Promise<PublicSettings | null> {
  const snap = await getDoc(doc(db, cols.public, SETTINGS_DOC));
  if (!snap.exists()) return null;
  const d = snap.data();
  return {
    ...(typeof d.environment === "string" && { environment: d.environment }),
    ...(typeof d.watchedProjectId === "string" && { watchedProjectId: d.watchedProjectId }),
    ...(typeof d.revision === "number" && { revision: d.revision }),
    ...(isPlainObject(d.settings) && { settings: d.settings }),
  };
}

const isPlainObject = (v: unknown): v is StoredSettings => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A unique id for an audit entry. `crypto.randomUUID` exists only in secure
 * contexts (HTTPS, localhost), so an admin on a plain-http address would hit a
 * TypeError on save; `getRandomValues` is available everywhere.
 */
export function newAuditId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Save `input` as the next revision of `prev`, the document as this admin last
 * read it (null if there is none). Fields of `input` that are undefined are
 * left out, so they fall back to the engine's environment defaults.
 *
 * firestore.rules rejects the batch when `prev` is no longer the stored
 * revision, which is how a stale tab can't overwrite another admin's save; the
 * caller sees a `permission-denied` error and should reload.
 */
export async function saveSettings(
  db: Firestore,
  cols: SettingsCollections,
  uid: string,
  input: RuntimeSettings,
  prev: StoredSettings | null
): Promise<void> {
  const revision = (typeof prev?.revision === "number" ? prev.revision : 0) + 1;
  const auditId = newAuditId();
  const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  // A fresh server timestamp per use: each is resolved to the same request time.
  const current = () => ({
    version: SETTINGS_VERSION,
    revision,
    auditId,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    ...fields,
  });

  const batch = writeBatch(db);
  batch.set(doc(db, cols.settings, SETTINGS_DOC), current());
  batch.set(doc(db, cols.audit, auditId), {
    revision,
    by: uid,
    at: serverTimestamp(),
    before: prev,
    after: current(),
  });
  batch.set(doc(db, cols.public, SETTINGS_DOC), {
    version: SETTINGS_VERSION,
    revision,
    updatedAt: serverTimestamp(),
    ...(input.watchedProjectId !== undefined && { watchedProjectId: input.watchedProjectId }),
    ...(input.environment !== undefined && { environment: input.environment }),
    // The read-only view's copy: exactly the settings fields written above, nothing of the bookkeeping.
    settings: fields,
  });
  await batch.commit();
}

/** One line of the audit trail. */
export interface SettingsChange {
  id: string;
  revision: number;
  /** Operator uid. */
  by: string;
  at: Date | null;
  /** Names of the settings this change added, removed or altered. */
  changed: string[];
}

const BOOKKEEPING = new Set(["version", "revision", "auditId", "updatedAt", "updatedBy"]);

/** Which settings differ between two stored documents (either may be null). */
export function changedSettings(before: unknown, after: unknown): string[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => !BOOKKEEPING.has(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .sort();
}

/** The most recent changes, newest first. Admin only. */
export async function readRecentChanges(
  db: Firestore,
  cols: SettingsCollections,
  count = 10
): Promise<SettingsChange[]> {
  const snap = await getDocs(query(collection(db, cols.audit), orderBy("at", "desc"), limit(count)));
  return snap.docs.map((d) => {
    const data = d.data();
    const at = data.at as { toDate?: () => Date } | undefined;
    return {
      id: d.id,
      revision: typeof data.revision === "number" ? data.revision : 0,
      by: typeof data.by === "string" ? data.by : "unknown",
      at: typeof at?.toDate === "function" ? at.toDate() : null,
      changed: changedSettings(data.before, data.after),
    };
  });
}
