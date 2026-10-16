/**
 * The loop's index path (#11): a `MissingIndexError` incident is not triaged, drafted or reviewed by a model. When the
 * agent job wires the heal in (only when `STARFISH_INDEX_ALLOWED_TARGETS` lists a target), `runCycle` hands such an
 * incident here instead, and this file runs the gated executor (src/indexheal/heal.ts) inside the cycle's lease:
 *
 *   - every Firestore Admin call happens under the lease, and the attempt is recorded (fenced) BEFORE the one create,
 *     so a worker that lost its lease cannot create, and a crash after the create still counts against the daily cap;
 *   - the create operation's name is recorded (`summary.index.operation`) before any waiting, and a resumed attempt
 *     polls it instead of creating again; an attempt that reached the create and left nothing usable creates nothing;
 *   - `dryRun` (the default) reads the inventory and replays the configured query, and creates nothing;
 *   - after READY, the configured query must pass again; only then is the runtime marked `observing`, and the evidence
 *     pull request (a fixed template, the entry added to the repository's index file) is opened through the same opener
 *     as a code fix. Whether the heal held is decided later, after a quiet window (src/indexheal/observe.ts).
 *
 * The incident's GitHub issue is filed first (the loop's `fileIssue`: the same opener, idempotency and dry-run behaviour as
 * a triaged incident's), since every index cycle either acts or goes to a person. The evidence pull request references
 * it but does not close it: merging the index file changes nothing in production, and whether the heal held (and the
 * incident is resolved) stays a person's call.
 *
 * Every refusal or failure that needs a person ends the cycle waiting for one, and tells them (the loop's `handOver`).
 * A wait that runs out releases the lease, counted, so a later pass resumes polling; the cycle's attempt cap and
 * deadline bound that, and the loop tells a person when either gives the cycle up. Nothing here deletes an index.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import type { IndexSpec, IndexTarget } from "../indexheal/createIndexUrl.js";
import type { IndexAdmin } from "../indexheal/firestoreAdmin.js";
import { isOperationName } from "../indexheal/firestoreAdmin.js";
import { healIndex, specFromError, type HealSettings } from "../indexheal/heal.js";
import { indexFilePatch } from "../indexheal/indexFilePatch.js";
import type { ProbeVerdict } from "../indexheal/probe.js";
import { indexRootCause } from "../integrations/githubPr.js";
import { INDEX_MERGE_CASE } from "../settingsSchema.js";
import type { Incident } from "../types.js";
import { indexMergeRecordAtOpen } from "./autoMerge.js";
import type { CyclePath, CycleState, RunEvent } from "./cycle.js";
import type { LoopResult, LoopSubject, PullRequestRequest } from "./loop.js";
import { utcDay } from "./reconsider.js";

/** The class ingest gives a failed precondition that carries Google's create-index URL (src/ingest/classify.ts). */
export const MISSING_INDEX_ERROR = "MissingIndexError";

export const isIndexIncident = (incident: Incident): boolean => incident.errorType === MISSING_INDEX_ERROR;

/** What the agent job wires in to turn the index path on. Absent: a missing index goes through triage like anything else. */
export interface IndexHealWiring {
  /** Everything but `dryRun`, which is the cycle's own (the pass's settings snapshot). */
  settings: Omit<HealSettings, "dryRun">;
  admin: IndexAdmin;
  probe: (spec: IndexSpec) => Promise<ProbeVerdict>;
  sleep: (ms: number) => Promise<void>;
  /** The repository's index file, relative to its root (validated by config). */
  indexFilePath: string;
  /** The quiet window after READY before the heal may be called healed. */
  observeMinutes: number;
}

/** What the daily cap counts: one recorded create attempt per cycle, keyed by target and UTC day. */
export function capSlot(target: IndexTarget, now: Date): string {
  return `${target.project}/${target.database}|${utcDay(now)}`;
}

/**
 * How many create attempts were recorded for this target today, across every cycle and environment (the cap is per
 * target). One count aggregation on a single equality, so it needs no composite index. Throws when the store does.
 * Two workers on different cycles that count at the same moment can each pass, so the cap can be exceeded by the
 * number of index cycles running at once (one pass runs its cycles one at a time).
 */
export async function countIndexCreations(db: Firestore, cycleCollection: string, slot: string): Promise<number> {
  const snap = await db.collection(cycleCollection).where("summary.index.capSlot", "==", slot).count().get();
  return snap.data().count;
}

/**
 * The index file's text in the checkout: null when there is none, undefined when it cannot be read safely (not a
 * regular file, a symlink or a parent outside the checkout, too large, unreadable). Never throws.
 */
