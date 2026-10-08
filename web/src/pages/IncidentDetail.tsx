/**
 * IncidentDetail — the evidence behind one incident, stage by stage: what was detected, and what the
 * agent recorded about triage, the fix, the verify gate, the review and the pull request. Everything
 * comes from stored records (web/src/lib/evidence.ts); a stage with no record says "not reached"
 * rather than showing a result. Read-only for guests and operators; an admin also gets Retire (admin API, #63).
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { ArrowLeft, Check, CircleDashed, ExternalLink, Minus } from "lucide-react";
import PageMeta from "../components/PageMeta";
import SettingsUnavailableNotice from "../components/SettingsUnavailableNotice";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { SyntheticBadge } from "../components/SyntheticBadge";
import { MonitoringOnlyBadge } from "../components/MonitoringOnlyBadge";
import { RetireControl } from "../components/AdminActions";
import { HourlyBars } from "../components/HourlyBars";
import { hourlySeries } from "../lib/overviewModel";
import { formatDateTime } from "../lib/formatters";
import { buildEvidence, currentCycleId, type EvidenceStage, type EvidenceStatus } from "../lib/evidence";
import { getIncident, type IncidentRow } from "../lib/incidents";
import { readCycle } from "../lib/runs";
import { safeUrl, type CycleRow } from "../lib/runsModel";
import { useEnvironment } from "../lib/useSettings";

const STATUS: Record<EvidenceStatus, { label: string; tone: BadgeTone; Icon: typeof Check }> = {
  recorded: { label: "Recorded", tone: "success", Icon: Check },
  "not-reached": { label: "Not reached", tone: "neutral", Icon: CircleDashed },
  "not-stored": { label: "Not stored", tone: "warning", Icon: Minus },
};

/** Timestamps arrive as ISO strings on the incident row; show them as dates, leave anything else as it is. */
function when(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) ? formatDateTime(value) : value;
}

export default function IncidentDetail() {
  const { id = "" } = useParams();
  const { environment, ready, settingsUnavailable } = useEnvironment();

  const incident = useQuery({
    queryKey: ["incident", environment, id],
    queryFn: () => getIncident(id, environment),
    enabled: ready && id !== "",
    retry: false,
  });
  const row = incident.data ?? null;
  const cycleId = row ? currentCycleId(row) : "";
  const cycle = useQuery({
    queryKey: ["cycle", environment, cycleId],
    queryFn: () => readCycle(cycleId, environment),
    enabled: row !== null,
    refetchInterval: 15_000,
    retry: false,
  });

  return (
    <div className="space-y-4">
      <PageMeta title="Incident evidence | Starfish" description="The evidence behind one incident, stage by stage" />
      <Link to="/incidents" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Incidents
      </Link>
      {settingsUnavailable && <SettingsUnavailableNotice environment={environment} subject="the incident and its run" />}

      {incident.isPending || !ready ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">Loading…</p>
      ) : incident.isError ? (
        <p role="alert" className="text-sm text-error-700 dark:text-error-400">
          Couldn&apos;t read this incident. It may not exist, or you may not be allowed to see it.
        </p>
      ) : row === null ? (
        <p role="alert" className="text-sm text-gray-700 dark:text-gray-300">
          No incident with this id in this environment.
        </p>
      ) : (
        <Evidence row={row} cycle={cycle.data ?? null} runPending={cycle.isPending} runFailed={cycle.isError} />
      )}
    </div>
  );
}

function Evidence({ row, cycle, runPending, runFailed }: { row: IncidentRow; cycle: CycleRow | null; runPending: boolean; runFailed: boolean }) {
  // While the run record loads, or if it can't be read, nothing is claimed about the later stages.
  const evidence = buildEvidence(row, cycle);
  const runUnknown = runPending || runFailed;
  // The last 24 hours of this incident's own buckets; nothing is drawn when it had none.
  const hours = hourlySeries([row], Date.now(), 24);
  const series = hours.some((b) => b.count > 0) ? hours : null;

  return (
    <>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">{row.functionName}</h1>
          {(row.synthetic || cycle?.synthetic) && <SyntheticBadge />}
          {row.monitoringOnly && <MonitoringOnlyBadge />}
        </div>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{row.errorMessage}</p>
        {(row.trimmed || cycle?.trimmed) && (
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400" data-testid="trimmed-note">
            Public view: a trimmed copy of the record. Error detail, stack traces and the model&apos;s own words are left out of it.
          </p>
        )}
        <div className="mt-2">
          <RetireControl incidentId={row.id} />
        </div>
        {evidence.cycleId && (
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            From run{" "}
            <Link to={`/runs?run=${encodeURIComponent(evidence.cycleId)}`} className="font-mono text-brand-700 hover:underline dark:text-brand-400">
              {evidence.cycleId}
            </Link>
          </p>
        )}
      </div>

      {runFailed && (
        <p role="alert" className="text-sm text-error-700 dark:text-error-400">
          Couldn&apos;t read the agent&apos;s run record, so the stages below the detection are not shown.
        </p>
      )}
      {evidence.samePatch === false && (
        <p role="alert" className="rounded-lg border border-error-300 bg-error-50 p-3 text-sm text-error-700 dark:border-error-700 dark:bg-error-900/20 dark:text-error-400">
          The patch hash differs between stages: the verify gate, the review and the pull request are not about the same patch.
        </p>
      )}
      {evidence.samePatch === true && (
        <p className="text-sm text-gray-700 dark:text-gray-300">The verify gate, the review and the pull request all record the same patch hash.</p>
      )}

      <ol aria-label="Evidence" className="space-y-3">
        {evidence.stages.map((stage, i) => (
          <StageCard key={stage.id} stage={stage} index={i + 1} hidden={runUnknown && stage.id !== "detected"} chart={stage.id === "detected" ? series : null} />
        ))}
      </ol>
    </>
  );
}

function StageCard({ stage, index, hidden, chart }: { stage: EvidenceStage; index: number; hidden: boolean; chart: ReturnType<typeof hourlySeries> | null }) {
  if (hidden) return null;
  const { label, tone, Icon } = STATUS[stage.status];
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-stage={stage.id} data-status={stage.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-4 w-4 text-gray-600 dark:text-gray-400" aria-hidden />
        <h2 className="font-medium text-gray-900 dark:text-white">
          {index}. {stage.title}
        </h2>
        <Badge tone={tone}>{label}</Badge>
      </div>
      {stage.note && <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{stage.note}</p>}
      {chart && <HourlyBars series={chart} label="Occurrences by hour, last 24 hours" />}
      {stage.fields.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {stage.fields.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-gray-600 dark:text-gray-400">{f.label}</dt>
              <dd className={`break-words text-gray-900 dark:text-gray-100 ${f.mono ? "font-mono text-xs" : ""}`}>
                {f.href && safeUrl(f.href) ? (
                  <a href={safeUrl(f.href)} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all text-brand-700 hover:underline dark:text-brand-400">
                    {f.value} <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                ) : (
                  when(f.value)
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}
