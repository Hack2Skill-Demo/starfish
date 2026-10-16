/**
 * Incidents — the operator view of the incident store. Browse, filter, and
 * triage the incidents the engine ingests.
 *
 *  - "Service" values come from each deployment's STARFISH_SERVICE_PATTERNS, not
 *    a fixed list, so the filter lists what's present.
 *  - The expanded row shows the underlying cause (`errorDetail`) and the
 *    engine's triage state.
 *  - Under the error, the agent's run for the incident's current recurrence
 *    (`{id}_r{n}`): its state in the Runs page's words, triage's reason as
 *    recorded, and a link to the run (`useIncidentRuns`); the expanded row has
 *    the decision in full. "No agent run yet" only when every run was read.
 *  - GitHub issue / PR links appear when those fields exist, and only as https
 *    URLs. The agent copies them onto the incident when it files the issue or
 *    opens the PR, and the PR's later state when it reads it back
 *    (src/agent/incidentLinks.ts); the cycle's run record stays the source.
 */
import { Fragment, useState } from "react";
import { SyntheticBadge } from "../components/SyntheticBadge";
import { MonitoringOnlyBadge } from "../components/MonitoringOnlyBadge";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  RefreshCw,
  XCircle,
  CheckCircle,
  Check,
  EyeOff,
  RotateCcw,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Search,
  ArrowRight,
  Play,
} from "lucide-react";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import PageMeta from "../components/PageMeta";
import SettingsUnavailableNotice from "../components/SettingsUnavailableNotice";
import { EngineStatus } from "../components/EngineStatus";
import { DemoAppLink } from "../components/DemoAppLink";
import { RunIngestButton } from "../components/AdminActions";
import { toast } from "../components/ui/toast";
import { useAuth } from "../auth/authCore";
import { canOperate } from "../lib/dataSource";
import { asFilterValue } from "../lib/urlFilters";
import { formatDateTime, formatRelativeTime } from "../lib/formatters";
import { buildCloudLoggingUrl } from "../lib/cloudLoggingUrl";
import { useEnvironment } from "../lib/useSettings";
import { safeUrl } from "../lib/runsModel";
import type { IncidentRunView } from "../lib/incidentRun";
import { useIncidentRuns } from "../lib/useIncidentRuns";
import {
  INCIDENT_STATUSES,
  SCAN_LIMIT,
  applyAction,
  listIncidents,
  nextStatus,
  type IncidentAction,
  type IncidentRow,
  type IncidentStatus,
  type PrState,
} from "../lib/incidents";

const WINDOW_OPTIONS = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "72h", label: "Last 3 days", hours: 72 },
  { value: "168h", label: "Last 7 days", hours: 168 },
] as const;
type WindowValue = (typeof WINDOW_OPTIONS)[number]["value"];
const WINDOW_VALUES: readonly WindowValue[] = WINDOW_OPTIONS.map((o) => o.value);
const DEFAULT_WINDOW: WindowValue = "24h";

// Status colours follow docs/design/theme.md: error = needs action, warning =
// needs attention, info = in flight, success = done, gray = inactive. A
// regression is orange: it needs action like `new`, and must not read as one.
const STATUS_STYLES: Record<IncidentStatus, string> = {
  new: "bg-error-100 text-error-700 dark:bg-error-900/30 dark:text-error-400",
  acknowledged: "bg-warning-100 text-warning-700 dark:bg-warning-900/30 dark:text-warning-400",
  logged: "bg-info-100 text-info-800 dark:bg-info-900/30 dark:text-info-500",
  resolved: "bg-success-100 text-success-700 dark:bg-success-900/30 dark:text-success-400",
  recurred: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  ignored: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  new: "New",
  acknowledged: "Acknowledged",
  logged: "Logged",
  resolved: "Resolved",
  recurred: "Recurred",
  ignored: "Ignored",
};

// GitHub's own PR colours: open green, merged purple, closed-unmerged red.
const PR_STYLES: Record<PrState, string> = {
  open: "text-success-700 hover:text-success-800 dark:text-green-400",
  merged: "text-purple-600 hover:text-purple-700 dark:text-purple-400",
  closed: "text-red-600 hover:text-red-700 dark:text-red-400",
};

