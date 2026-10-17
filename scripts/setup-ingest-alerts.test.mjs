// scripts/setup-ingest-alerts.sh (#387) provisions alerts in a real project, so these pin what it promises: it refuses unsafe
// inputs, a dry run prints the whole plan and calls nothing, a live run creates only what is missing, and the alerts are
// about the ingest job's own executions and lag, never about the Hosting uptime check.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./setup-ingest-alerts.sh", import.meta.url).pathname;
const lagLog = readFileSync(new URL("../src/ingest/lagLog.ts", import.meta.url), "utf8");
const TOKEN = "tok-SECRET-123";

/**
 * gcloud and curl stubs that log every call. `metricExists`: `gcloud logging metrics describe` succeeds. `policies`: the
 * display names the policy list returns. `failPost`: the POST of a policy is refused.
 */
function setup(env, { metricExists = false, policies = [], failPost = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alerts-stub-"));
  const log = join(dir, "calls");
  writeFileSync(
    join(dir, "gcloud"),
    `#!/bin/sh
echo "gcloud $*" >> "${log}"
case "$*" in
  "auth print-access-token") echo ${TOKEN}; exit 0 ;;
  "logging metrics describe "*) ${metricExists ? "exit 0" : "exit 1"} ;;
  "logging metrics create "*) for a in "$@"; do case "$a" in --config-from-file=*) cp "\${a#--config-from-file=}" "${dir}/metric.json" ;; esac; done; exit 0 ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(dir, "curl"),
    `#!/bin/sh
echo "curl $*" >> "${log}"
cat >> "${dir}/stdin"
method=GET; body=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    -H) shift 2 ;;
    -*) shift ;;
    *) shift ;;
  esac
done
if [ "$method" = POST ]; then
  ${failPost ? "exit 22" : `printf '%s\\n@@@\\n' "$body" >> "${dir}/posted"; echo '{}'; exit 0`}
