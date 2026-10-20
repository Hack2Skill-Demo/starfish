/**
 * The public demo's open actions: on the demo only, and only while a deployment turns them on
 * (`STARFISH_PUBLIC_DEMO_ACTIONS`), a visitor with no account (an anonymous Firebase Auth session, the "guest") may do
 * what an operator does, and start "Run ingest now" and "Run agent now". Settings, On-call and Retire stay an admin's.
 *
 * Every one of them runs HERE, in the admin API (src/adminApi.ts), with the Admin SDK, and never as a write from the
 * browser: firestore.rules cannot see a caller's address, and the address is what the hourly limits count
 * (src/publicDemoLimit.ts). firestore.rules gains no anonymous write. Each write has the shape firestore.rules requires
 * of an operator's (the same fields, the caller named, the time the server's), on an incident of this deployment's own
 * environment only, never a retired one, and is audited in the same transaction: who (the anonymous uid, `actorKind:
 * "anonymous"`), what, before and after, when. Never the caller's address. A refusal is not audited: anyone can make an
 * anonymous account, and recording refusals would let them fill the audit trail at will (as src/oncall/optIn.ts).
 *
 * Each function checks the switch itself (`publicDemoActionsOn`), as each admin action checks the role itself: the
 * admin API wires them only when it is on, and a call that reaches one when it is off does nothing. The environment
 * they check is the runtime settings', resolved for each call (`publicDemoSettings`, #430), as every other job reads it.
 *
 * Reads. While the switch is on, the admin API writes the gate document `{runCollection}/public_access` (`enabled`,
 * `environment`) as it starts and at each visitor's call, and firestore.rules lets a guest read the full stored
 * incidents, cycles, run events and corrections of the demo environment only while that document says `enabled: true,
 * environment: 'demo'`. Turned off, or the settings moved off a public environment, the next start or visitor's call
 * writes `enabled: false` (`syncPublicAccess`). Built and tested with stubs and the Firestore emulator; never run on a
 * real project.
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { StarfishConfig } from "./config.js";
import type { ResolvedConfig } from "./runtimeSettings.js";
import { isValidUid } from "./adminAuth.js";
import { nextStatus, type IncidentAction, type TriageStatus } from "./incidentActions.js";
import { redactPii } from "./ingest/redact.js";
import { runIngest, type ConfigResolver, type RunDeps } from "./ingest/run.js";
import { isPublicEnvironment, type PublicViewConfig } from "./publicView.js";
import { refreshPublicIncident } from "./publicViewStore.js";
import { MAX_NOTE, cleanText, isLevel, levelRank, type Level } from "./triageRules.js";
import { OPEN_INCIDENT_STATUSES, INCIDENT_STATUSES } from "./types.js";
import type { TriggerResult } from "./ingest/trigger.js";
import type { AgentTriggerResult } from "./agent/trigger.js";

export type PublicDemoConfig = Pick<StarfishConfig, "publicDemoActions" | "environment" | "incidentCollection" | "auditCollection" | "runCollection"> & PublicViewConfig;

/** The gate document firestore.rules reads before it serves a guest the full records: `{runCollection}/public_access`. */
export const PUBLIC_ACCESS_DOC = "public_access";

/** The switch, honoured only on a public environment (`STARFISH_PUBLIC_ENVIRONMENTS`, the demo by default). */
export function publicDemoActionsOn(cfg: Pick<StarfishConfig, "publicDemoActions" | "environment" | "publicEnvironments">): boolean {
  return cfg.publicDemoActions && isPublicEnvironment(cfg, cfg.environment);
}

export type PublicIncidentRefusal = "off" | "invalid-id" | "no-such-incident" | "not-applicable" | "bad-request";
export type PublicIncidentResult = { ok: true } | { ok: false; reason: PublicIncidentRefusal };

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const isStatus = (v: unknown): v is TriageStatus => typeof v === "string" && (INCIDENT_STATUSES as readonly string[]).includes(v);
const isOpen = (v: unknown): boolean => typeof v === "string" && (OPEN_INCIDENT_STATUSES as readonly string[]).includes(v);

/**
 * One incident write in one transaction with its audit entry: the incident must exist, be of this deployment's
 * environment and not be retired (otherwise `no-such-incident`, as a guest is not told an incident of another
 * environment exists). `decide` reads the stored document and returns the update and the audit's before/after, or a refusal.
 */