function PrIcon({ state }: { state?: PrState }) {
  if (state === "merged") return <GitMerge className="h-3 w-3" />;
  if (state === "closed") return <GitPullRequestClosed className="h-3 w-3" />;
  return <GitPullRequest className="h-3 w-3" />;
}

/**
 * The agent's run under the error: its state, triage's reason in one line (the whole of it in the tooltip and the
 * expanded row) and the way to the run. A strip rather than a column, so Status and Actions stay on screen.
 */
function AgentStrip({ view, functionName }: { view: IncidentRunView; functionName: string }) {
  // Not known yet (or the runs could not be read): nothing is said rather than "no run".
  if (view.kind === "unknown") return null;
  if (view.kind === "none") {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        <Play className="h-3.5 w-3.5" aria-hidden="true" />
        No agent run yet
      </p>
    );
  }
  return (
    <div className="mt-2 flex max-w-xs items-center gap-2 whitespace-nowrap rounded-md border border-gray-200 bg-gray-50 px-2 py-1 2xl:max-w-md dark:border-gray-700 dark:bg-gray-900/40">
      <Play className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true" />
      <span className="shrink-0">
        <Badge tone={view.status.tone}>{view.status.label}</Badge>
      </span>
      <span className="w-0 min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-400" title={view.reason}>
        {view.reason ?? view.decision ?? ""}
      </span>
      <Link
        to={view.href}
        aria-label={`Run for ${functionName}`}
        className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
      >
        View run
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </Link>
    </div>
  );
}

/** The expanded row's account of the agent's decision, in full. */
function AgentDecision({ view }: { view: Extract<IncidentRunView, { kind: "run" }> }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Agent decision</dt>
      <dd className="mt-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={view.status.tone}>{view.status.label}</Badge>
          {view.decision && <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{view.decision}</span>}
          {view.rule && (
            <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">{view.rule}</code>
          )}
        </div>
        {view.reason && <p className="whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{view.reason}</p>}
        <Link to={view.href} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
          Open the run <span className="font-mono text-xs">{view.runId}</span>
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </dd>
    </div>
  );
}

const selectClass =
  "h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 shadow-xs focus:border-brand-300 focus:outline-none focus:ring focus:ring-brand-500/10 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300";

/** Client-side filters over the fetched window. Pure, so the page logic is testable. */
export function filterRows(rows: IncidentRow[], f: { status: string; service: string; fn: string }): IncidentRow[] {
  const fn = f.fn.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!f.status || r.status === f.status) &&
      (!f.service || r.service === f.service) &&
      (!fn || r.functionName.toLowerCase().includes(fn))
  );
}

