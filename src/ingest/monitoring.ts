/**
 * The Cloud Monitoring failure signal (#19): failed invocations that wrote no ERROR log.
 *
 * Gen2 (Cloud Run) functions can fail without an ERROR-severity log entry, so a log-only reader
 * reports "no logged errors" while Monitoring still counts the failures. This reads, for one ingest
 * window, the configured failure metrics (`StarfishConfig.monitoringSignals`: 5xx responses on Cloud
 * Run, non-ok executions on gen1 Cloud Functions) of the WATCHED project, one summed count per
 * function, each with its provenance: metric, resource type, project and observation window.
 *
 * Contracts, the same as the log counter-check's:
 *   - never throws: an unavailable signal is `null`, never an empty list or a zero. Zero means
 *     "Monitoring answered and counted no failures"; null means "we do not know".
 *   - bounded: at most `monitoringMaxSeries` series per window, across all signals, and the read
 *     says when it stopped at that cap (each count is then a floor).
 *
 * Off by default (`STARFISH_MONITORING_ENABLED`). The reader is an interface so tests use a fake; the
 * production adapter calls the Monitoring v3 REST API with the engine's own credential. It has never
 * been run against real Cloud Monitoring.
 */
import { applicationDefault } from "firebase-admin/app";
import type { MonitoringSignalDef, StarfishConfig } from "../config.js";
import { canonicalFunctionName } from "./fingerprint.js";
import { isExcludedService } from "./parseLogEntry.js";
import type { IngestWindow } from "./window.js";

/** One page request for `projects.timeSeries.list`, already aggregated to one sum per function. */
export interface MonitoringSeriesRequest {
  projectId: string;
  filter: string;
  startTime: Date;
  endTime: Date;
  /** The aligner's period: the whole window, so each series is (about) one point. */
  alignmentPeriodSeconds: number;
  /** `resource.labels.<functionLabel>`: the series are summed per function. */
  groupByField: string;
  pageSize: number;
  pageToken?: string;
}

/** The parts of a Monitoring `TimeSeries` that are read. Everything is optional: the API's JSON is untrusted. */
export interface RawTimeSeries {
  resource?: { type?: unknown; labels?: Record<string, unknown> };
  points?: { interval?: { startTime?: unknown; endTime?: unknown }; value?: { int64Value?: unknown; doubleValue?: unknown } }[];
}

export interface MonitoringSeriesPage {
  series: RawTimeSeries[];
  nextPageToken?: string;
}

/** The one call the signal needs. A test passes a fake; production uses `createRestMonitoringReader`. */
export interface MonitoringReader {
  listTimeSeries(request: MonitoringSeriesRequest): Promise<MonitoringSeriesPage>;
}

/** One function's failures in one window, as Monitoring counted them, with where the number came from. */
export interface MonitoringObservation {
  source: "cloud-monitoring";
  metricType: string;
  resourceType: string;
  projectId: string;
  /** As the resource label spelled it. Compared with log incidents on the canonical spelling. */
  functionName: string;
  /** The observation window: the ingest window, (start, end]. */
  windowStart: Date;
  windowEnd: Date;
  failureCount: number;
  /** The read stopped at `monitoringMaxSeries`: this count, and the set of functions, are a floor. */
  capped: boolean;
  /** The earliest and latest point intervals that held failures, clamped to the window. */
  firstAt: Date;
  lastAt: Date;
  /** The signal's fixed description: a Monitoring-only incident's message. */
  description: string;
}

export type MonitoringConfig = Pick<
  StarfishConfig,
  "watchedProjectId" | "monitoringSignals" | "monitoringMaxSeries" | "excludedServices"
>;

const PAGE_SIZE = 100;
/** Monitoring rejects an alignment period under a minute. */
const MIN_ALIGNMENT_SECONDS = 60;

/** A double-quoted Monitoring filter string. The values are config (Google's metric names), escaped all the same. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The filter one signal is read with: its metric, its resource type, and only the failures. */
export function buildMonitoringFilter(signal: MonitoringSignalDef): string {
  return `metric.type = ${quote(signal.metricType)} AND resource.type = ${quote(signal.resourceType)} AND ${signal.failureFilter}`;
}