async function writeIncident(
  db: Firestore,
  cfg: PublicDemoConfig,
  incidentId: string,
  actorUid: string,
  now: Date,
  action: string,
  decide: (d: Record<string, unknown>, at: Timestamp) => { update: Record<string, unknown>; before: object; after: object; extra?: (tx: Transaction) => void } | PublicIncidentRefusal
): Promise<PublicIncidentResult> {
  if (!publicDemoActionsOn(cfg)) return { ok: false, reason: "off" };
  if (!ID_RE.test(incidentId) || !isValidUid(actorUid)) return { ok: false, reason: "invalid-id" };
  const ref = db.collection(cfg.incidentCollection).doc(incidentId);
  const at = Timestamp.fromDate(now);
  const result = await db.runTransaction(async (tx): Promise<PublicIncidentResult> => {
    const snap = await tx.get(ref);
    const d = snap.data();
    if (!d || d.environment !== cfg.environment || d.retired === true) return { ok: false, reason: "no-such-incident" };
    const decided = decide(d, at);
    if (typeof decided === "string") return { ok: false, reason: decided };
    tx.update(ref, decided.update);
    decided.extra?.(tx);
    tx.create(db.collection(cfg.auditCollection).doc(), {
      action,
      actorUid,
      actorKind: "anonymous",
      incidentId,
      environment: cfg.environment,
      before: decided.before,
      after: decided.after,
      at,
    });
    return { ok: true };
  });
  // The guests' trimmed copy follows the stored incident (src/publicViewStore.ts; never throws).
  if (result.ok) await refreshPublicIncident(db, cfg, incidentId, cfg.environment);
  return result;
}

/** Acknowledge, resolve, ignore or reopen: the operator's transitions (src/incidentActions.ts), the fields firestore.rules allows. */
export function setIncidentStatusAsGuest(db: Firestore, cfg: PublicDemoConfig, incidentId: string, action: IncidentAction, actorUid: string, now: Date): Promise<PublicIncidentResult> {
  return writeIncident(db, cfg, incidentId, actorUid, now, "public-incident-status", (d, at) => {
    if (!isStatus(d.status)) return "not-applicable";
    const status = nextStatus(d.status, action);
    if (status === null) return "not-applicable";
    return {
      update: {
        status,
        updatedAt: at,
        statusChangedBy: actorUid,
        // `resolvedAt` exists exactly when the incident is resolved, as firestore.rules requires of an operator.
        resolvedAt: status === "resolved" ? at : FieldValue.delete(),
      },
      before: { status: d.status },
      after: { status },
    };
  });
}

/** "Retry with agent" (src/agent/reconsider.ts): the request's time and who asked, on an open incident only. */
export function requestRetriageAsGuest(db: Firestore, cfg: PublicDemoConfig, incidentId: string, actorUid: string, now: Date): Promise<PublicIncidentResult> {
  return writeIncident(db, cfg, incidentId, actorUid, now, "public-retriage", (d, at) => {
    if (!isOpen(d.status)) return "not-applicable";
    return { update: { retriageRequestedAt: at, retriageRequestedBy: actorUid }, before: { status: d.status }, after: { retriageRequested: true } };
  });
}

/**
 * "Correct triage" (the feedback engine, src/triageRules.ts): the latest correction on the incident and an immutable
 * history entry in its `corrections`, written together, as web/src/lib/correctionWrite.ts writes them. The note is
 * redacted (it is free text a stranger typed, and other visitors read it) and must then be one line of at most
 * MAX_NOTE characters; an empty note is none.
 */
export function correctTriageAsGuest(db: Firestore, cfg: PublicDemoConfig, incidentId: string, level: unknown, note: unknown, actorUid: string, now: Date): Promise<PublicIncidentResult> {
  if (!isLevel(level)) return Promise.resolve({ ok: false, reason: "bad-request" });
  if (note !== undefined && typeof note !== "string") return Promise.resolve({ ok: false, reason: "bad-request" });
  const raw = (note ?? "").trim();
  const text = raw === "" ? null : cleanText(redactPii(raw), MAX_NOTE);
  if (raw !== "" && text === null) return Promise.resolve({ ok: false, reason: "bad-request" });
  const lvl: Level = level;
  return writeIncident(db, cfg, incidentId, actorUid, now, "public-correction", (d, at) => {
    // A visitor may set the first correction or tighten one, never loosen it: a correction only holds Starfish back,
    // and an anonymous stranger must not lift an operator's (or another visitor's) hold on an incident.
    if (isLevel(d.correctedLevel) && levelRank(lvl) > levelRank(d.correctedLevel)) return "not-applicable";
    const entry = db.collection(cfg.incidentCollection).doc(incidentId).collection("corrections").doc();
    return {
      update: {
        correctedLevel: lvl,
        correctedBy: actorUid,
        correctedAt: at,
        correctionNote: text ?? FieldValue.delete(),
        correctionId: entry.id,
      },
      before: { correctedLevel: isLevel(d.correctedLevel) ? d.correctedLevel : null },
      after: { correctedLevel: lvl },
      extra: (tx) => tx.create(entry, { level: lvl, by: actorUid, at, ...(text !== null && { note: text }) }),
    };
  });
}

/** "Run ingest now" for a visitor: the scheduled run (src/ingest/trigger.ts's), audited before it runs. */
export async function triggerIngestAsGuest(
  db: Firestore,
  cfg: PublicDemoConfig,
  loader: ConfigResolver,
  actorUid: string,
  now: Date = new Date(),
  deps?: RunDeps
): Promise<TriggerResult | { ok: false; reason: "off" }> {
  if (!publicDemoActionsOn(cfg)) return { ok: false, reason: "off" };
  if (!isValidUid(actorUid)) return { ok: false, reason: "invalid-id" };
  await db.collection(cfg.auditCollection).doc().create({ action: "run-ingest", actorUid, actorKind: "anonymous", at: Timestamp.fromDate(now) });
  return { ok: true, summary: await runIngest(db, loader, now, deps) };
}

