import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  PUBLIC_SUMMARY,
  PUBLIC_SUMMARY_STAGES,
  isPublicEnvironment,
  publicEventId,
  publicLine,
  publicUrl,
  toPublicCycle,
  toPublicEvent,
  toPublicIncident,
} from "./publicView.js";
import { SEEDED_SECRETS } from "./ingest/testSecrets.js";
import { QUIET_BASIS } from "./indexheal/runtimeBasis.js";

const pub = { publicEnvironments: ["demo"] };
const t = (ms: number) => Timestamp.fromMillis(ms);
const NOW = Date.parse("2026-10-08T12:00:00Z");
const HOUR = 3600_000;

/** Free text that looks like personal data no redaction pattern knows: a name, an address, a phone and an id number. */
const PII = "Customer Jane Roe of 12 Elm Street called from 555-0100 about order 4417; SSN 123-45-6789";
const PII_MARKERS = ["Jane Roe", "Elm Street", "555-0100", "123-45-6789", "order 4417"];
/** Every seeded credential, and an email, after the PII. */
const SECRETS = Object.values(SEEDED_SECRETS);
const EMAIL = "jane.roe@example.com";
const POISON = `${PII} ${EMAIL} ${SECRETS.join(" ")}`;
/** The part of each secret no redaction leaves behind: the longest run without whitespace. */
const secretCores = SECRETS.map((s) => s.split(/\s+/).sort((a, b) => b.length - a.length)[0]!);

function expectClean(value: unknown, opts: { allowPii?: boolean } = {}) {
  const text = JSON.stringify(value);
  for (const s of secretCores) expect(text).not.toContain(s);
  expect(text).not.toContain(EMAIL);
  if (!opts.allowPii) for (const m of PII_MARKERS) expect(text).not.toContain(m);
}

const storedIncident = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  functionName: "ordersCreate",
  service: "orders",
  environment: "demo",
  errorType: "TypeError",
  errorMessage: "Cannot read properties of undefined (reading 'id')",
  errorName: "TypeError",
  errorCode: "internal",
  errorDetail: "at handler (orders.ts:12)",
  stackTrace: "TypeError: x\n    at handler (orders.ts:12:3)",
  httpStatus: 500,
  tenantId: "tenant-7",
  requestId: "req-1",
  sourceProjectId: "demo-app-1",
  occurrenceCount: 12,
  occurrencesByHour: { [String(Math.floor(NOW / HOUR))]: 4 },
  firstOccurredAt: t(NOW - 2 * HOUR),
  lastOccurredAt: t(NOW),
  createdAt: t(NOW - 2 * HOUR),
  updatedAt: t(NOW),
  status: "acknowledged",
  statusChangedBy: "uid-operator-1",
  fingerprint: "a".repeat(64),
  triageState: "pending",
  recurrenceCount: 1,
  lastRecurredAt: t(NOW - HOUR),
  lastResolution: { githubIssueNumber: 7, githubIssueUrl: "https://github.com/o/r/issues/7", resolvedBy: "uid-operator-1", resolvedAt: t(NOW - 3 * HOUR) },
  githubIssueNumber: 9,
  githubIssueUrl: "https://github.com/o/r/issues/9",
  githubPrNumber: 10,
  githubPrUrl: "https://github.com/o/r/pull/10",
  githubPrState: "open",
  retriageRequestedBy: "uid-operator-1",
  ...over,
});

describe("isPublicEnvironment", () => {
  it("is only a label on the list", () => {
    expect(isPublicEnvironment(pub, "demo")).toBe(true);
    expect(isPublicEnvironment(pub, "prod")).toBe(false);
    expect(isPublicEnvironment(pub, "")).toBe(false);
    expect(isPublicEnvironment(pub, undefined)).toBe(false);
    expect(isPublicEnvironment({ publicEnvironments: [] }, "demo")).toBe(false);
  });
});

