/**
 * Incidents — the operator view of the incident store. Browse, filter, and
 * triage the incidents the engine ingests.
 *
 *  - "Service" values come from each deployment's STARFISH_SERVICE_PATTERNS, not
 *    a fixed list, so the filter lists what's present.
 *  - The expanded row shows the underlying cause (`errorDetail`) and the
 *    engine's triage state.
 *  - GitHub issue / PR links appear when those fields exist. Nothing writes them
 *    yet: GitHub integration is design-only (docs/design/auto-merge-policy.md).
 */
import { Fragment, useState } from "react";
import { useSearchParams } from "react-router";
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
} from "lucide-react";
import { EmptyState } from "../components/ui/EmptyState";
import PageMeta from "../components/PageMeta";
import { toast } from "../components/ui/toast";
import { useAuth } from "../auth/authCore";
import { asFilterValue } from "../lib/urlFilters";
import { formatDateTime, formatRelativeTime } from "../lib/formatters";
import { buildCloudLoggingUrl } from "../lib/cloudLoggingUrl";
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
// needs attention, info = in flight, success = done, gray = inactive.
const STATUS_STYLES: Record<IncidentStatus, string> = {
  new: "bg-error-100 text-error-700 dark:bg-error-900/30 dark:text-error-400",
  acknowledged: "bg-warning-100 text-warning-700 dark:bg-warning-900/30 dark:text-warning-400",
  logged: "bg-info-100 text-info-700 dark:bg-info-900/30 dark:text-info-500",
  resolved: "bg-success-100 text-success-700 dark:bg-success-900/30 dark:text-success-400",
  ignored: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  new: "New",
  acknowledged: "Acknowledged",
  logged: "Logged",
  resolved: "Resolved",
  ignored: "Ignored",
};

// GitHub's own PR colours: open green, merged purple, closed-unmerged red.
const PR_STYLES: Record<PrState, string> = {
  open: "text-green-600 hover:text-green-700 dark:text-green-400",
  merged: "text-purple-600 hover:text-purple-700 dark:text-purple-400",
  closed: "text-red-600 hover:text-red-700 dark:text-red-400",
};

function PrIcon({ state }: { state?: PrState }) {
  if (state === "merged") return <GitMerge className="h-3 w-3" />;
  if (state === "closed") return <GitPullRequestClosed className="h-3 w-3" />;
  return <GitPullRequest className="h-3 w-3" />;
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
  const { user, roles } = useAuth();
  const canTriage = roles.length > 0; // every Starfish role may triage
  const queryClient = useQueryClient();

  const [searchParams, setSearchParams] = useSearchParams();
  const status = asFilterValue(searchParams.get("status"), INCIDENT_STATUSES);
  const fnSearch = searchParams.get("fn") ?? "";
  const service = searchParams.get("service") ?? "";
  const windowValue: WindowValue = asFilterValue(searchParams.get("window"), WINDOW_VALUES) || DEFAULT_WINDOW;
  const windowHours = WINDOW_OPTIONS.find((o) => o.value === windowValue)?.hours ?? 24;

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["incidents", windowHours],
    queryFn: () => listIncidents(windowHours),
  });
  const mutation = useMutation({
    mutationFn: ({ row, action }: { row: IncidentRow; action: IncidentAction }) =>
      applyAction(row, action, user?.uid ?? "unknown"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["incidents"] }),
  });

  const all = data?.rows ?? [];
  const rows = filterRows(all, { status, service, fn: fnSearch });
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Incidents</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
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
              className="flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

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
                  ? "bg-brand-500 text-white"
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
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
                <Search className="h-4 w-4" />
              </div>
              <input
                type="text"
                aria-label="Filter by function name"
                placeholder="Filter by function…"
                value={fnSearch}
                onChange={(e) => setParam("fn", e.target.value, true)}
                className="rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-brand-300 focus:outline-none focus:ring focus:ring-brand-500/10 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
              />
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-gray-400">
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
                    {/* "First seen" only on wide screens: at laptop widths it would push
                        Status and Actions — what an operator needs — off-screen.
                        Last seen's tooltip carries it everywhere. */}
                    {["Function", "Error", `Count (${windowHours}h)`, "First seen", "Last seen", "Status"].map((h) => (
                      <th
                        key={h}
                        className={`whitespace-nowrap px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 ${
                          h === "First seen" ? "hidden 2xl:table-cell" : ""
                        }`}
                      >
                        {h}
                      </th>
                    ))}
                    {canTriage && (
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        Actions
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {rows.map((row) => {
                    const busy = pendingId === row.id && mutation.isPending;
                    const isExpanded = expandedIds.has(row.id);
                    const hasDetail = Boolean(row.stackTrace || row.errorName || row.errorDetail || row.triageState);
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
                          <td className="px-4 py-3">
                            <div className="flex items-start gap-1.5">
                              <button
                                type="button"
                                onClick={() => toggleExpanded(row.id)}
                                disabled={!hasDetail}
                                aria-expanded={isExpanded}
                                aria-label={isExpanded ? "Hide incident details" : "Show incident details"}
                                className="mt-0.5 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:cursor-default disabled:opacity-30 dark:hover:bg-gray-700"
                              >
                                {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </button>
                              <div>
                                <p className="font-medium text-gray-900 dark:text-white">{row.functionName}</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                  {row.service}
                                  {row.tenantId ? ` · ${row.tenantId}` : ""}
                                </p>
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                  {logsUrl && (
                                    <a
                                      href={logsUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 text-xs font-medium text-info-600 hover:underline dark:text-info-500"
                                    >
                                      <ExternalLink className="h-3 w-3" />
                                      Logs
                                    </a>
                                  )}
                                  {row.githubIssueUrl && (
                                    <a
                                      href={row.githubIssueUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 text-xs font-medium text-info-600 hover:underline dark:text-info-500"
                                    >
                                      <CircleDot className="h-3 w-3" />
                                      {row.githubIssueNumber ? `#${row.githubIssueNumber}` : "Issue"}
                                    </a>
                                  )}
                                  {row.githubPrUrl && (
                                    <a
                                      href={row.githubPrUrl}
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
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                                {row.errorType}
                              </span>
                              {row.errorName && row.errorName !== row.errorType && (
                                <span className="text-xs text-gray-500 dark:text-gray-400">{row.errorName}</span>
                              )}
                              {row.errorCode && <span className="text-xs text-gray-400">{row.errorCode}</span>}
                            </div>
                            <p className="mt-1 max-w-xs truncate text-sm text-gray-600 2xl:max-w-md dark:text-gray-400" title={row.errorMessage}>
                              {row.errorMessage}
                            </p>
                          </td>
                          <td
                            className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300"
                            title={`${row.occurrenceCount.toLocaleString()} all-time since first seen`}
                          >
                            {row.windowedCount.toLocaleString()}
                          </td>
                          <td className="hidden whitespace-nowrap px-4 py-3 text-sm text-gray-500 2xl:table-cell dark:text-gray-400" title={formatDateTime(row.firstOccurredAt)}>
                            {formatRelativeTime(row.firstOccurredAt)}
                          </td>
                          <td
                            className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400"
                            title={`${formatDateTime(row.lastOccurredAt)} · first seen ${formatRelativeTime(row.firstOccurredAt)}`}
                          >
                            {formatRelativeTime(row.lastOccurredAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[row.status]}`}>
                              {STATUS_LABELS[row.status]}
                            </span>
                          </td>
                          {canTriage && (
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1">
                                {busy ? (
                                  <RefreshCw className="h-4 w-4 animate-spin text-gray-400" />
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
                                        className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700"
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
