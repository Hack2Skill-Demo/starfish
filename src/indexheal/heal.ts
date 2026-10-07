/**
 * Healing one missing Firestore index (#11): the gates, then at most one Admin API call, then a bounded wait.
 * No model is involved. Every outward effect goes through an injected port, so each refusal is testable and
 * nothing here knows a project id.
 *
 * Order, and why:
 *   1. parse the create-index URL out of the error text (strict, plain-field indexes only);
 *   2. the target guard (allowlist, never Starfish's own database);
 *   3. the switches: `indexAutoApply` explicitly on, `dryRun` off, the automation switch on;
 *   4. the live inventory (read-only): an equal index that exists or is still building is reconciled, never created twice,
 *      which is also how a crash after a create is recovered: the next run finds the building index (and, when this cycle
 *      persisted the create's operation, reports it as created by the cycle, with that operation);
 *   5. an operation an earlier attempt of this cycle already started (`opts.priorOperation`): waited on, never repeated;
 *   6. the per-target daily cap, then the database's index count (the Admin API's inventory of every collection group):
 *      at or above the configured limit nothing is created and a person decides (Firestore caps indexes per database);
 *   7. the deterministic probe (probe.ts): the configured query must fail with the error naming exactly this spec;
 *   8. the switches again, immediately before the one mutation (they are read fresh, an operator may have flipped one);
 *   9. `onCreating` (the caller records the attempt, which is what the daily cap counts, so a crash after the create
 *      still counts), create, hand the operation's name to `onOperation` BEFORE waiting (the caller persists it),
 *      wait for READY;
 *  10. after READY, by whatever route, the probe again: the outcome says whether the query now passes. READY alone is
 *      not "healed"; the caller watches the incident for a window before it says so (observe.ts).
 *
 * Infrastructure failures (a Google call that errors) throw: the cycle resumes and the next run reconciles. A
 * refusal or a finished attempt is a returned outcome. Nothing is ever deleted. The repository's index file is only
 * consulted so the later pull-request step knows whether it has an entry to add; `unknown` is never `absent`.
 */
import type { IndexSpec, IndexTarget } from "./createIndexUrl.js";
import { checkTarget, findCreateIndexUrl, inIndexFile, parseCreateIndexUrl } from "./createIndexUrl.js";
import type { IndexAdmin, LiveIndex } from "./firestoreAdmin.js";
import type { ProbeVerdict } from "./probe.js";

export interface HealSettings {
  allowedTargets: readonly IndexTarget[];
  /** Starfish's own project and database: refused even if listed. */
  own: IndexTarget;
  /** `indexAutoApply`. */
  autoApply: boolean;
  dryRun: boolean;
  dailyCap: number;
  /**
   * The most composite indexes the target database may already hold for Starfish to add one: at or above it, a person
   * decides. Kept well under Firestore's own per-database limit, which also counts indexes nobody here made.
   */
  maxIndexes: number;
  /** Poll interval and the longest the wait may last (the build of a big collection can outlast a cycle). */
  pollMs: number;
  maxWaitMs: number;
}