describe("toPublicIncident", () => {
  it("copies exactly the allowlisted fields, and marks the copy", () => {
    const copy = toPublicIncident(storedIncident(), pub)!;
    expect(Object.keys(copy).sort()).toEqual(
      [
        "publicView",
        "environment",
        "status",
        "firstOccurredAt",
        "lastOccurredAt",
        "functionName",
        "service",
        "errorType",
        "errorMessage",
        "errorName",
        "errorCode",
        "triageState",
        "occurrenceCount",
        "occurrencesByHour",
        "recurrenceCount",
        "lastRecurredAt",
        "githubIssueNumber",
        "githubIssueUrl",
        "githubPrNumber",
        "githubPrUrl",
        "githubPrState",
        "lastResolution",
      ].sort()
    );
    expect(copy).toMatchObject({ publicView: 1, environment: "demo", status: "acknowledged", errorMessage: "Cannot read properties of undefined (reading 'id')" });
    expect(copy.lastResolution).toEqual({ githubIssueNumber: 7, githubIssueUrl: "https://github.com/o/r/issues/7" });
    expect((copy.lastOccurredAt as Timestamp).toMillis()).toBe(NOW);
  });

  it("leaves out detail, traces, tenant and request ids, the source project, the fingerprint and who did what", () => {
    const copy = toPublicIncident(storedIncident(), pub)!;
    for (const k of ["errorDetail", "stackTrace", "httpStatus", "tenantId", "requestId", "sourceProjectId", "fingerprint", "statusChangedBy", "retriageRequestedBy", "createdAt", "updatedAt"]) {
      expect(copy).not.toHaveProperty(k);
    }
  });

  it("has no copy outside a public environment, for a retired incident, or for one missing what a row needs", () => {
    expect(toPublicIncident(storedIncident({ environment: "prod" }), pub)).toBeNull();
    expect(toPublicIncident(storedIncident({ retired: true }), pub)).toBeNull();
    expect(toPublicIncident(storedIncident({ status: "bogus" }), pub)).toBeNull();
    expect(toPublicIncident(storedIncident({ lastOccurredAt: "yesterday" }), pub)).toBeNull();
    expect(toPublicIncident(undefined, pub)).toBeNull();
    expect(toPublicIncident(storedIncident(), { publicEnvironments: [] })).toBeNull();
  });

  it("bounds the title to its first line, of at most 200 characters", () => {
    const copy = toPublicIncident(storedIncident({ errorMessage: `first line\t${"x".repeat(400)}\nsecond line` }), pub)!;
    expect(copy.errorMessage).toMatch(/^first line x+$/);
    expect((copy.errorMessage as string).length).toBe(200);
    // The first line that holds text.
    expect(toPublicIncident(storedIncident({ errorMessage: "\n  \r\nthe title\nmore" }), pub)!.errorMessage).toBe("the title");
  });

  it("never shows a stack trace a stored title still carries (#361)", () => {
    // Stored before ingest split the stack off the message: the logger's `new Error(message).stack`.
    const stored =
      "Error: orders-getOrder failed: Cannot read properties of undefined (reading 'toString')\n" +
      "    at entryFromArgs (/workspace/node_modules/firebase-functions/lib/logger/index.js:133:19)\n" +
      "    at Object.error (/workspace/node_modules/firebase-functions/lib/logger/index.js:164:11)";
    const copy = toPublicIncident(storedIncident({ errorMessage: stored }), pub)!;
    expect(copy.errorMessage).toBe("Error: orders-getOrder failed: Cannot read properties of undefined (reading 'toString')");
    expect(copy.errorMessage).not.toMatch(/ at /);
    // A text that is nothing but frames has no title to show.
    expect(toPublicIncident(storedIncident({ errorMessage: "    at x (/a.js:1:2)\n    at y (/b.js:3:4)" }), pub)!).not.toHaveProperty("errorMessage");
  });

  it("keeps the newest buckets the store keeps, and only real ones", () => {
    const hour = Math.floor(NOW / HOUR);
    const buckets: Record<string, unknown> = { junk: 3, [String(hour)]: -1 };
    for (let i = 0; i < 300; i++) buckets[String(hour - i - 1)] = 1;
    const kept = toPublicIncident(storedIncident({ occurrencesByHour: buckets }), pub)!.occurrencesByHour as Record<string, number>;
    expect(Object.keys(kept)).toHaveLength(169);
    expect(kept).toHaveProperty(String(hour - 1));
    expect(kept).not.toHaveProperty("junk");
    expect(kept).not.toHaveProperty(String(hour));
  });

  it("says Monitoring-only without copying the fingerprint, and keeps the readings' provenance and counts", () => {
    const copy = toPublicIncident(
      storedIncident({
        fingerprint: "mon-abc",
        monitoringCount: 5,
        lastMonitoring: [
          { source: "monitoring", metricType: "cloudfunctions.googleapis.com/function/execution_count", resourceType: "cloud_function", projectId: "demo-app-1", windowStart: t(0), windowEnd: t(1), failureCount: 5, capped: true },
          { metricType: "x", resourceType: "y", projectId: "Not A Project", windowStart: t(0), windowEnd: t(1), failureCount: 1 },
        ],
      }),
      pub
    )!;
    expect(copy.signalSource).toBe("monitoring");
    expect(copy.monitoringCount).toBe(5);
    expect(copy.lastMonitoring).toHaveLength(1);
    expect(copy).not.toHaveProperty("fingerprint");
  });

  it("names an overflow or a Cloud Run quota incident's kind too, by field or namespace, never a plain log one (#435)", () => {
    expect(toPublicIncident(storedIncident({ signalSource: "overflow", fingerprint: "ovf-abc" }), pub)!.signalSource).toBe("overflow");
    expect(toPublicIncident(storedIncident({ fingerprint: "pq-abc" }), pub)!.signalSource).toBe("platform-quota");
    expect(toPublicIncident(storedIncident({ signalSource: "log", fingerprint: "0123456789abcdef" }), pub)).not.toHaveProperty("signalSource");
    expect(toPublicIncident(storedIncident({ signalSource: "something-else" }), pub)).not.toHaveProperty("signalSource");
  });

  it("drops a value that is not the shape its field should hold", () => {
    const copy = toPublicIncident(
      storedIncident({
        errorName: "Error from Jane Roe",
        errorCode: "[redacted-secret]",
        errorType: "a sentence, not a type",
        githubIssueUrl: "javascript:alert(1)",
        githubPrUrl: "https://user:pass@github.com/o/r/pull/10",
        githubPrState: "maybe",
        triageState: "thinking",
        occurrenceCount: -3,
      }),
      pub
    )!;
    for (const k of ["errorName", "errorCode", "errorType", "githubIssueUrl", "githubPrUrl", "githubPrState", "triageState", "occurrenceCount"]) {
      expect(copy).not.toHaveProperty(k);
    }
  });
});

