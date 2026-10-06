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
 *      which is also how a crash after a create is recovered: the next run finds the building index;
 *   5. the per-target daily cap;
 *   6. the switches again, immediately before the one mutation (they are read fresh, an operator may have flipped one);
 *   7. create, hand the operation's name to `onOperation` BEFORE waiting (the caller persists it), wait for READY.
 *
 * Infrastructure failures (a Google call that errors) throw: the cycle resumes and the next run reconciles. A
 * refusal or a finished attempt is a returned outcome. Nothing is ever deleted. The repository's index file is only
 * consulted so the later pull-request step knows whether it has an entry to add; `unknown` is never `absent`.
 */
import type { IndexSpec, IndexTarget } from "./createIndexUrl.js";
import { checkTarget, findCreateIndexUrl, inIndexFile, parseCreateIndexUrl } from "./createIndexUrl.js";
import type { IndexAdmin, LiveIndex } from "./firestoreAdmin.js";

export interface HealSettings {
  allowedTargets: readonly IndexTarget[];
  /** Starfish's own project and database: refused even if listed. */
  own: IndexTarget;
  /** `indexAutoApply`. */
  autoApply: boolean;
  dryRun: boolean;
  dailyCap: number;
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
  /** Called with the operation's name right after the create succeeds and before any waiting: persist it. */
  onOperation: (operation: string, spec: IndexSpec) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type RepoFileState = "present" | "absent" | "unknown";

export type HealOutcome =
  | { outcome: "refused"; rule: string; reason: string }
  | { outcome: "switched-off"; reason: string }
  | { outcome: "dry-run"; spec: IndexSpec; repoFile: RepoFileState; live: "absent" | "building" | "ready" }
  | { outcome: "cap-reached"; spec: IndexSpec; created: number; cap: number }
  | { outcome: "ready"; spec: IndexSpec; repoFile: RepoFileState; created: boolean; operation?: string }
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

export async function healIndex(errorText: string, settings: HealSettings, deps: HealDeps): Promise<HealOutcome> {
  const url = findCreateIndexUrl(errorText);
  if (url === null) return { outcome: "refused", rule: "no-url", reason: "The error holds no create-index URL." };
  const parsed = parseCreateIndexUrl(url);
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
    return { outcome: "dry-run", spec, repoFile, live: live === undefined ? "absent" : live.state === "READY" ? "ready" : "building" };
  }

  if (live?.state === "READY") return { outcome: "ready", spec, repoFile, created: false };
  if (live !== undefined) return waitForIndex(spec, repoFile, settings, deps);

  const created = await deps.createdToday(targetKey);
  if (created >= settings.dailyCap) return { outcome: "cap-reached", spec, created, cap: settings.dailyCap };

  if (!(await allowed(deps))) return { outcome: "switched-off", reason: "The automation switch went off before the index was created." };
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
        ? { outcome: "ready", spec, repoFile, created: true, operation }
        : { outcome: "build-failed", spec, operation, reason: `Google reported error ${status.error.code}: ${status.error.message}` };
    }
    if (deps.now() >= deadline) return { outcome: "timeout", spec, operation };
    await deps.sleep(s.pollMs);
  }
}

/** An equal index was already building (an earlier attempt, or someone else): wait on its state, creating nothing. */
async function waitForIndex(spec: IndexSpec, repoFile: RepoFileState, s: HealSettings, deps: HealDeps): Promise<HealOutcome> {
  const deadline = deps.now() + s.maxWaitMs;
  for (;;) {
    await deps.sleep(s.pollMs);
    const found = (await deps.admin.list(spec)).find((l) => sameIndex(spec, l));
    if (found?.state === "READY") return { outcome: "ready", spec, repoFile, created: false };
    if (found === undefined || found.state === "NEEDS_REPAIR") {
      return { outcome: "build-failed", spec, reason: "The index that was building is gone or needs repair." };
    }
    if (deps.now() >= deadline) return { outcome: "timeout", spec };
  }
}
