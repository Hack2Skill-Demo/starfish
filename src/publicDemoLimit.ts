/**
 * The public demo's hourly limits on what visitors with no account may do (src/publicDemo.ts): durable, in Firestore,
 * so every admin API instance counts the same calls (the per-minute limit, src/ipRateLimit.ts, is per instance).
 *
 *   - an open action (a status change, "Retry with agent", "Correct triage"): `publicActionsPerIpPerHour` per address;
 *   - a run ("Run ingest now", "Run agent now", one count for both): `publicRunsPerIpPerHour` per address;
 *   - an agent pass, whoever asks: `publicAgentRunsPerHour` for the whole deployment, because an anonymous account is
 *     free to make and an address is cheap to change, and each pass may spend Gemini calls and file issues and PRs.
 *
 * One transaction claims a call before it runs, like the on-call texts' daily count (src/oncall/optIn.ts): the counter
 * and the decision land together, so two instances can never both take the last one. A claimed call that then fails
 * still counts. Fixed UTC hours: a refusal says how many seconds are left in the hour.
 *
 * The address is never stored. A counter's id carries a keyed hash of it (HMAC-SHA-256, truncated) whose key is a random
 * salt the first claim creates in the same engine-only collection (`salt`), which no client can read (firestore.rules'
 * closing rule): without the salt, an IPv4 address's hash could be undone by trying all four billion. The address
 * itself is the one the admin API's per-minute limit keys on (`clientKey`: the last X-Forwarded-For entry, an IPv6
 * caller by its /64). Each counter carries `expiresAt` (two days on) for a Firestore TTL policy, if the deployment sets
 * one (docs/deploy.md); without one the counters stay, one small document per address and hour.
 *
 * Fails closed: a count that is not a number is taken as the limit reached.
 */
import { createHmac, randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "./config.js";

export type PublicLimitConfig = Pick<StarfishConfig, "publicActionCollection" | "publicActionsPerIpPerHour" | "publicRunsPerIpPerHour" | "publicAgentRunsPerHour">;

/** What a call claims: an open action, or a start of the ingest or of the agent. */
export type PublicActionKind = "action" | "ingest" | "agent";

export type ClaimResult = { ok: true } | { ok: false; limit: "address" | "deployment"; retryAfterSeconds: number };

export const SALT_DOC = "salt";
const HOUR_MS = 3600_000;
const KEEP_MS = 2 * 24 * HOUR_MS;

/** The UTC hour a call falls in, as `YYYY-MM-DDTHH`. */
export const hourBucket = (now: Date): string => now.toISOString().slice(0, 13);

/** A keyed hash of an address: 32 hex characters, enough to tell addresses apart, never the address. */
export const addressHash = (salt: string, clientKey: string): string => createHmac("sha256", salt).update(clientKey).digest("hex").slice(0, 32);

/** The counter documents a call of this kind counts against (per address, and for the agent the deployment's). */
export function counterIds(kind: PublicActionKind, hour: string, hash: string): { address: string; deployment?: string } {
  if (kind === "action") return { address: `ip-actions.${hour}.${hash}` };
  return { address: `ip-runs.${hour}.${hash}`, ...(kind === "agent" && { deployment: `agent-runs.${hour}` }) };
}

const countOf = (v: unknown): number => {
  const n = v === undefined ? 0 : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Number.POSITIVE_INFINITY;
};

let cachedSalt: { db: Firestore; collection: string; value: string } | undefined;

/** The salt, created once for the deployment (a race between two first claims keeps the first). Cached per process. */
export async function readSalt(db: Firestore, collection: string): Promise<string> {
  if (cachedSalt && cachedSalt.db === db && cachedSalt.collection === collection) return cachedSalt.value;
  const ref = db.collection(collection).doc(SALT_DOC);
  const value = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const stored = snap.get("value") as unknown;
    if (typeof stored === "string" && /^[0-9a-f]{64}$/.test(stored)) return stored;
    const fresh = randomBytes(32).toString("hex");
    tx.set(ref, { value: fresh });
    return fresh;
  });
  cachedSalt = { db, collection, value };
  return value;
}

/** Forget the cached salt (tests only). */
export function resetSaltCache(): void {
  cachedSalt = undefined;
}

/** Claim one call of `kind` from `clientKey` now, or say which limit refuses it. Throws only when the store does. */
export async function claimPublicAction(db: Firestore, cfg: PublicLimitConfig, kind: PublicActionKind, clientKey: string, now: Date): Promise<ClaimResult> {
  const salt = await readSalt(db, cfg.publicActionCollection);
  const hour = hourBucket(now);
  const ids = counterIds(kind, hour, addressHash(salt, clientKey || "unknown"));
  const col = db.collection(cfg.publicActionCollection);
  const addressRef = col.doc(ids.address);
  const deploymentRef = ids.deployment ? col.doc(ids.deployment) : undefined;
  const perAddress = kind === "action" ? cfg.publicActionsPerIpPerHour : cfg.publicRunsPerIpPerHour;
  const retryAfterSeconds = Math.max(1, Math.ceil((HOUR_MS - (now.getTime() % HOUR_MS)) / 1000));
  const fields = { hour, updatedAt: Timestamp.fromDate(now), expiresAt: Timestamp.fromMillis(now.getTime() + KEEP_MS) };

  return db.runTransaction(async (tx): Promise<ClaimResult> => {
    const [addressSnap, deploymentSnap] = await Promise.all([tx.get(addressRef), deploymentRef ? tx.get(deploymentRef) : Promise.resolve(undefined)]);
    const byAddress = countOf(addressSnap.get("count"));
    if (byAddress >= perAddress) return { ok: false, limit: "address", retryAfterSeconds };
    const byDeployment = deploymentSnap ? countOf(deploymentSnap.get("count")) : 0;
    if (deploymentRef && byDeployment >= cfg.publicAgentRunsPerHour) return { ok: false, limit: "deployment", retryAfterSeconds };
    tx.set(addressRef, { kind: kind === "action" ? "action" : "run", count: byAddress + 1, ...fields });
    if (deploymentRef) tx.set(deploymentRef, { kind: "agent", count: byDeployment + 1, ...fields });
    return { ok: true };
  });
}