export async function readIndexFileText(dir: string, path: string): Promise<string | null | undefined> {
  const full = join(dir, path);
  try {
    const st = await lstat(full);
    if (!st.isFile() || st.size > 1_000_000) return undefined;
    const [root, real] = await Promise.all([realpath(dir), realpath(full)]);
    if (!real.startsWith(root + sep)) return undefined;
    return await readFile(full, "utf8");
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === "ENOENT" ? null : undefined;
  }
}

type Flat = Record<string, string | number | boolean | null>;

/** The loop's own helpers, bound to this cycle and its lease. */
export interface IndexPathContext {
  db: Firestore;
  cycleCollection: string;
  dryRun: boolean;
  cycleId: string;
  incidentId: string;
  loaded: LoopSubject;
  now: () => Date;
  wiring: IndexHealWiring;
  note: (event: RunEvent) => Promise<void>;
  finish: (state: Exclude<CycleState, "running">, outcome: string, path?: CyclePath) => Promise<LoopResult>;
  release: (reason: string) => Promise<LoopResult>;
  renew: () => Promise<void>;
  /** The loop's check before acting: an incident no longer open, or automation off. null: go on. */
  halted: () => Promise<LoopResult | null>;
  stopReason: () => Promise<string | null>;
  /**
   * Ends the cycle waiting for a person, after telling them (the loop's `handOver`): or, when the incident was closed or
   * automation turned off meanwhile, settles or pauses it as `halted` does, so it is never left waiting with nobody told.
   */
  handOver: (rule: string, reason: string, outcome: string, path: CyclePath) => Promise<LoopResult>;
  /**
   * Files (or finds again) the incident's GitHub issue: the loop's own path, recorded as `summary.issue`, nothing filed in
   * a dry run, a failure recorded and never fatal. Resolves to the issue's number, or undefined when none is filed.
   */
  fileIssue: (reason: string) => Promise<number | undefined>;
  /** Proves the lease is still held (throws when it is lost) and renews it when due. */
  beat: () => Promise<void>;
  openPullRequest?: (req: PullRequestRequest) => Promise<{ number: number; url: string; headSha?: string }>;
  /**
   * Whether the evidence pull request may be merged by Starfish: the admin listed the reserved `missing-index` merge case
   * and the merge switches allow it now (read fresh). Absent, or false: a person merges it.
   */
  indexMergeAllowed?: () => Promise<boolean>;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const fieldsText = (spec: IndexSpec) => spec.fields.map((f) => `${f.fieldPath} ${f.order}`).join(", ");

/** The keys of an earlier attempt's record that must survive every later record of the stage (it replaces the whole entry). */
const CARRIED = ["capSlot", "target", "attemptedAt", "operation"] as const;

export async function runIndexPath(ctx: IndexPathContext): Promise<LoopResult> {
  const stop = await ctx.halted();
  if (stop) return stop;
  const incident = ctx.loaded.subject.incident;
  const errorText = `${incident.message ?? ""}\n${incident.errorDetail ?? ""}`;

  // What an earlier attempt of this cycle recorded: its create attempt and operation, carried into every record after.
  const snap = await ctx.db.collection(ctx.cycleCollection).doc(ctx.cycleId).get();
  const prior = ((snap.data()?.summary as Record<string, unknown> | undefined)?.index ?? {}) as Record<string, unknown>;
  let mark: Flat = {};
  for (const k of CARRIED) if (typeof prior[k] === "string") mark[k] = prior[k];

  const parsed = specFromError(errorText);
  const spec = parsed.ok ? parsed.spec : undefined;
  const described: Flat = spec
    ? { project: spec.project, database: spec.database, collectionGroup: spec.collectionGroup, queryScope: spec.queryScope, fields: fieldsText(spec) }
    : {};
  const record = (fields: Flat): Flat => ({ ...described, ...mark, ...fields });
  const opPrefix = spec ? `projects/${spec.project}/databases/${spec.database}/operations/` : "\u0000";
  const priorOperation = isOperationName(mark.operation) && mark.operation.startsWith(opPrefix) ? mark.operation : undefined;

  await ctx.note({ stage: "index", type: "started", summary: "Checking the missing index and recovery gates, without a model", record: record({ state: "checking" }) });
  // Before any gate: a refusal tells a person, and their message links the issue. Only fixed words and the parsed spec.
  const issueNumber = await ctx.fileIssue(
    spec
      ? `Firestore refused a query on the collection group ${spec.collectionGroup} (fields: ${fieldsText(spec)}) because a composite index is missing. Google's error names the index, so no model writes a fix.`
      : "Firestore refused a query because a composite index is missing, but the error's create-index URL could not be used, so a person decides."
  );

  const outcome = await healIndex(
    errorText,
    { ...ctx.wiring.settings, dryRun: ctx.dryRun },
    {
      admin: ctx.wiring.admin,
      // The incident still open and automation on: what the loop asks before every step, asked again before the create.
      automationOn: async () => (await ctx.stopReason()) === null,
      readIndexFile: async () => {
        const text = await readIndexFileText(ctx.loaded.sourceDir, ctx.wiring.indexFilePath);
        if (text === undefined) return null;
        return text === null ? { indexes: [] } : (JSON.parse(text) as unknown);
      },
      createdToday: (target) => countIndexCreations(ctx.db, ctx.cycleCollection, capSlot(target, ctx.now())),
      onCreating: async (s) => {
        // Fenced, before the call: a worker without the lease stops here, and the attempt counts even if it crashes next.
        await ctx.renew();
        mark = { ...mark, capSlot: capSlot(s, ctx.now()), target: `${s.project}/${s.database}`, attemptedAt: ctx.now().toISOString() };
        await ctx.note({ stage: "index", type: "creating", summary: "Creating the one index (a single Admin API call)", record: record({ state: "creating" }) });
      },
      onOperation: async (operation) => {
        mark = { ...mark, operation };
        await ctx.note({ stage: "index", type: "building", summary: "Index is building", record: record({ state: "building" }) });
      },
      probe: ctx.wiring.probe,
      sleep: async (ms) => {
        await ctx.beat();
        await ctx.wiring.sleep(ms);
      },
      now: () => ctx.now().getTime(),
    },
    { ...(priorOperation !== undefined && { priorOperation }), priorAttempt: typeof mark.attemptedAt === "string" }
  );

  const human = async (rule: string, summary: string, reason: string, fields: Flat, path: CyclePath = "human"): Promise<LoopResult> => {
    await ctx.note({ stage: "index", type: rule, summary, record: record({ ...fields, rule, reason }) });
    return ctx.handOver(`index-${rule}`, reason, `index-${rule}`, path);
  };

  switch (outcome.outcome) {
    case "refused":
      return human(outcome.rule, `Refused: ${outcome.rule}`, outcome.reason, { state: "refused" });
    case "switched-off": {
      // The kill switch (or the incident closing) pauses or settles the cycle as anywhere else in the loop.
      const halted = await ctx.halted();
      if (halted) return halted;
      return human("switched-off", "Creating indexes is switched off", outcome.reason, { state: "switched-off" });
    }
    case "cap-reached":
      return human("cap-reached", "The daily index cap is reached", `${outcome.created} of ${outcome.cap} index creations recorded for this target today.`, {
        state: "cap-reached",
        created: outcome.created,
        cap: outcome.cap,
      });
    case "dry-run":
      await ctx.note({
        stage: "index",
        type: "dry-run",
        summary: "Would create this index; nothing created (dry run)",
        record: record({ state: "dry-run", live: outcome.live, probe: outcome.probe, repoFile: outcome.repoFile }),
      });
      return ctx.finish("waiting-human", "index-dry-run", "draft");
    case "index-limit":
      return human(
        "index-limit",
        "The database is at the configured index limit",
        `The target database already holds ${outcome.existing} composite indexes; the configured limit is ${outcome.limit}, so nothing was created.`,
        { state: "index-limit", existing: outcome.existing, limit: outcome.limit }
      );
    case "build-failed":
      return human("build-failed", "The index did not build", outcome.reason, { state: "build-failed" });
    case "timeout":
      await ctx.note({ stage: "index", type: "waiting", summary: "Still building; a later pass checks again", record: record({ state: "building" }) });
      return ctx.release("index-still-building");
    case "ready":
      break;
  }

  if (outcome.probe === "inconclusive") {
    // The replay could not say (the query could not run: UNAVAILABLE, a permission, the network): not "the query does not
    // pass" (#232). Released, counted, like a build still running: a later pass finds it READY and replays it again, and
    // the cycle's attempt cap and deadline bound that, telling a person when either gives it up.
    await ctx.note({
      stage: "index",
      type: "waiting",
      summary: "Index READY, but the replayed query could not be run; a later pass checks again",
      record: record({ state: "ready-unconfirmed", created: outcome.created, probe: "inconclusive" }),
    });
    return ctx.release("index-probe-inconclusive");
  }
  if (outcome.probe !== "passed") {
    return human("query-still-failing", "READY, but the configured query does not pass", "The index is READY but the replayed query did not pass, so it is not healed.", {
      state: "ready",
      created: outcome.created,
      probe: outcome.probe,
    });
  }

  const readyAt = ctx.now();
  const observeUntil = new Date(readyAt.getTime() + ctx.wiring.observeMinutes * 60_000);
  await ctx.note({
    stage: "index",
    type: "ready",
    summary: outcome.created ? "Index READY and the query passes again" : "Index already READY and the query passes",
    record: record({
      state: "ready",
      created: outcome.created,
      probe: "passed",
      repoFile: outcome.repoFile,
      // Runtime recovery, tracked apart from the repository: healed or not is decided after the window (observe.ts).
      runtime: "observing",
      readyAt: readyAt.toISOString(),
      observeUntil: observeUntil.toISOString(),
    }),
  });

  // ---- the evidence pull request: the same entry in the repository's index file ------------------------------------
  const notOpened = async (reason: string, state: Exclude<CycleState, "running">, summary: string): Promise<LoopResult> => {
    await ctx.note({ stage: "pr", type: "not-opened", summary, record: { opened: false, reason } });
    if (state === "waiting-human") return ctx.handOver(`index-pr-${reason}`, summary, `index-ready-${reason}`, "index");
    return ctx.finish(state, `index-ready-${reason}`, "index");
  };
  const path = ctx.wiring.indexFilePath;
  const before = await readIndexFileText(ctx.loaded.sourceDir, path);
  if (outcome.repoFile === "present") return notOpened("already-in-index-file", "done", "The repository's index file already has this index; nothing to open");
  if (before === undefined) return notOpened("index-file-unreadable", "waiting-human", "Index healed at runtime; the repository's index file could not be read, so no pull request");
  const patch = indexFilePatch(path, before, outcome.spec);
  if (!patch.ok) {
    if (patch.rule === "already-present") return notOpened("already-in-index-file", "done", "The repository's index file already has this index; nothing to open");
    return notOpened(`index-file-${patch.rule}`, "waiting-human", `Index healed at runtime; no pull request: ${patch.reason}`);
  }
  if (!ctx.openPullRequest) return notOpened("no-opener", "waiting-human", "Index healed at runtime; no pull request opener is configured");

  const halted = await ctx.halted();
  if (halted) return halted;
  await ctx.renew();
  const patchSha256 = sha256(patch.patch);
  const spec2 = outcome.spec;
  const pr = await ctx.openPullRequest({
    cycleId: ctx.cycleId,
    incidentId: ctx.incidentId,
    baseRevision: ctx.loaded.baseRevision,
    ...(issueNumber !== undefined && { issueNumber }),
    patch: patch.patch,
    patchSha256,
    rootCause: indexRootCause({ collectionGroup: spec2.collectionGroup, fields: spec2.fields }),
    risk: "Adds one entry to the index file; the index already exists in production.",
    index: {
      project: spec2.project,
      database: spec2.database,
      collectionGroup: spec2.collectionGroup,
      queryScope: spec2.queryScope,
      fields: spec2.fields,
      created: outcome.created,
      ...(outcome.operation !== undefined && { operation: outcome.operation }),
      indexFile: path,
      fileCreated: patch.created,
      readyAt: readyAt.toISOString(),
    },
  });
  await ctx.note({
    stage: "pr",
    type: "opened",
    summary: "Evidence pull request opened (index file entry)",
    data: { number: pr.number, patchSha256 },
    record: { opened: true, number: pr.number, url: pr.url, patchSha256 },
  });
  // Listed as a merge case, the evidence PR is an auto-merge candidate: the agent pass's merge step waits for its required
  // checks and merges it (autoMerge.ts). No model decided it: Google's error named the index, which already exists.
  if (ctx.indexMergeAllowed && (await ctx.indexMergeAllowed())) {
    const merge = indexMergeRecordAtOpen({ pr, patchSha256, indexFile: path, baseRevision: ctx.loaded.baseRevision, now: ctx.now() });
    await ctx.note({
      stage: "merge",
      type: String(merge.state),
      summary: merge.state === "pending" ? `Auto-merge candidate (${INDEX_MERGE_CASE}): waiting for the required checks` : `Not auto-merged: ${String(merge.reason)}`,
      data: { mergeCase: INDEX_MERGE_CASE },
      record: merge,
    });
  }
  return ctx.finish("done", "index-pr-opened", "index");
}
