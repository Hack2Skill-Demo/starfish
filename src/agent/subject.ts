/**
 * Turning a stored incident into what the loop works on (#74): the incident as the stages see it, the
 * independent log counter-check (the ingest does not store one, so it is taken here), a few recent samples,
 * and the repository files the stack trace names. Plain functions with the readers injected.
 *
 * Nothing read from the checkout is chosen by a path from a log: `pathsFromStack` only picks files that are in
 * the repository's own file list, and `readSourceFiles` still refuses anything that is not a plain file
 * inside the checkout, with no link anywhere on the way (one in the target repository could otherwise point at a mounted secret).
 */
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { DocumentData } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { fetchRecentErrorSamples, runLogCounterCheck, type EntryReader } from "../ingest/counterCheck.js";
import type { Incident } from "../types.js";
import type { SourceFile } from "./fixer.js";
import type { LoopSubject } from "./loop.js";
import { pathsFromStack } from "./pass.js";
import type { Checkout } from "./checkout.js";

/** Bytes read from one file: the fixer clips what it shows anyway, so reading more only costs memory. */
const MAX_READ_BYTES = 100_000;
const MAX_FILES = 5;

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const iso = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  const date = (v as { toDate?: () => Date } | null)?.toDate?.();
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
};

/** The stored incident as the stages read it. Optional fields are left out when absent: nothing is invented. */
export function incidentFromDoc(id: string, d: DocumentData): Incident {
  return {
    id,
    environment: text(d.environment) ?? "",
    ...(text(d.fingerprint) && { fingerprint: text(d.fingerprint) }),
    ...(text(d.functionName) && { functionName: text(d.functionName) }),
    ...(text(d.service) && { service: text(d.service) }),
    ...(text(d.errorType) && { errorType: text(d.errorType) }),
    ...(text(d.errorCode) && { errorCode: text(d.errorCode) }),
    ...(text(d.errorName) && { errorName: text(d.errorName) }),
    ...(text(d.errorDetail) && { errorDetail: text(d.errorDetail) }),
    ...(num(d.httpStatus) !== undefined && { httpStatus: num(d.httpStatus) }),
    ...(num(d.occurrenceCount) !== undefined && { occurrenceCount: num(d.occurrenceCount) }),
    ...(iso(d.firstOccurredAt) && { firstOccurredAt: iso(d.firstOccurredAt) }),
    ...(iso(d.lastOccurredAt) && { lastOccurredAt: iso(d.lastOccurredAt) }),
    ...(text(d.errorMessage) && { message: text(d.errorMessage) }),
    ...(text(d.stackTrace) && { stackTrace: text(d.stackTrace) }),
  };
}

/**
 * The named files, read from the checkout. A path that is not a regular file inside it (a link anywhere on the way, a
 * directory, a path that climbs out) is skipped, never followed; a long file is cut at `MAX_READ_BYTES`.
 */
export async function readSourceFiles(dir: string, paths: readonly string[]): Promise<SourceFile[]> {
  const root = await realpath(resolve(dir));
  const out: SourceFile[] = [];
  for (const path of paths.slice(0, MAX_FILES)) {
    const full = resolve(join(root, path));
    if (!full.startsWith(root + sep)) continue;
    try {
      // lstat looks at the last component only; a link in a directory on the way would still be followed
      // by open(), so the resolved path must be the path asked for, inside the checkout.
      if ((await realpath(full)) !== full) continue;
      const info = await lstat(full);
      if (!info.isFile()) continue;
      const handle = await open(full, "r");
      try {
        const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const content = buffer.subarray(0, bytesRead);
        if (content.includes(0)) continue; // not text
        out.push({ path, content: content.toString("utf8") });
      } finally {
        await handle.close();
      }
    } catch {
      // Unreadable: the fixer works with the files it has, or says it lacks the context.
    }
  }
  return out;
}

export type SubjectConfig = Pick<StarfishConfig, "logResourceTypes" | "ignoredMessages" | "excludedServices" | "patchExcludedPaths">;

/**
 * Everything the loop needs for one incident. The counter-check and the samples never throw (a Logging failure
 * is `null` and `[]`): triage is then told the check is MISSING, not zero, and defers instead of declining.
 */
export async function buildLoopSubject(
  cfg: SubjectConfig,
  logging: EntryReader,
  checkout: Checkout,
  incident: Incident,
  status: LoopSubject["subject"]["status"]
): Promise<LoopSubject> {
  const source = { logResourceTypes: cfg.logResourceTypes, ignoredMessages: cfg.ignoredMessages, excludedServices: cfg.excludedServices };
  const name = incident.functionName ?? "";
  const [counter, samples] = await Promise.all([
    runLogCounterCheck(logging, source, name),
    fetchRecentErrorSamples(logging, source, name),
  ]);
  const stacks = [incident.stackTrace, ...samples.map((s) => s.stack)].filter((s): s is string => typeof s === "string").join("\n");
  const paths = pathsFromStack(stacks, checkout.files, cfg.patchExcludedPaths);
  return {
    subject: { incident: { ...incident, ...(counter !== null && { logCounterCheck: counter }) }, status, samples },
    files: await readSourceFiles(checkout.dir, paths),
    sourceDir: checkout.dir,
    baseRevision: checkout.revision,
  };
}