export interface HealDeps {
  admin: IndexAdmin;
  /** The kill switch, read fresh; false (or a throw) means no mutation. */
  automationOn: () => Promise<boolean>;
  /** The repository's parsed `firestore.indexes.json`, or null when it could not be read. */
  readIndexFile: () => Promise<unknown>;
  /** How many indexes Starfish already created in this target today (UTC). */
  createdToday: (target: IndexTarget) => Promise<number>;
  /**
   * Called immediately before the one create, after every gate passed: the caller records the attempt (what
   * `createdToday` counts). Recording it BEFORE the call means a crash between the two over-counts, never under-counts.
   */
  onCreating: (spec: IndexSpec) => Promise<void>;
  /** Called with the operation's name right after the create succeeds and before any waiting: persist it. */
  onOperation: (operation: string, spec: IndexSpec) => Promise<void>;
  /** Replays the configured failing query (probe.ts). Never throws. */
  probe: (spec: IndexSpec) => Promise<ProbeVerdict>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type RepoFileState = "present" | "absent" | "unknown";

export type HealOutcome =
  | { outcome: "refused"; rule: string; reason: string }
  | { outcome: "switched-off"; reason: string }
  | { outcome: "dry-run"; spec: IndexSpec; repoFile: RepoFileState; live: "absent" | "building" | "ready"; probe: ProbeVerdict["state"] }
  | { outcome: "cap-reached"; spec: IndexSpec; created: number; cap: number }
  /** The database already holds `existing` composite indexes, at or above the configured `limit`: nothing was created. */
  | { outcome: "index-limit"; spec: IndexSpec; existing: number; limit: number }
  /** READY. `probe` is what the replayed query said afterwards: only `passed` means the query works again. */
  | { outcome: "ready"; spec: IndexSpec; repoFile: RepoFileState; created: boolean; operation?: string; probe: ProbeVerdict["state"] }
  | { outcome: "build-failed"; spec: IndexSpec; operation?: string; reason: string }
  | { outcome: "timeout"; spec: IndexSpec; operation?: string };

/** The same index: same scope and the same plain fields in the same order, ignoring the `__name__` Firestore appends. */
export function sameIndex(spec: IndexSpec, live: LiveIndex): boolean {
  const strip = <T extends { fieldPath: string }>(fields: T[]) => fields.filter((f, i) => !(f.fieldPath === "__name__" && i === fields.length - 1));
  const a = strip(spec.fields);
  const b = strip(live.fields);
  return live.queryScope === spec.queryScope && a.length === b.length && a.every((f, i) => f.fieldPath === b[i]!.fieldPath && f.order === b[i]!.order);
}

async function allowed(deps: HealDeps): Promise<boolean> {
  try {
    return await deps.automationOn();
  } catch {
    return false; // fails closed
  }
}

export interface HealOptions {
  /**
   * The create operation an earlier attempt of the same cycle started and persisted. When the live inventory does not
   * show the index yet, this operation is polled instead of creating another: a restart never creates twice.
   */
  priorOperation?: string;
  /**
   * An earlier attempt of the same cycle reached the create call (it recorded `onCreating`) but left no usable
   * operation. When the inventory does not show the index either, nothing is created again: that is for a person.
   */
  priorAttempt?: boolean;
}

/** The parsed spec of an error's create-index URL, or the refusal: what the caller needs before deciding to heal. */
export function specFromError(errorText: string): { ok: true; spec: IndexSpec } | { ok: false; rule: string; reason: string } {
  const url = findCreateIndexUrl(errorText);
  if (url === null) return { ok: false, rule: "no-url", reason: "The error holds no create-index URL." };
  const parsed = parseCreateIndexUrl(url);
  return parsed.ok ? { ok: true, spec: parsed.spec } : { ok: false, rule: parsed.rule, reason: parsed.reason };
}

export async function healIndex(errorText: string, settings: HealSettings, deps: HealDeps, opts: HealOptions = {}): Promise<HealOutcome> {
  const result = await heal(errorText, settings, deps, opts);
  if (result.outcome !== "ready") return result;
  // READY, however it got there: replay the query. The probe never throws; anything but `passed` is not a working query.
  return { ...result, probe: (await deps.probe(result.spec)).state };
}

/** The gates and the wait. A `ready` result's `probe` is a placeholder here: `healIndex` replays the query and sets it. */
async function heal(errorText: string, settings: HealSettings, deps: HealDeps, opts: HealOptions): Promise<HealOutcome> {
  const parsed = specFromError(errorText);
  if (!parsed.ok) return { outcome: "refused", rule: parsed.rule, reason: parsed.reason };
  const spec = parsed.spec;

  const target = checkTarget(spec, settings.allowedTargets, settings.own);
  if (!target.allowed) return { outcome: "refused", rule: target.rule, reason: target.reason };
  const targetKey: IndexTarget = { project: spec.project, database: spec.database };

  if (!settings.autoApply && !settings.dryRun) {
    return { outcome: "switched-off", reason: "Creating indexes is off (STARFISH_INDEX_AUTO_APPLY); nothing was created." };
  }
  if (!settings.dryRun && !(await allowed(deps))) return { outcome: "switched-off", reason: "The automation switch is off; nothing was created." };

  const repoFile = inIndexFile(spec, await deps.readIndexFile().catch(() => null)); // unreadable is "unknown", never a reason to stop
  const live = (await deps.admin.list(spec)).find((l) => sameIndex(spec, l));

  if (live !== undefined && live.state === "NEEDS_REPAIR") {
    return { outcome: "refused", rule: "needs-repair", reason: "An equal index exists but needs repair; that is for a person." };
  }
  if (settings.dryRun) {
    // Read-only: the inventory and the configured query, nothing else.
    const probe = (await deps.probe(spec)).state;
    return { outcome: "dry-run", spec, repoFile, live: live === undefined ? "absent" : live.state === "READY" ? "ready" : "building", probe };
  }

  // An earlier attempt of this cycle whose create returned an operation did create it, even when the inventory is what
  // finds it now (#191): a resumed heal reports that, with the operation, rather than "already there".
  const earlier: Earlier = opts.priorOperation !== undefined ? { created: true, operation: opts.priorOperation } : { created: false };
  if (live?.state === "READY") return { outcome: "ready", spec, repoFile, ...earlier, probe: "not-configured" };
  if (live !== undefined) return waitForIndex(spec, repoFile, settings, deps, earlier);
  // An earlier attempt created it and persisted the operation, and the inventory does not show it yet: wait on that.
  if (opts.priorOperation !== undefined) return waitForOperation(spec, repoFile, opts.priorOperation, settings, deps);
  if (opts.priorAttempt === true) {
    return {
      outcome: "refused",
      rule: "unresolved-earlier-create",
      reason: "An earlier attempt called create, and neither its operation nor the index can be found; nothing is created twice.",
    };
  }

  const created = await deps.createdToday(targetKey);
  if (created >= settings.dailyCap) return { outcome: "cap-reached", spec, created, cap: settings.dailyCap };
  // Read, not assumed: a count that cannot be read throws (the cycle resumes), it never reads as room to spare.
  const existing = await deps.admin.countIndexes(targetKey);
  if (!Number.isInteger(existing) || existing < 0) throw new Error("index count: not a count");
  if (existing >= settings.maxIndexes) return { outcome: "index-limit", spec, existing, limit: settings.maxIndexes };

  // The failing query must be known and must fail for exactly this index: a URL alone is not the query (#11).
  const confirmed = await deps.probe(spec);
  if (confirmed.state !== "needs-index") {
    const why =
      confirmed.state === "not-configured"
        ? "No probe is configured for this collection, so the failing query cannot be confirmed; nothing was created."
        : confirmed.state === "passed"
          ? "The configured query already succeeds, so this index is not what it needs; nothing was created."
          : `The configured query did not confirm this index (${confirmed.reason}); nothing was created.`;
    return { outcome: "refused", rule: confirmed.state === "not-configured" ? "no-probe" : "probe-not-confirmed", reason: why };
  }

  if (!(await allowed(deps))) return { outcome: "switched-off", reason: "The automation switch went off before the index was created." };
  await deps.onCreating(spec);
  const { operation } = await deps.admin.create(spec);
  await deps.onOperation(operation, spec);
  return waitForOperation(spec, repoFile, operation, settings, deps);
}

async function waitForOperation(spec: IndexSpec, repoFile: RepoFileState, operation: string, s: HealSettings, deps: HealDeps): Promise<HealOutcome> {
  const deadline = deps.now() + s.maxWaitMs;
  for (;;) {
    const status = await deps.admin.getOperation(operation);
    if (status.done) {
      return status.error === undefined
        ? { outcome: "ready", spec, repoFile, created: true, operation, probe: "not-configured" }
        : { outcome: "build-failed", spec, operation, reason: `Google reported error ${status.error.code}: ${status.error.message}` };
    }
    if (deps.now() >= deadline) return { outcome: "timeout", spec, operation };
    await deps.sleep(s.pollMs);
  }
}

/** Whether an earlier attempt of this cycle created the index the inventory shows, and its operation when it did. */
type Earlier = { created: true; operation: string } | { created: false };

/** An equal index was already building (an earlier attempt, or someone else): wait on its state, creating nothing. */
async function waitForIndex(spec: IndexSpec, repoFile: RepoFileState, s: HealSettings, deps: HealDeps, earlier: Earlier): Promise<HealOutcome> {
  const op = earlier.created ? { operation: earlier.operation } : {};
  const deadline = deps.now() + s.maxWaitMs;
  for (;;) {
    await deps.sleep(s.pollMs);
    const found = (await deps.admin.list(spec)).find((l) => sameIndex(spec, l));
    if (found?.state === "READY") return { outcome: "ready", spec, repoFile, ...earlier, probe: "not-configured" };
    if (found === undefined || found.state === "NEEDS_REPAIR") {
      return { outcome: "build-failed", spec, ...op, reason: "The index that was building is gone or needs repair." };
    }
    if (deps.now() >= deadline) return { outcome: "timeout", spec, ...op };
  }
}