/** "Run agent now" for a visitor: starts the deployed agent job (src/agent/trigger.ts's), audited before the start. */
export async function triggerAgentPassAsGuest(
  db: Firestore,
  cfg: PublicDemoConfig,
  startJob: () => Promise<void>,
  actorUid: string,
  now: Date = new Date()
): Promise<AgentTriggerResult | { ok: false; reason: "off" }> {
  if (!publicDemoActionsOn(cfg)) return { ok: false, reason: "off" };
  if (!isValidUid(actorUid)) return { ok: false, reason: "invalid-id" };
  await db.collection(cfg.auditCollection).doc().create({ action: "run-agent", actorUid, actorKind: "anonymous", at: Timestamp.fromDate(now) });
  await startJob();
  return { ok: true };
}

export type GateResult = "enabled" | "disabled" | "unchanged";

/** What one gate sync did, for the service's log: where the actions stand, and the gate's outcome or why it failed. */
export type GateEvent = { on: boolean; environment: string } & ({ gate: GateResult } | { error: string });

export interface PublicDemoSettingsDeps {
  /** The runtime settings over the environment's defaults (src/runtimeSettings.ts `RuntimeConfigLoader`, which never throws). */
  resolve(): Promise<Pick<ResolvedConfig, "config" | "actionsAllowed">>;
  /** `syncPublicAccess` against the store. May throw; the failure is reported, never passed on. */
  syncGate(cfg: StarfishConfig): Promise<GateResult>;
  onGate?(event: GateEvent): void;
}

/**
 * The configuration a visitor's call runs with (#430), resolved fresh for each call: the admin API is a long-running
 * service, and the runtime settings' `environment`, which ingest, the agent and the UI follow, can change under it at
 * any time. Before this, the service used the environment variable's label alone, so with STARFISH_ENV=x and Settings
 * saying demo the open actions stayed off and the read gate was never written, and the reverse answered every visitor's
 * action no-such-incident. Returns the frozen snapshot when the open actions are on for it, else null (the routes then
 * answer as if they were not wired). Unusable settings with no last-good copy (`actionsAllowed` false) are off, as they
 * stop every other job.
 *
 * Each call also brings the gate document in line with what it resolved (`syncPublicAccess`: a read, and a write only
 * when the gate differs), so a Settings change reaches the gate at the next visitor's call or the next start, whichever
 * comes first; the admin API also calls this once as it starts. Unusable settings close the gate. A failed sync is
 * reported and leaves the gate as it was; it does not refuse the call. Never throws.
 */
export function publicDemoSettings(deps: PublicDemoSettingsDeps): () => Promise<StarfishConfig | null> {
  const report = (event: GateEvent): void => {
    try {
      deps.onGate?.(event);
    } catch {
      // Reporting must never change the answer.
    }
  };
  return async () => {
    let resolved: Pick<ResolvedConfig, "config" | "actionsAllowed">;
    try {
      resolved = await deps.resolve();
    } catch {
      return null;
    }
    // Unusable settings: off, and the gate closed with them.
    const cfg = resolved.actionsAllowed ? resolved.config : { ...resolved.config, publicDemoActions: false };
    const on = publicDemoActionsOn(cfg);
    try {
      report({ on, environment: cfg.environment, gate: await deps.syncGate(cfg) });
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      report({ on, environment: cfg.environment, error: typeof code === "string" || typeof code === "number" ? String(code) : e instanceof Error ? e.name : "unknown" });
    }
    return on ? cfg : null;
  };
}

/**
 * Bring the gate document in line with the switch, as the admin API starts and at each visitor's call: on, `{ enabled: true, environment }`; off,
 * `enabled: false` where a document says otherwise, and nothing where there is none (a deployment that never turned it
 * on writes nothing). Throws when the store does; the caller logs it and serves on (reads then stay as they were).
 */
export async function syncPublicAccess(db: Firestore, cfg: PublicDemoConfig & Pick<StarfishConfig, "publicEnvironments">, now: Date): Promise<GateResult> {
  const ref = db.collection(cfg.runCollection).doc(PUBLIC_ACCESS_DOC);
  const on = publicDemoActionsOn(cfg);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (on) {
      if (snap.get("enabled") === true && snap.get("environment") === cfg.environment) return "unchanged";
      tx.set(ref, { enabled: true, environment: cfg.environment, updatedAt: Timestamp.fromDate(now) });
      return "enabled";
    }
    if (!snap.exists || snap.get("enabled") === false) return "unchanged";
    tx.set(ref, { enabled: false, environment: snap.get("environment") ?? cfg.environment, updatedAt: Timestamp.fromDate(now) });
    return "disabled";
  });
}