/** A point's value as a non-negative integer count, or undefined when it is not one. */
function pointCount(value: { int64Value?: unknown; doubleValue?: unknown } | undefined): number | undefined {
  const raw = value?.int64Value ?? value?.doubleValue;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

function toTime(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Failed invocations per function over `window`, from every configured signal; `null` when the signal
 * is unavailable (a read failed, or answered in a shape that cannot be trusted). Never throws.
 * An empty list is a real answer: Monitoring counted no failures.
 */
export async function readMonitoringFailures(
  reader: MonitoringReader,
  config: MonitoringConfig,
  window: IngestWindow
): Promise<MonitoringObservation[] | null> {
  try {
    const startMs = window.start.getTime();
    const endMs = window.end.getTime();
    const alignmentPeriodSeconds = Math.max(MIN_ALIGNMENT_SECONDS, Math.ceil((endMs - startMs) / 1000));
    const out: MonitoringObservation[] = [];
    let seriesRead = 0;
    let capped = false;

    for (const signal of config.monitoringSignals) {
      const byFunction = new Map<string, MonitoringObservation>();
      let pageToken: string | undefined;
      do {
        if (seriesRead >= config.monitoringMaxSeries) {
          capped = true;
          break;
        }
        const page = await reader.listTimeSeries({
          projectId: config.watchedProjectId,
          filter: buildMonitoringFilter(signal),
          startTime: window.start,
          endTime: window.end,
          alignmentPeriodSeconds,
          groupByField: `resource.labels.${signal.functionLabel}`,
          pageSize: Math.min(PAGE_SIZE, config.monitoringMaxSeries - seriesRead),
          ...(pageToken !== undefined && { pageToken }),
        });
        if (!page || !Array.isArray(page.series)) return null;
        const room = config.monitoringMaxSeries - seriesRead;
        // A page longer than was asked for is cut at the cap, and the cut is reported.
        if (page.series.length > room) capped = true;
        for (const series of page.series.slice(0, room)) {
          seriesRead += 1;
          foldSeries(series, signal, config, window, byFunction);
        }
        pageToken = typeof page.nextPageToken === "string" && page.nextPageToken !== "" ? page.nextPageToken : undefined;
      } while (pageToken !== undefined);
      out.push(...byFunction.values());
    }
    return out.map((o) => ({ ...o, capped }));
  } catch {
    // The error can quote the request, and nothing here needs it: unavailable is the whole answer.
    return null;
  }
}

/** Adds one series' failures to its function's observation. A series with no readable count adds nothing. */
function foldSeries(
  series: RawTimeSeries,
  signal: MonitoringSignalDef,
  config: MonitoringConfig,
  window: IngestWindow,
  byFunction: Map<string, MonitoringObservation>
): void {
  const label = series?.resource?.labels?.[signal.functionLabel];
  if (typeof label !== "string" || label.trim() === "") return;
  // Starfish's own service is never an incident, from logs or from Monitoring (see excludedServices).
  if (isExcludedService(label, config.excludedServices)) return;

  const startMs = window.start.getTime();
  const endMs = window.end.getTime();
  let count = 0;
  let first: number | undefined;
  let last: number | undefined;
  for (const point of Array.isArray(series.points) ? series.points : []) {
    const n = pointCount(point?.value);
    if (n === undefined || n === 0) continue;
    count += n;
    const ps = toTime(point.interval?.startTime) ?? toTime(point.interval?.endTime) ?? endMs;
    const pe = toTime(point.interval?.endTime) ?? endMs;
    const s = Math.min(Math.max(ps, startMs), endMs);
    const e = Math.min(Math.max(pe, startMs), endMs);
    first = first === undefined ? s : Math.min(first, s);
    last = last === undefined ? e : Math.max(last, e);
  }
  if (count === 0) return;

  const key = canonicalFunctionName(label);
  const found = byFunction.get(key);
  if (found) {
    found.failureCount += count;
    if (first !== undefined && first < found.firstAt.getTime()) found.firstAt = new Date(first);
    if (last !== undefined && last > found.lastAt.getTime()) found.lastAt = new Date(last);
    return;
  }
  byFunction.set(key, {
    source: "cloud-monitoring",
    metricType: signal.metricType,
    resourceType: signal.resourceType,
    projectId: config.watchedProjectId,
    functionName: label,
    windowStart: window.start,
    windowEnd: window.end,
    failureCount: count,
    capped: false,
    firstAt: new Date(first ?? endMs),
    lastAt: new Date(last ?? endMs),
    description: signal.description,
  });
}

export interface RestReaderDeps {
  /** An OAuth access token for the engine's identity. Default: the Admin SDK's application-default credential. */
  getAccessToken?: () => Promise<string>;
  fetch?: typeof fetch;
  /** Per request. A read that never answers must not hold the ingest window. */
  timeoutMs?: number;
  baseUrl?: string;
}

/**
 * The production reader: Monitoring v3 `projects.timeSeries.list` over REST, summed per function by
 * the API (ALIGN_SUM over the window, REDUCE_SUM grouped by the function label). It needs
 * `roles/monitoring.viewer` on the watched project. Written and tested against a fake fetch only:
 * never run against real Cloud Monitoring. Throws on any failure; `readMonitoringFailures` turns that
 * into `null`.
 */
export function createRestMonitoringReader(deps: RestReaderDeps = {}): MonitoringReader {
  const getAccessToken =
    deps.getAccessToken ?? (async () => (await applicationDefault().getAccessToken()).access_token);
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const baseUrl = deps.baseUrl ?? "https://monitoring.googleapis.com/v3";
  return {
    async listTimeSeries(req) {
      const params = new URLSearchParams({
        filter: req.filter,
        "interval.startTime": req.startTime.toISOString(),
        "interval.endTime": req.endTime.toISOString(),
        "aggregation.alignmentPeriod": `${req.alignmentPeriodSeconds}s`,
        "aggregation.perSeriesAligner": "ALIGN_SUM",
        "aggregation.crossSeriesReducer": "REDUCE_SUM",
        "aggregation.groupByFields": req.groupByField,
        view: "FULL",
        pageSize: String(req.pageSize),
        ...(req.pageToken !== undefined && { pageToken: req.pageToken }),
      });
      const token = await getAccessToken();
      const res = await doFetch(`${baseUrl}/projects/${encodeURIComponent(req.projectId)}/timeSeries?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Cloud Monitoring answered ${res.status}`);
      const body = (await res.json()) as { timeSeries?: unknown; nextPageToken?: unknown };
      if (body.timeSeries !== undefined && !Array.isArray(body.timeSeries)) throw new Error("timeSeries is not a list");
      return {
        series: (body.timeSeries ?? []) as RawTimeSeries[],
        ...(typeof body.nextPageToken === "string" && body.nextPageToken !== "" && { nextPageToken: body.nextPageToken }),
      };
    },
  };
}
