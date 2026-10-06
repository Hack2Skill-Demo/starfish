import { describe, expect, it } from "vitest";
import {
  buildMonitoringFilter,
  createRestMonitoringReader,
  readMonitoringFailures,
  type MonitoringReader,
  type MonitoringSeriesPage,
  type MonitoringSeriesRequest,
  type RawTimeSeries,
} from "./monitoring.js";
import { fingerprintOf, MONITORING_FINGERPRINT_PREFIX, computeErrorFingerprint } from "./fingerprint.js";
import { windowOf } from "./window.js";
import { testConfig } from "../testConfig.js";
import { DEFAULT_MONITORING_SIGNALS } from "../config.js";

const window = windowOf(new Date("2026-10-05T10:00:00.000Z"), new Date("2026-10-05T11:00:00.000Z"));
const runSignal = DEFAULT_MONITORING_SIGNALS[0]!;
const fnSignal = DEFAULT_MONITORING_SIGNALS[1]!;
const config = testConfig({ watchedProjectId: "watched-app-1", monitoringEnabled: true, excludedServices: ["starfish"] });

const series = (label: string, name: string, ...counts: (number | string)[]): RawTimeSeries => ({
  resource: { type: "cloud_run_revision", labels: { [label]: name } },
  points: counts.map((c) => ({
    interval: { startTime: "2026-10-05T10:00:00.000Z", endTime: "2026-10-05T11:00:00.000Z" },
    value: { int64Value: c },
  })),
});

/** A reader that answers each signal's requests from `pages` (keyed by metric type), recording what it was asked. */
function fakeReader(pages: Record<string, MonitoringSeriesPage[]>) {
  const requests: MonitoringSeriesRequest[] = [];
  const reader: MonitoringReader = {
    listTimeSeries: async (req) => {
      requests.push(req);
      const metric = Object.keys(pages).find((m) => req.filter.includes(`"${m}"`));
      const list = metric ? pages[metric]! : [];
      const index = req.pageToken === undefined ? 0 : Number(req.pageToken);
      return list[index] ?? { series: [] };
    },
  };
  return { reader, requests };
}

describe("readMonitoringFailures", () => {
  it("reads one count per function with its provenance and observation window", async () => {
    const { reader, requests } = fakeReader({
      [runSignal.metricType]: [{ series: [series("service_name", "checkout", "3", 4)] }],
      [fnSignal.metricType]: [{ series: [series("function_name", "sendMail", 2)] }],
    });
    const obs = await readMonitoringFailures(reader, config, window);
    expect(obs).toEqual([
      expect.objectContaining({
        source: "cloud-monitoring",
        metricType: "run.googleapis.com/request_count",
        resourceType: "cloud_run_revision",
        projectId: "watched-app-1",
        functionName: "checkout",
        failureCount: 7,
        windowStart: window.start,
        windowEnd: window.end,
        capped: false,
      }),
      expect.objectContaining({ metricType: fnSignal.metricType, functionName: "sendMail", failureCount: 2 }),
    ]);
    expect(requests[0]).toMatchObject({
      projectId: "watched-app-1",
      startTime: window.start,
      endTime: window.end,
      alignmentPeriodSeconds: 3600,
      groupByField: "resource.labels.service_name",
    });
    expect(requests[0]!.filter).toBe(
      'metric.type = "run.googleapis.com/request_count" AND resource.type = "cloud_run_revision" AND metric.labels.response_code_class = "5xx"'
    );
  });

  it("is an empty list, not null, when Monitoring counted no failures", async () => {
    const { reader } = fakeReader({});
    expect(await readMonitoringFailures(reader, config, window)).toEqual([]);
  });

  it("is null, never zero, when the Monitoring API fails", async () => {
    const reader: MonitoringReader = {
      listTimeSeries: () => Promise.reject(new Error("PERMISSION_DENIED: monitoring.timeSeries.list")),
    };
    await expect(readMonitoringFailures(reader, config, window)).resolves.toBeNull();
  });

  it("is null when one signal fails after another answered: a partial signal is not the signal", async () => {
    let n = 0;
    const reader: MonitoringReader = {
      listTimeSeries: async () => {
        if (n++ === 0) return { series: [series("service_name", "checkout", 3)] };
        throw new Error("UNAVAILABLE");
      },
    };
    expect(await readMonitoringFailures(reader, config, window)).toBeNull();
  });

  it("is null on an answer that is not a page", async () => {
    const reader = { listTimeSeries: async () => ({ series: "nope" }) } as unknown as MonitoringReader;
    expect(await readMonitoringFailures(reader, config, window)).toBeNull();
  });

  it("skips Starfish's own service, unlabelled series and unreadable or zero points", async () => {
    const { reader } = fakeReader({
      [runSignal.metricType]: [
        {
          series: [
            series("service_name", "starfish", 50),
            series("service_name", "", 9),
            { resource: { labels: {} }, points: [{ value: { int64Value: "5" } }] },
            series("service_name", "orders", "x", -1, 0),
            series("service_name", "checkout", 1),
          ],
        },
      ],
    });
    const obs = await readMonitoringFailures(reader, testConfig({ ...config, monitoringSignals: [runSignal] }), window);
    expect(obs?.map((o) => [o.functionName, o.failureCount])).toEqual([["checkout", 1]]);
  });

  it("merges the two spellings of one function", async () => {
    const { reader } = fakeReader({
      [runSignal.metricType]: [{ series: [series("service_name", "sync-orders", 2), series("service_name", "sync_orders", 3)] }],
    });
    const obs = await readMonitoringFailures(reader, testConfig({ ...config, monitoringSignals: [runSignal] }), window);
    expect(obs).toHaveLength(1);
    expect(obs![0]!.failureCount).toBe(5);
  });

  it("stops at monitoringMaxSeries across pages and says it was capped", async () => {
    const { reader, requests } = fakeReader({
      [runSignal.metricType]: [
        { series: [series("service_name", "a", 1), series("service_name", "b", 1)], nextPageToken: "1" },
        { series: [series("service_name", "c", 1), series("service_name", "d", 1)], nextPageToken: "2" },
        { series: [series("service_name", "e", 1)] },
      ],
    });
    const obs = await readMonitoringFailures(reader, testConfig({ ...config, monitoringMaxSeries: 3 }), window);
    expect(obs?.map((o) => o.functionName)).toEqual(["a", "b", "c"]);
    expect(obs?.every((o) => o.capped)).toBe(true);
    // Never asked for more than the cap left, and never read past it (the second signal included).
    expect(requests.map((r) => r.pageSize)).toEqual([3, 1]);
  });

  it("clamps point intervals to the window and never aligns under a minute", async () => {
    const short = windowOf(new Date("2026-10-05T10:00:00.000Z"), new Date("2026-10-05T10:00:20.000Z"));
    const { reader, requests } = fakeReader({
      [runSignal.metricType]: [
        {
          series: [
            {
              resource: { labels: { service_name: "checkout" } },
              points: [{ interval: { startTime: "2026-10-05T09:00:00.000Z", endTime: "2026-10-05T12:00:00.000Z" }, value: { int64Value: "2" } }],
            },
          ],
        },
      ],
    });
    const obs = await readMonitoringFailures(reader, testConfig({ ...config, monitoringSignals: [runSignal] }), short);
    expect(requests[0]!.alignmentPeriodSeconds).toBe(60);
    expect(obs![0]!.firstAt).toEqual(short.start);
    expect(obs![0]!.lastAt).toEqual(short.end);
  });

  it("escapes the configured names in the filter", () => {
    expect(buildMonitoringFilter({ ...runSignal, metricType: 'a"b\\c' })).toContain('metric.type = "a\\"b\\\\c"');
  });
});