const storedCycle = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  incidentId: "inc1",
  environment: "demo",
  recurrence: 0,
  state: "done",
  attempts: 2,
  owner: "agent-host-1234-abcd",
  leaseExpiresAt: null,
  deadlineAt: t(NOW + HOUR),
  eventCount: 6,
  modelCalls: 3,
  revisions: 1,
  startDays: ["2026-10-08"],
  stage: "pr",
  path: "pr",
  outcome: "notify:counter-check-zero",
  createdAt: t(NOW - HOUR),
  updatedAt: t(NOW),
  settledAt: t(NOW - 1000),
  reconsiderCount: 2,
  reconsideredAt: [t(NOW - 2 * HOUR)],
  summary: {
    triage: { decision: "act", rule: "model-act", reason: "r", suspectedCause: "c", model: "gemini-3.1-pro-preview", counterCount: null, counterRead: true, counterFilter: "severity>=ERROR" },
    fix: { outcome: "proposed", rule: "ok", model: "gemini-3.1-pro-preview", rootCause: "missing await", testAdded: true, risk: "low", revisions: 1, alternative1: "retry" },
    verify: { status: "passed", rule: "passed", patchSha256: "b".repeat(64), baseRevision: "c".repeat(40), files: 2, exitCode: 0, durationMs: 4200, isolation: "github-actions" },
    review: { verdict: "approve", rule: "ok", model: "gemini-3.1-pro-preview", attacks: 2, held: 2, flagged: 0, broken: 0, patchSha256: "b".repeat(64), attack1: "held: null input | fine" },
    issue: { state: "opened", number: 30, url: "https://github.com/o/r/issues/30" },
    pr: { opened: true, number: 42, url: "https://github.com/o/r/pull/42", patchSha256: "b".repeat(64) },
    prState: { number: 42, state: "merged", mergedAt: "2026-10-08T11:00:00.000Z", closedAt: null, headSha: "d".repeat(40), checks: "passed", checksPassed: 1, checksRequired: 1, checkedAt: "2026-10-08T11:30:00.000Z" },
    recovery: { state: "recovered", reason: "waiting-for-window", mergeCommitSha: "e".repeat(40), mergedAt: "2026-10-08T11:00:00.000Z", deployedAt: "2026-10-08T11:06:00.000Z", windowEnd: "2026-10-08T12:11:00.000Z", expectedOccurrences: 10, baselineTaken: true, baselinePerHour: 10, baselineHours: 24, deploymentId: 26, deploymentSha: "e".repeat(40), readError: "forbidden", checkedAt: "2026-10-08T12:30:00.000Z" },
    notify: { state: "sent", attempts: 1 },
    merge: { state: "pending" },
    escalation: { state: "calling", to: "+1•••0100" },
  },
  decision: { rule: "model-decline", reason: "earlier" },
  history: [{ reason: "older" }],
  releasedBecause: "model-error",
  ...over,
});

