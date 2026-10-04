/**
 * The two production adapters of the isolated verify step (#74), kept thin because they are the part that talks to
 * Google and has never run against a real project:
 *
 *   - `createGcsStore`: a bucket through `firebase-admin/storage` (which carries @google-cloud/storage). Signed URLs
 *     are V4 and are signed with the running service account, which needs `roles/iam.serviceAccountTokenCreator`
 *     on itself (scripts/deploy-gcp.sh grants it).
 *   - `createCloudRunJobStarter`: `jobs.run` of the Cloud Run Admin API v2, with the request in an environment
 *     override. The access token is passed in, never fetched here.
 *
 * A failed call throws a VerifyRunnerError that names the HTTP status and nothing from the request: the request
 * holds two signed URLs.
 */
import type { App } from "firebase-admin/app";
import { applicationDefault } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import type { RunnerRequest } from "./verifyProtocol.js";
import { VerifyRunnerError } from "./verifyProtocol.js";
import type { JobStarter, ObjectStore } from "./verifyRemote.js";

export function createGcsStore(app: App, bucketName: string): ObjectStore {
  const bucket = () => getStorage(app).bucket(bucketName);
  return {
    async put(path, data, contentType) {
      await bucket().file(path).save(data, { contentType, resumable: false });
    },
    async signedUrl(path, method, expiresMs, contentType) {
      const [url] = await bucket()
        .file(path)
        .getSignedUrl({
          version: "v4",
          action: method === "GET" ? "read" : "write",
          expires: Date.now() + expiresMs,
          ...(contentType !== undefined && { contentType }),
        });
      return url;
    },
    async read(path) {
      const file = bucket().file(path);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [data] = await file.download();
      return data;
    },
    async remove(paths) {
      await Promise.all(paths.map((p) => bucket().file(p).delete({ ignoreNotFound: true })));
    },
  };
}

export interface JobStarterConfig {
  projectId: string;
  region: string;
  jobName: string;
}

/** The environment variable the runner reads its request from. */
export const REQUEST_ENV = "STARFISH_VERIFY_REQUEST";

const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const REGION_RE = /^[a-z]+-[a-z]+[0-9]+$/;

export function createCloudRunJobStarter(
  cfg: JobStarterConfig,
  deps: { token?: () => Promise<string>; fetch?: typeof fetch } = {}
): JobStarter {
  if (!NAME_RE.test(cfg.jobName)) throw new VerifyRunnerError("STARFISH_VERIFY_JOB is not a Cloud Run job name");
  if (!REGION_RE.test(cfg.region)) throw new VerifyRunnerError("the verify job's region is not a region name");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(cfg.projectId)) throw new VerifyRunnerError("the project id is not a project id");
  const doFetch = deps.fetch ?? fetch;
  const token = deps.token ?? (async () => (await applicationDefault().getAccessToken()).access_token);
  const url = `https://run.googleapis.com/v2/projects/${cfg.projectId}/locations/${cfg.region}/jobs/${cfg.jobName}:run`;

  return async (request: RunnerRequest) => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: { containerOverrides: [{ env: [{ name: REQUEST_ENV, value: JSON.stringify(request) }] }] } }),
        redirect: "error",
      });
    } catch {
      throw new VerifyRunnerError("the verify job could not be started: Cloud Run could not be reached");
    }
    if (!res.ok) {
      const hint = res.status === 403 ? " (the agent's service account needs roles/run.invoker on the job)" : "";
      throw new VerifyRunnerError(`the verify job could not be started: Cloud Run answered ${res.status}${hint}`);
    }
  };
}