describe("createRestMonitoringReader (fake fetch; never run against real Cloud Monitoring)", () => {
  const request: MonitoringSeriesRequest = {
    projectId: "watched-app-1",
    filter: buildMonitoringFilter(runSignal),
    startTime: window.start,
    endTime: window.end,
    alignmentPeriodSeconds: 3600,
    groupByField: "resource.labels.service_name",
    pageSize: 100,
    pageToken: "t1",
  };

  it("asks timeSeries.list for one sum per function over the window, with the engine's token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const reader = createRestMonitoringReader({
      getAccessToken: async () => "tok",
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ timeSeries: [series("service_name", "checkout", "4")], nextPageToken: "t2" }), { status: 200 });
      }) as typeof fetch,
    });
    const page = await reader.listTimeSeries(request);
    expect(page.nextPageToken).toBe("t2");
    expect(page.series).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://monitoring.googleapis.com/v3/projects/watched-app-1/timeSeries");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      filter: request.filter,
      "interval.startTime": "2026-10-05T10:00:00.000Z",
      "interval.endTime": "2026-10-05T11:00:00.000Z",
      "aggregation.alignmentPeriod": "3600s",
      "aggregation.perSeriesAligner": "ALIGN_SUM",
      "aggregation.crossSeriesReducer": "REDUCE_SUM",
      "aggregation.groupByFields": "resource.labels.service_name",
      pageSize: "100",
      pageToken: "t1",
    });
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("an empty answer is no series; an error status throws, which the signal reads as unavailable", async () => {
    const ok = createRestMonitoringReader({
      getAccessToken: async () => "tok",
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    expect(await ok.listTimeSeries(request)).toEqual({ series: [] });

    const denied = createRestMonitoringReader({
      getAccessToken: async () => "tok",
      fetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch,
    });
    await expect(denied.listTimeSeries(request)).rejects.toThrow("403");
    expect(await readMonitoringFailures(denied, config, window)).toBeNull();
  });
});

describe("fingerprintOf: a namespace of its own for Monitoring-only incidents", () => {
  it("never gives a Monitoring-only record a log fingerprint", () => {
    const log = fingerprintOf("checkout", runSignal.description);
    const mon = fingerprintOf("checkout", runSignal.description, "monitoring");
    expect(log).toBe(computeErrorFingerprint("checkout", runSignal.description));
    expect(mon).toBe(`${MONITORING_FINGERPRINT_PREFIX}${log}`);
    expect(log).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOf("checkout", "x", "log")).toBe(computeErrorFingerprint("checkout", "x"));
  });
});