describe("toPublicCycle", () => {
  it("copies the cycle's state and times, and from its run record only the allowlisted keys", () => {
    const copy = toPublicCycle(storedCycle(), pub)!;
    expect(Object.keys(copy).sort()).toEqual(
      ["publicView", "incidentId", "environment", "state", "createdAt", "updatedAt", "settledAt", "leaseExpiresAt", "deadlineAt", "summary", "recurrence", "stage", "path", "outcome", "attempts", "eventCount", "reconsiderCount"].sort()
    );
    expect(copy.leaseExpiresAt).toBeNull();
    const summary = copy.summary as Record<string, Record<string, unknown>>;
    expect(Object.keys(summary).sort()).toEqual(["fix", "issue", "pr", "prState", "recovery", "review", "triage", "verify"]);
    expect(summary.issue).toEqual({ state: "opened", number: 30, url: "https://github.com/o/r/issues/30" });
    expect(summary.triage).toEqual({ decision: "act", rule: "model-act", model: "gemini-3.1-pro-preview", counterCount: null, counterRead: true });
    // When it settled and how many times it was reopened (#436): a time and a count.
    expect(copy.settledAt).toEqual(t(NOW - 1000));
    expect(copy.reconsiderCount).toBe(2);
    expect(summary.fix).toEqual({ outcome: "proposed", rule: "ok", model: "gemini-3.1-pro-preview", testAdded: true, revisions: 1 });
    expect(summary.verify).toMatchObject({ rule: "passed", isolation: "github-actions" });
    expect(summary.review).toEqual({ verdict: "approve", rule: "ok", model: "gemini-3.1-pro-preview", attacks: 2, held: 2, flagged: 0, broken: 0, patchSha256: "b".repeat(64) });
    expect(summary.pr).toEqual({ opened: true, number: 42, url: "https://github.com/o/r/pull/42", patchSha256: "b".repeat(64) });
    expect(summary.prState).toMatchObject({ state: "merged", closedAt: null, checks: "passed" });
    // The recovery answer, why and when: never the error's rate, the deployment's id or what GitHub could not be read for (#390).
    expect(summary.recovery).toEqual({ state: "recovered", reason: "waiting-for-window", mergeCommitSha: "e".repeat(40), mergedAt: "2026-10-08T11:00:00.000Z", deployedAt: "2026-10-08T11:06:00.000Z", windowEnd: "2026-10-08T12:11:00.000Z", expectedOccurrences: 10, checkedAt: "2026-10-08T12:30:00.000Z" });
  });

  it("keeps a failed filing's state, never its reason, and drops a link that is not https", () => {
    const failed = toPublicCycle(storedCycle({ summary: { issue: { state: "failed", reason: "github-error" } } }), pub)!;
    expect((failed.summary as Record<string, Record<string, unknown>>).issue).toEqual({ state: "failed" });
    const http = toPublicCycle(storedCycle({ summary: { issue: { state: "opened", number: 30, url: "http://github.com/o/r/issues/30" } } }), pub)!;
    expect((http.summary as Record<string, Record<string, unknown>>).issue).toEqual({ state: "opened", number: 30 });
  });

  it("drops a settle time or a reopen count that is not a time or a count", () => {
    const copy = toPublicCycle(storedCycle({ settledAt: "2026-10-08T11:00:00Z", reconsiderCount: -1 }), pub)!;
    expect(copy).not.toHaveProperty("settledAt");
    expect(copy).not.toHaveProperty("reconsiderCount");
  });

  it("leaves out the lease holder, the spend, the decline decision and its history", () => {
    const copy = toPublicCycle(storedCycle(), pub)!;
    for (const k of ["owner", "modelCalls", "revisions", "startDays", "decision", "history", "releasedBecause", "reconsideredAt"]) expect(copy).not.toHaveProperty(k);
  });

  it("keeps how far triage went and the admin's merge case (engine tokens), never the model's reason", () => {
    const copy = toPublicCycle(storedCycle({ summary: { triage: { decision: "act", rule: "model-act", level: "merge", mergeCase: "missing-await", reason: "the model's words" } } }), pub)!;
    expect((copy.summary as Record<string, Record<string, unknown>>).triage).toEqual({ decision: "act", rule: "model-act", level: "merge", mergeCase: "missing-await" });
    const none = toPublicCycle(storedCycle({ summary: { triage: { decision: "act", rule: "model-act", level: "fix", mergeCase: null } } }), pub)!;
    expect((none.summary as Record<string, Record<string, unknown>>).triage).toEqual({ decision: "act", rule: "model-act", level: "fix", mergeCase: null });
  });

  it("keeps which rule found the fixer's source (#259): engine tokens and a count", () => {
    const copy = toPublicCycle(storedCycle({ summary: { fix: { outcome: "declined", rule: "fixer-declined", source: "function-name", sourceFiles: 1, sourceSearch: "found", sourceImports: 2 } } }), pub)!;
    expect((copy.summary as Record<string, Record<string, unknown>>).fix).toEqual({ outcome: "declined", rule: "fixer-declined", source: "function-name", sourceFiles: 1, sourceSearch: "found", sourceImports: 2 });
  });

  it("keeps a stage that recorded only what may not be shown, so it still reads as recorded", () => {
    const copy = toPublicCycle(storedCycle({ summary: { fix: { rootCause: "words only" } } }), pub)!;
    expect(copy.summary).toEqual({ fix: {} });
  });

  it("keeps an index heal's runtime basis only when it is one of the engine's own sentences", () => {
    const index = (runtimeBasis: string) => (toPublicCycle(storedCycle({ path: "index", summary: { index: { state: "ready", runtime: "healed", runtimeBasis, project: "demo-app-1", fields: "status ASC, createdAt DESC" } } }), pub)!.summary as Record<string, Record<string, unknown>>).index!;
    expect(index(QUIET_BASIS)).toMatchObject({ runtime: "healed", runtimeBasis: QUIET_BASIS, project: "demo-app-1", fields: "status ASC, createdAt DESC" });
    expect(index("anything else")).not.toHaveProperty("runtimeBasis");
  });

  it("has no copy outside a public environment, or for a document that is not a cycle", () => {
    expect(toPublicCycle(storedCycle({ environment: "prod" }), pub)).toBeNull();
    expect(toPublicCycle(storedCycle({ state: "weird" }), pub)).toBeNull();
    expect(toPublicCycle(storedCycle({ incidentId: "a/b" }), pub)).toBeNull();
    expect(toPublicCycle(undefined, pub)).toBeNull();
  });

  it("covers only what the UI renders: every allowlisted stage is one the evidence or Runs page reads", () => {
    expect(Object.keys(PUBLIC_SUMMARY).sort()).toEqual(["fix", "index", "issue", "pr", "prState", "recovery", "review", "triage", "verify"]);
  });
});