export default function Incidents() {
  const { user, roles, guest } = useAuth();
  // Every Starfish role may triage, and a public demo visitor where its open actions are on (through the admin API).
  const canTriage = canOperate(roles, guest);
  const queryClient = useQueryClient();

  const [searchParams, setSearchParams] = useSearchParams();
  const status = asFilterValue(searchParams.get("status"), INCIDENT_STATUSES);
  const fnSearch = searchParams.get("fn") ?? "";
  const service = searchParams.get("service") ?? "";
  const windowValue: WindowValue = asFilterValue(searchParams.get("window"), WINDOW_VALUES) || DEFAULT_WINDOW;
  const windowHours = WINDOW_OPTIONS.find((o) => o.value === windowValue)?.hours ?? 24;

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Incidents are filtered by the environment label, which a settings document can
  // override; wait for that to settle so the list never flashes the wrong label's.
  const { environment, ready, settingsUnavailable } = useEnvironment();
  const query = useQuery({
    queryKey: ["incidents", environment, windowHours],
    queryFn: () => listIncidents(windowHours, environment),
    enabled: ready,
  });
  const { isError, refetch, isFetching } = query;
  // A read that failed shows no figure, never the last one it had (#195, #356): TanStack Query keeps `data` after a
  // failed refetch, so the counts, the footer, the capped banner and the runs would otherwise go on showing it.
  const data = isError ? undefined : query.data;
  const isLoading = query.isLoading || !ready;
  const mutation = useMutation({
    mutationFn: ({ row, action }: { row: IncidentRow; action: IncidentAction }) =>
      applyAction(row, action, user?.uid ?? "unknown"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["incidents"] }),
  });

  const all = data?.rows ?? [];
  const rows = filterRows(all, { status, service, fn: fnSearch });
  const runOf = useIncidentRuns(environment, ready, rows);
  const services = [...new Set(all.map((r) => r.service))].sort();
  const statusCounts = Object.fromEntries(
    INCIDENT_STATUSES.map((s) => [s, all.filter((r) => r.status === s).length])
  ) as Record<IncidentStatus, number>;

  const setParam = (key: string, value: string, replace = false) =>
    setSearchParams(
      (prev) => {
        if (value) prev.set(key, value);
        else prev.delete(key);
        return prev;
      },
      { replace }
    );

  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleAction = async (row: IncidentRow, action: IncidentAction) => {
    try {
      setPendingId(row.id);
      await mutation.mutateAsync({ row, action });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Failed to ${action} incident`);
    } finally {
      setPendingId(null);
    }
  };

  const colCount = canTriage ? 7 : 6;

  return (
    <>
      <PageMeta title="Incidents | Starfish" description="Browse and triage production incidents" />
      <div className="space-y-6">
        {settingsUnavailable && <SettingsUnavailableNotice environment={environment} subject="incidents" />}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Incidents</h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Production errors from the last {windowHours}h, grouped by fingerprint
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="incidents-window">
              Time window
            </label>
            <select
              id="incidents-window"
              value={windowValue}
              onChange={(e) => setParam("window", e.target.value === DEFAULT_WINDOW ? "" : e.target.value)}
              className={selectClass}
            >
              {WINDOW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <RunIngestButton />
          </div>
        </div>

        {ready && <EngineStatus environment={environment} />}

        <DemoAppLink />

        {data?.capped && (
          <div className="flex items-start gap-3 rounded-lg border border-warning-200 bg-warning-50 p-4 text-sm text-warning-800 dark:border-warning-900/40 dark:bg-warning-900/10 dark:text-warning-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              Showing the newest <strong>{SCAN_LIMIT}</strong> incidents in the last {windowHours}h — there may be
              more. Counts reflect only this set. Narrow the window for a complete view.
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {(["", ...INCIDENT_STATUSES] as const).map((s) => (
            <button
              key={s || "all"}
              onClick={() => setParam("status", s)}
              className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                status === s
                  ? "bg-brand-700 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              }`}
            >
              {s ? `${STATUS_LABELS[s]}${data ? ` (${statusCounts[s]})` : ""}` : "All"}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <select
              aria-label="Filter by service"
              value={service}
              onChange={(e) => setParam("service", e.target.value)}
              className={selectClass}
            >
              <option value="">All services</option>
              {services.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-500 dark:text-gray-400">
                <Search className="h-4 w-4" />
              </div>
              <input
                type="text"
                aria-label="Filter by function name"
                placeholder="Filter by function…"
                value={fnSearch}
                onChange={(e) => setParam("fn", e.target.value, true)}
                className="rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-gray-500 focus:border-brand-300 focus:outline-none focus:ring focus:ring-brand-500/10 dark:border-gray-700 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-400"
              />
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-gray-600 dark:text-gray-400">
              <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
              Loading incidents…
            </div>
          ) : isError ? (
            <div role="alert" className="flex items-center justify-center py-12 text-error-500">
              <XCircle className="mr-2 h-5 w-5" />
              Failed to load incidents. Please try again.
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<CheckCircle className="h-6 w-6" />}
              title="No incidents"
              description={
                status
                  ? `No ${STATUS_LABELS[status].toLowerCase()} incidents in the last ${windowHours}h.`
                  : `No production errors in the last ${windowHours}h.`
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    {/* Status and Actions — what an operator needs — should stay on screen beside the open
                        sidebar from 1280px up, with no horizontal scroll (#214; the scroll container stays as
                        the fallback for, say, a very long unbroken function name). So: "First seen" only on wide
                        screens (Last seen's tooltip carries it everywhere); Error is the one elastic column, whose
                        message and run-strip reason truncate rather than set its width (w-0 + min-w-full / flex-1);
                        Count's header may wrap; and cells are padded px-3 inside the card's px-4 edge. */}
                    {["Function", "Error", `Count (${windowHours}h)`, "First seen", "Last seen", "Status"].map((h, i) => (
                      <th
                        key={h}
                        className={`py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 ${
                          i === 0 ? "pl-4 pr-3" : "px-3"
                        } ${h === "First seen" ? "hidden 2xl:table-cell" : ""} ${h.startsWith("Count") ? "" : "whitespace-nowrap"}`}
                      >
                        {h}
                      </th>
                    ))}
                    {canTriage && (
                      <th className="py-3 pl-3 pr-4 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        Actions
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {rows.map((row) => {
                    const busy = pendingId === row.id && mutation.isPending;
                    const isExpanded = expandedIds.has(row.id);
                    const run = runOf(row);
                    const hasDetail = Boolean(row.stackTrace || row.errorName || row.errorDetail || row.triageState) || run.kind === "run";
                    // Stored links are data: shown only when they are https URLs, as on Runs and the evidence page.
                    const issueUrl = safeUrl(row.githubIssueUrl);
                    const prUrl = safeUrl(row.githubPrUrl);
                    const previousIssueUrl = safeUrl(row.previousIssueUrl);
                    const logsUrl = buildCloudLoggingUrl({
                      functionName: row.functionName,
                      projectId: row.sourceProjectId,
                      lastOccurredAt: row.lastOccurredAt,
                      windowHours,
                    });
                    const actions = (["acknowledge", "resolve", "ignore", "reopen"] as const).filter(
                      (a) => nextStatus(row.status, a) !== null
                    );
                    return (
                      <Fragment key={row.id}>
                        <tr className="align-top hover:bg-gray-50 dark:hover:bg-gray-900/30">
                          <td className="py-3 pl-4 pr-3">
                            <div className="flex items-start gap-1.5">
                              <button
                                type="button"
                                onClick={() => toggleExpanded(row.id)}
                                disabled={!hasDetail}
                                aria-expanded={isExpanded}
                                aria-label={isExpanded ? "Hide incident details" : "Show incident details"}
                                className="mt-0.5 rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-default disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                              >
                                {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </button>
                              <div>
                                <p className="flex flex-wrap items-center gap-2 font-medium text-gray-900 dark:text-white">
                                  {row.functionName}
                                  {row.synthetic && <SyntheticBadge />}
                                  {row.monitoringOnly && <MonitoringOnlyBadge />}
                                </p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                  {row.service}
                                  {row.tenantId ? ` · ${row.tenantId}` : ""}
                                </p>
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                  <Link
                                    to={`/incidents/${encodeURIComponent(row.id)}`}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
                                    aria-label={`Evidence for ${row.functionName}`}
                                  >
                                    Evidence
                                  </Link>
                                  {logsUrl && (
                                    <a
                                      href={logsUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 text-xs font-medium text-info-800 hover:underline dark:text-info-500"
                                    >
                                      <ExternalLink className="h-3 w-3" />
                                      Logs
                                    </a>
                                  )}
                                  {issueUrl && (
                                    <a
                                      href={issueUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 text-xs font-medium text-info-800 hover:underline dark:text-info-500"
                                    >
                                      <CircleDot className="h-3 w-3" />
                                      {row.githubIssueNumber ? `#${row.githubIssueNumber}` : "Issue"}
                                    </a>
                                  )}
                                  {prUrl && (
                                    <a
                                      href={prUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className={`inline-flex items-center gap-1 text-xs font-medium hover:underline ${PR_STYLES[row.githubPrState ?? "open"]}`}
                                    >
                                      <PrIcon state={row.githubPrState} />
                                      {row.githubPrNumber ? `PR #${row.githubPrNumber}` : "PR"}
                                    </a>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="w-full px-3 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                                {row.errorType}
                              </span>
                              {row.errorName && row.errorName !== row.errorType && (
                                <span className="text-xs text-gray-500 dark:text-gray-400">{row.errorName}</span>
                              )}
                              {row.errorCode && <span className="text-xs text-gray-500 dark:text-gray-400">{row.errorCode}</span>}
                            </div>
                            <p className="mt-1 w-0 min-w-full truncate text-sm text-gray-600 dark:text-gray-400" title={row.errorMessage}>
                              {row.errorMessage}
                            </p>
                            <AgentStrip view={run} functionName={row.functionName} />
                          </td>
                          <td
                            className="px-3 py-3 text-sm text-gray-700 dark:text-gray-300"
                            title={`${row.occurrenceCount.toLocaleString()} all-time since first seen`}
                          >
                            {row.windowedCount.toLocaleString()}
                            {/* On a log incident, an annotation: the function's failures Monitoring counted in windows
                                where this incident also logged, not extra occurrences of it (#19). */}
                            {row.monitoringCount !== undefined && !row.monitoringOnly && (
                              <p
                                className="mt-1 text-xs text-gray-600 dark:text-gray-400"
                                title="Failed invocations of this function that Cloud Monitoring counted, summed over the windows it read"
                              >
                                Monitoring: {row.monitoringCount.toLocaleString()} failed
                              </p>
                            )}
                          </td>
                          <td className="hidden whitespace-nowrap px-3 py-3 text-sm text-gray-500 2xl:table-cell dark:text-gray-400" title={formatDateTime(row.firstOccurredAt)}>
                            {formatRelativeTime(row.firstOccurredAt)}
                          </td>
                          <td
                            className="whitespace-nowrap px-3 py-3 text-sm text-gray-500 dark:text-gray-400"
                            title={`${formatDateTime(row.lastOccurredAt)} · first seen ${formatRelativeTime(row.firstOccurredAt)}`}
                          >
                            {formatRelativeTime(row.lastOccurredAt)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3">
                            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[row.status]}`}>
                              {STATUS_LABELS[row.status]}
                            </span>
                            {/* Shown whenever it has ever regressed, not only while
                                recurred: a resolved incident that came back twice
                                is worth knowing about before trusting the fix. */}
                            {row.recurrenceCount > 0 && (
                              <p
                                className="mt-1 flex items-center gap-1 text-xs font-medium text-orange-700 dark:text-orange-400"
                                title={row.lastRecurredAt ? `Came back ${formatRelativeTime(row.lastRecurredAt)} after it was resolved` : "Came back after it was resolved"}
                              >
                                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                                {row.recurrenceCount === 1 ? "Regression" : `Regression ×${row.recurrenceCount}`}
                              </p>
                            )}
                            {row.recurrenceCount > 0 && previousIssueUrl && (
                              <a
                                href={previousIssueUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-medium text-orange-700 hover:underline dark:text-orange-400"
                              >
                                was {row.previousIssueNumber ? `#${row.previousIssueNumber}` : "the previous issue"}
                              </a>
                            )}
                          </td>
                          {canTriage && (
                            <td className="py-3 pl-3 pr-4">
                              <div className="flex items-center gap-1">
                                {busy ? (
                                  <RefreshCw className="h-4 w-4 animate-spin text-gray-500 dark:text-gray-400" />
                                ) : (
                                  actions.map((a) => {
                                    const Icon = { acknowledge: Check, resolve: CheckCircle, ignore: EyeOff, reopen: RotateCcw }[a];
                                    const label = a.charAt(0).toUpperCase() + a.slice(1);
                                    return (
                                      <button
                                        key={a}
                                        onClick={() => handleAction(row, a)}
                                        aria-label={`${label} ${row.functionName}`}
                                        title={label}
                                        className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                                      >
                                        <Icon className="h-4 w-4" />
                                      </button>
                                    );
                                  })
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                        {isExpanded && hasDetail && (
                          <tr className="bg-gray-50/70 dark:bg-gray-900/40">
                            <td colSpan={colCount} className="px-4 pb-4 pt-1">
                              <dl className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
                                {run.kind === "run" && <AgentDecision view={run} />}
                                {(
                                  [
                                    ["Message", row.errorMessage],
                                    ["Underlying cause", row.errorDetail],
                                    ["Error name", row.errorName],
                                    ["Triage", row.triageState],
                                  ] as const
                                ).map(([label, value]) =>
                                  value ? (
                                    <div key={label}>
                                      <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</dt>
                                      <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{value}</dd>
                                    </div>
                                  ) : null
                                )}
                                {row.stackTrace && (
                                  <div>
                                    <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Stack trace</dt>
                                    <dd>
                                      <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-900 p-3 text-xs leading-relaxed text-gray-100 dark:bg-gray-950">
                                        {row.stackTrace}
                                      </pre>
                                    </dd>
                                  </div>
                                )}
                              </dl>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {data && rows.length > 0 && (
            <div className="border-t border-gray-200 px-4 py-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              Showing {rows.length} incident{rows.length === 1 ? "" : "s"}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
