/**
 * The browser's side of the admin API (src/adminApi.ts): "Run ingest now" and "Retire an incident".
 * Both send the signed-in person's Firebase ID token in a header; the server decides from the operator
 * record whether that person is an admin, so hiding the buttons from everyone else is a courtesy, not
 * the check. Nothing here throws: an answer is a typed result with a message safe to show.
 */
import { appCheckToken } from "./appCheck";
import { webConfig } from "./config";
import { firebaseAuth } from "./firebase";

export interface IngestSummary {
  outcome: string;
  windows: number;
  entriesProcessed: number;
  incidentsCreated: number;
  incidentsUpdated: number;
  incidentsRecurred: number;
  capped: boolean;
  error?: string;
}

export type AdminResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface AdminApiDeps {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  /** The App Check token to send as X-Firebase-AppCheck (#12), or null for none. Absent: none is sent. */
  getAppCheckToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

/** What each failure means to the person who clicked; the server never says more than this. */
function messageFor(status: number): string {
  switch (status) {
    case 401:
      return "Your session has expired. Sign in again.";
    case 403:
      return "Only admins can do this.";
    case 404:
      return "That incident no longer exists.";
    case 409:
      return "An ingest run is already in progress. Try again in a moment.";
    default:
      return "The admin service could not do that. Try again; if it keeps failing, check its logs.";
  }
}

/**
 * `serverSays`: for a refusal that is not about the session (401) or the role (403), show the server's own short reason
 * (the on-call routes' "wrong code", "the code expired: send a new one"), which it chose to be safe to show.
 */
async function post(deps: AdminApiDeps, path: string, body?: unknown, serverSays = false): Promise<AdminResult<unknown>> {
  if (!deps.baseUrl) return { ok: false, message: "The admin service is not configured for this site." };
  let token: string | null;
  try {
    token = await deps.getToken();
  } catch {
    token = null;
  }
  if (!token) return { ok: false, message: "Your session has expired. Sign in again." };
  // No App Check token is not a reason to stop: the server says whether it requires one.
  let appCheck: string | null;
  try {
    appCheck = (await deps.getAppCheckToken?.()) ?? null;
  } catch {
    appCheck = null;
  }
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${deps.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(appCheck && { "x-firebase-appcheck": appCheck }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, message: "Could not reach the admin service." };
  }
  if (!res.ok) {
    if (serverSays && res.status !== 401 && res.status !== 403) {
      try {
        const error = ((await res.json()) as { error?: unknown } | null)?.error;
        if (typeof error === "string" && error.length > 0 && error.length <= 120) return { ok: false, message: `${error.charAt(0).toUpperCase()}${error.slice(1)}.` };
      } catch {
        // no readable reason: the generic message below
      }
    }
    return { ok: false, message: messageFor(res.status) };
  }
  try {
    return { ok: true, value: await res.json() };
  } catch {
    return { ok: false, message: messageFor(500) };
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function runIngestNow(deps: AdminApiDeps): Promise<AdminResult<IngestSummary>> {
  const r = await post(deps, "/api/ingest/run");
  if (!r.ok) return r;
  const b = (r.value ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    value: {
      outcome: typeof b.outcome === "string" ? b.outcome : "unknown",
      windows: num(b.windows),
      entriesProcessed: num(b.entriesProcessed),
      incidentsCreated: num(b.incidentsCreated),
      incidentsUpdated: num(b.incidentsUpdated),
      incidentsRecurred: num(b.incidentsRecurred),
      capped: b.capped === true,
      ...(typeof b.error === "string" && { error: b.error }),
    },
  };
}

export async function retireIncident(deps: AdminApiDeps, incidentId: string, reason: string): Promise<AdminResult<{ alreadyRetired: boolean }>> {
  const r = await post(deps, `/api/incidents/${encodeURIComponent(incidentId)}/retire`, { reason });
  if (!r.ok) return r;
  return { ok: true, value: { alreadyRetired: (r.value as { alreadyRetired?: unknown } | null)?.alreadyRetired === true } };
}

/** Phone escalation (#37): text a person the code that confirms their number. The server checks the admin role. */
export async function sendOnCallCode(deps: AdminApiDeps, personId: string): Promise<AdminResult<null>> {
  const r = await post(deps, `/api/oncall/people/${encodeURIComponent(personId)}/send-code`, undefined, true);
  return r.ok ? { ok: true, value: null } : r;
}

/** Phone escalation (#37): confirm a person's number with the six-digit code they read back. */
export async function confirmOnCallNumber(deps: AdminApiDeps, personId: string, code: string): Promise<AdminResult<null>> {
  const r = await post(deps, `/api/oncall/people/${encodeURIComponent(personId)}/confirm`, { code }, true);
  return r.ok ? { ok: true, value: null } : r;
}

/** The deps the app uses: the configured URL and the current user's fresh ID token. */
export function appAdminApi(): AdminApiDeps {
  return {
    baseUrl: webConfig().adminApiUrl,
    getToken: async () => (await firebaseAuth().currentUser?.getIdToken()) ?? null,
    getAppCheckToken: () => appCheckToken(),
  };
}