describe("toPublicEvent", () => {
  const stored = (over: Record<string, unknown> = {}) => ({ seq: 3, environment: "demo", at: t(NOW), stage: "pr", type: "opened", summary: "Pull request opened", data: { rule: "ok", number: 42 }, ...over });

  it("copies the event's place and kind, never its data; the summary only for the engine's own stages", () => {
    expect(toPublicEvent("inc1_r0", stored(), pub)).toEqual({ publicView: 1, cycleId: "inc1_r0", environment: "demo", seq: 3, at: t(NOW), stage: "pr", type: "opened", summary: "Pull request opened" });
    for (const stage of ["triage", "fix", "verify", "review", "before", "escalation", "something-new"]) {
      expect(toPublicEvent("inc1_r0", stored({ stage }), pub)).not.toHaveProperty("summary");
    }
    for (const stage of PUBLIC_SUMMARY_STAGES) expect(toPublicEvent("inc1_r0", stored({ stage }), pub)).toHaveProperty("summary");
  });

  it("has no copy outside a public environment, or without its place", () => {
    expect(toPublicEvent("inc1_r0", stored({ environment: "prod" }), pub)).toBeNull();
    expect(toPublicEvent("inc1_r0", stored({ seq: "3" }), pub)).toBeNull();
    expect(toPublicEvent("inc1_r0", stored({ at: undefined }), pub)).toBeNull();
    expect(toPublicEvent("inc/1", stored(), pub)).toBeNull();
  });

  it("names the copy by its cycle and its own id", () => {
    expect(publicEventId("inc1_r0", "000003")).toBe("inc1_r0_000003");
  });
});