fi
echo '${JSON.stringify({ alertPolicies: policies.map((displayName) => ({ displayName })) })}'
`,
  );
  chmodSync(join(dir, "gcloud"), 0o755);
  chmodSync(join(dir, "curl"), 0o755);
  const r = spawnSync("bash", [script], { env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env }, encoding: "utf8" });
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return {
    code: r.status,
    out: r.stdout + r.stderr,
    calls: read("calls").trim().split("\n").filter(Boolean),
    stdin: read("stdin"),
    posted: read("posted").split("\n@@@\n").map((d) => d.trim()).filter(Boolean).map((d) => JSON.parse(d)),
    metric: read("metric.json") ? JSON.parse(read("metric.json")) : undefined,
  };
}

const base = { PROJECT_ID: "star-proj" };
const dry = { ...base, DRY_RUN: "1" };
/** The JSON documents a dry run prints: one per line group that starts with `{`. */
const documents = (out) => out.split("\n+ ").join("\n").split("\n").filter((l) => l.startsWith('{"')).length;

describe("scripts/setup-ingest-alerts.sh", () => {
  it("refuses a missing or unsafe setting before calling anything", () => {
    const cases = [
      [{ PROJECT_ID: "" }, "PROJECT_ID is required"],
      [{ PROJECT_ID: "Not A Project" }, "is not a project id"],
      [{ JOB_NAME: 'x" OR true OR "' }, "JOB_NAME must be"],
      [{ INGEST_ALERT_MISSED_MINUTES: "soon" }, "whole number of minutes"],
      [{ INGEST_ALERT_MISSED_MINUTES: "2" }, "5 to 1410"],
      [{ INGEST_ALERT_MISSED_MINUTES: "2000" }, "5 to 1410"],
      [{ INGEST_ALERT_LAG_MINUTES: "0" }, "at least 1"],
      [{ INGEST_ALERT_NOTIFICATION_CHANNELS: "me@example.com" }, "INGEST_ALERT_NOTIFICATION_CHANNELS takes"],
    ];
    for (const [env, message] of cases) {
      const r = setup({ ...dry, ...env });
      expect(r.code, JSON.stringify(env)).toBe(1);
      expect(r.out).toContain(message);
      expect(r.calls).toEqual([]);
    }
  });

  it("a dry run prints the metric and both policies as valid JSON, and calls nothing", () => {
    const r = setup(dry);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(documents(r.out)).toBe(3);
    expect(r.out).toContain("+ gcloud logging metrics create starfish_ingest_checkpoint_lag_seconds --project=star-proj");
    expect(r.out).toContain("Dry run: nothing was changed.");
    expect(r.out).toContain("notify nobody");
  });

  it("creates the metric and both policies on a live run, with the access token on stdin and never in an argument", () => {
    const r = setup(base);
    expect(r.code).toBe(0);
    expect(r.metric).toMatchObject({
      name: "starfish_ingest_checkpoint_lag_seconds",
      valueExtractor: "EXTRACT(jsonPayload.ingestCheckpointLagSeconds)",
      metricDescriptor: { metricKind: "DELTA", valueType: "DISTRIBUTION" },
    });
    expect(r.posted.map((p) => p.displayName)).toEqual([
      "starfish ingest: no successful run (starfish-ingest)",
      "starfish ingest: checkpoint behind (starfish-ingest)",
    ]);
    expect(r.stdin).toContain(`Bearer ${TOKEN}`);
    expect(r.calls.join("\n")).not.toContain(TOKEN);
  });

  it("alerts on the job's own successful executions: an absence, in Cloud Run's metric, for the named job", () => {
    const [missed] = setup({ ...base, JOB_NAME: "acme-ingest", INGEST_ALERT_MISSED_MINUTES: "90" }).posted;
    const c = missed.conditions[0].conditionAbsent;
    expect(c.filter).toContain('metric.type="run.googleapis.com/job/completed_execution_count"');
    expect(c.filter).toContain('resource.label.job_name="acme-ingest"');
    expect(c.filter).toContain('metric.label.result="succeeded"');
    expect(c.duration).toBe("5400s");
  });

  it("alerts when a run leaves the checkpoint behind, from the line the run prints", () => {
    const [, lag] = setup({ ...base, INGEST_ALERT_LAG_MINUTES: "45" }).posted;
    const c = lag.conditions[0].conditionThreshold;
    expect(c.filter).toContain('metric.type="logging.googleapis.com/user/starfish_ingest_checkpoint_lag_seconds"');
    expect(c.comparison).toBe("COMPARISON_GT");
    expect(c.thresholdValue).toBe(2700);
    // The metric selects the very line the run prints (src/ingest/lagLog.ts).
    const message = lagLog.match(/INGEST_CHECKPOINT_MESSAGE = "([^"]+)"/)?.[1];
    expect(message).toBe("starfish ingest checkpoint");
    expect(setup(base).metric.filter).toContain(`jsonPayload.message="${message}"`);
    expect(lagLog).toContain("ingestCheckpointLagSeconds");
  });

  it("is independent of the web uptime check: no policy reads it, so a healthy Hosting site cannot quiet them", () => {
    const r = setup(base);
    for (const p of r.posted) expect(JSON.stringify(p)).not.toMatch(/uptime|check_passed|hosting|web\.app/i);
    expect(readFileSync(script, "utf8")).not.toMatch(/uptime_check|check_passed/);
  });

  it("sends both policies to the notification channels it is given", () => {
    const channels = "projects/star-proj/notificationChannels/111,projects/star-proj/notificationChannels/222";
    const r = setup({ ...base, INGEST_ALERT_NOTIFICATION_CHANNELS: channels });
    for (const p of r.posted) expect(p.notificationChannels).toEqual(channels.split(","));
    expect(r.out).not.toContain("notify nobody");
  });

  it("creates only what is missing, and says what exists", () => {
    const r = setup(base, { metricExists: true, policies: ["starfish ingest: no successful run (starfish-ingest)"] });
    expect(r.code).toBe(0);
    expect(r.metric).toBeUndefined();
    expect(r.posted.map((p) => p.displayName)).toEqual(["starfish ingest: checkpoint behind (starfish-ingest)"]);
    expect(r.out).toContain("log-based metric exists");
    expect(r.out).toContain("alert policy exists: starfish ingest: no successful run");
  });

  it("changes nothing, and says so, when everything exists", () => {
    const r = setup(base, {
      metricExists: true,
      policies: ["starfish ingest: no successful run (starfish-ingest)", "starfish ingest: checkpoint behind (starfish-ingest)"],
    });
    expect(r.code).toBe(0);
    expect(r.posted).toEqual([]);
  });

  it("fails, naming the console as the way out, when a policy is refused", () => {
    const r = setup(base, { failPost: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not create the alert policy");
    expect(r.out).toContain("roles/monitoring.alertPolicyEditor");
  });
});
