/**
 * Starts the deployed agent job once (#276): `jobs.run` of the Cloud Run Admin API v2, with no override, so the
 * execution is exactly what a Cloud Scheduler tick starts. Kept thin because it is the part that talks to Google: tested
 * against a stubbed fetch, never run against a real project.
 *
 * It only asks Cloud Run to start the job. The caller's account needs `run.jobs.run` on that one job
 * (`roles/run.invoker`; scripts/deploy-gcp.sh grants it to the admin API's account) and nothing the agent itself holds.
 * A failed call throws an AgentJobStartError that names the HTTP status and nothing else.
 */
import { applicationDefault } from "firebase-admin/app";
import { JOB_NAME_RE, PROJECT_ID_RE, REGION_RE } from "./cloudRunJob.js";

export class AgentJobStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentJobStartError";
  }
}

export interface AgentJobConfig {
  projectId: string;
  region: string;
  jobName: string;
}

export function createAgentJobStarter(
  cfg: AgentJobConfig,
  deps: { token?: () => Promise<string>; fetch?: typeof fetch } = {}
): () => Promise<void> {
  if (!JOB_NAME_RE.test(cfg.jobName)) throw new AgentJobStartError("STARFISH_AGENT_JOB is not a Cloud Run job name");
  if (!REGION_RE.test(cfg.region)) throw new AgentJobStartError("the agent job's region is not a region name");
  if (!PROJECT_ID_RE.test(cfg.projectId)) throw new AgentJobStartError("the project id is not a project id");
  const doFetch = deps.fetch ?? fetch;
  const token = deps.token ?? (async () => (await applicationDefault().getAccessToken()).access_token);
  const url = `https://run.googleapis.com/v2/projects/${cfg.projectId}/locations/${cfg.region}/jobs/${cfg.jobName}:run`;

  return async () => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: "{}",
        redirect: "error",
      });
    } catch {
      throw new AgentJobStartError("the agent job could not be started: Cloud Run could not be reached");
    }
    if (!res.ok) {
      const hint = res.status === 403 ? " (this service's account needs roles/run.invoker on the job)" : res.status === 404 ? " (no such job in this project and region)" : "";
      throw new AgentJobStartError(`the agent job could not be started: Cloud Run answered ${res.status}${hint}`);
    }
  };
}