describe("helpers", () => {
  it("publicLine: one redacted, bounded line, or nothing", () => {
    expect(publicLine("a\nb c\u0007d", 100)).toBe("a b c d");
    expect(publicLine("   ", 100)).toBeUndefined();
    expect(publicLine(42, 100)).toBeUndefined();
    expect(publicLine(`token=${"z".repeat(30)}`, 100)).not.toContain("z".repeat(30));
  });

  it("publicUrl: https only, no credentials anywhere in it", () => {
    expect(publicUrl("https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
    expect(publicUrl("http://github.com/o/r/pull/1")).toBeUndefined();
    expect(publicUrl("https://u:p@github.com/x")).toBeUndefined();
    expect(publicUrl(`https://github.com/x?access_token=${"a".repeat(20)}`)).toBeUndefined();
    expect(publicUrl(SEEDED_SECRETS.slackHook)).toBeUndefined();
    expect(publicUrl(`https://github.com/${"a".repeat(400)}`)).toBeUndefined();
  });
});

describe("seeded secrets and personal data in every source field (#18)", () => {
  /** Every string in `v`, at any depth, replaced by POISON. */
  function poison(v: unknown): unknown {
    if (typeof v === "string") return POISON;
    if (Array.isArray(v)) return v.map(poison);
    if (v instanceof Timestamp) return v;
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, poison(x)]));
    return v;
  }

  it("an incident: nothing of it reaches the copy but the title, where the secrets are redacted", () => {
    // Every string field poisoned except the few the copy needs to exist at all (status, environment, the times).
    const source = { ...(poison(storedIncident()) as Record<string, unknown>), environment: "demo", status: "new" };
    const copy = toPublicIncident(source, pub)!;
    expect(copy).not.toBeNull();
    const { errorMessage, functionName, service, ...rest } = copy;
    expectClean(rest);
    // The title, the function and the service are the free text a copy keeps: bounded, one line, redacted. Redaction is
    // pattern matching, so free-form personal data in them gets through (the documented limit: keep the demo synthetic).
    expectClean({ errorMessage, functionName, service }, { allowPii: true });
    expect(String(errorMessage).length).toBeLessThanOrEqual(200);
  });

  it("a cycle: no secret and no personal data in the copy at all", () => {
    const source = { ...(poison(storedCycle()) as Record<string, unknown>), environment: "demo", state: "done", incidentId: "inc1" };
    // The allowlisted keys of the run record hold the poison too: their shapes reject it.
    const copy = toPublicCycle(source, pub)!;
    expect(copy).not.toBeNull();
    expectClean(copy);
  });

  it("an event: no secret and no personal data from a model's stage; an engine stage's line is redacted", () => {
    for (const stage of ["triage", "fix", "verify", "review", "before", "escalation"]) {
      const copy = toPublicEvent("inc1_r0", { seq: 1, environment: "demo", at: t(NOW), stage, type: POISON, summary: POISON, data: { reason: POISON } }, pub)!;
      expectClean(copy);
    }
    const engine = toPublicEvent("inc1_r0", { seq: 1, environment: "demo", at: t(NOW), stage: "pr", type: POISON, summary: POISON, data: { reason: POISON } }, pub)!;
    expect(engine).not.toHaveProperty("type");
    expect(engine).not.toHaveProperty("data");
    // The engine writes these lines from its own words; anything credential-shaped in one is still redacted.
    expectClean(engine, { allowPii: true });
  });
});
