/**
 * Everything deployment-specific about the web UI, and the only file in web/src
 * that reads import.meta.env — the UI's counterpart to the engine's
 * src/config.ts. Nobody should have to edit a component to point Starfish at
 * their own project.
 */

/** The four Firebase web-app fields the SDK needs to reach a project. */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** Where Firebase Hosting serves the web-app config of the project a site belongs to. */
export const FIREBASE_INIT_PATH = "/__/firebase/init.json";

const FIREBASE_FIELDS = ["apiKey", "authDomain", "projectId", "appId"] as const;

/** The four fields from a parsed object, or the names of those missing or empty. */
function pickFirebaseConfig(raw: unknown): { config: FirebaseWebConfig } | { missing: string[] } {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const missing = FIREBASE_FIELDS.filter((f) => typeof obj[f] !== "string" || obj[f] === "");
  if (missing.length > 0) return { missing };
  return {
    config: {
      apiKey: obj.apiKey as string,
      authDomain: obj.authDomain as string,
      projectId: obj.projectId as string,
      appId: obj.appId as string,
    },
  };
}

/**
 * Where the Firebase config comes from, in order:
 *   1. `VITE_FIREBASE_*`, when all four are set. Local development and the
 *      emulators (`pnpm dev:emulated`): nothing is served at the init path there.
 *   2. Firebase Hosting's `/__/firebase/init.json`, which Hosting serves for the
 *      project a site belongs to. This is the deployed path: the bundle carries no
 *      project identifiers, so one build runs against any project it is hosted in.
 * Partial `VITE_FIREBASE_*` is an error rather than a silent fall-through to
 * Hosting, which would connect a half-configured dev build to the wrong project.
 */
export async function resolveFirebaseConfig(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch
): Promise<FirebaseWebConfig> {
  const fromEnv = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
  const setCount = Object.values(fromEnv).filter(Boolean).length;
  if (setCount === FIREBASE_FIELDS.length) return fromEnv as FirebaseWebConfig;
  if (setCount > 0) {
    const unset = FIREBASE_FIELDS.filter((f) => !fromEnv[f]).map(
      (f) => `VITE_FIREBASE_${f.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`
    );
    throw new Error(`${unset.join(", ")} not set: set all four VITE_FIREBASE_* values or none (see web/.env.example)`);
  }

  let res: Response;
  try {
    res = await fetchImpl(FIREBASE_INIT_PATH, { cache: "no-store" });
  } catch (err) {
    throw new Error(`Could not reach ${FIREBASE_INIT_PATH}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    throw new Error(
      `${FIREBASE_INIT_PATH} returned ${res.status}. Serve Starfish from Firebase Hosting, or set the VITE_FIREBASE_* values for local development (web/.env.example).`
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Hosting rewrites unknown paths to index.html, which is how a site that
    // isn't on Firebase Hosting answers this request.
    throw new Error(`${FIREBASE_INIT_PATH} did not return JSON: this site is not served by Firebase Hosting`);
  }
  const picked = pickFirebaseConfig(body);
  if ("missing" in picked) throw new Error(`${FIREBASE_INIT_PATH} is missing ${picked.missing.join(", ")}`);
  return picked.config;
}

export interface WebConfig {
  firebase: FirebaseWebConfig;
  /** Firestore database id; must match the engine's STARFISH_DATABASE_ID. */
  databaseId: string;
  /** Must match the engine's STARFISH_INCIDENT_COLLECTION. */
  incidentCollection: string;
  /** Operator records: {uid} → { roles: StarfishRole[] }. */
  usersCollection: string;
  /**
   * Runtime settings: {settingsCollection}/current, with the operator copy in
   * {settingsCollection}_public and the audit trail in {settingsCollection}_audit.
   * Must match the engine's STARFISH_SETTINGS_COLLECTION and firestore.rules.
   */
  settingsCollection: string;
  /**
   * Ingest run records: {runCollection}/last_run is what the engine writes after each run.
   * Must match the engine's STARFISH_RUN_COLLECTION and firestore.rules.
   */
  runCollection: string;
  /**
   * Agent cycles and their run events (Live runs): {cycleCollection}/{id} and /events/{seq}.
   * Must match the engine's STARFISH_CYCLE_COLLECTION and firestore.rules.
   */
  cycleCollection: string;
  /**
   * The trimmed copies a guest reads instead of the three above (#18): incidents, cycles, and run events in one flat
   * collection. Written by the engine only (src/publicView.ts). Must match the engine's
   * STARFISH_PUBLIC_INCIDENT_COLLECTION / _CYCLE_ / _EVENT_ and firestore.rules.
   */
  publicIncidentCollection: string;
  publicCycleCollection: string;
  publicEventCollection: string;
  /**
   * The on-call policy ({onCallCollection}/policy) and people ({onCallPeopleCollection}/{id}), admins only (#37). Must
   * match the engine's STARFISH_ONCALL_COLLECTION / STARFISH_ONCALL_PEOPLE_COLLECTION and firestore.rules.
   */
  onCallCollection: string;
  onCallPeopleCollection: string;
  /**
   * The engine counts as stopped when its last run finished longer ago than this. Set it to
   * about three times the schedule's interval: the engine does not know its own cadence.
   */
  engineStaleMinutes: number;
  /**
   * Base URL of the admin API (src/adminApi.ts): "Run ingest now" and "Retire". Empty when none is
   * configured, and then the UI shows neither control. Must be https, or http on localhost.
   */
  adminApiUrl: string;
  /** Label for the environment the incidents come from. */
  environment: string;
  /** Region the watched Cloud Functions deploy to, for Cloud Logging links. */
  functionsRegion: string;
  /** Use the local Auth + Firestore emulators (`pnpm dev:emulated`), never a real project. */
  useEmulators: boolean;
  /** Firebase App Check (#12): see `AppCheckConfig`. */
  appCheck: AppCheckConfig;
}

/**
 * Firebase App Check (#12). Optional: with no site key App Check is not initialised and the UI works exactly as before
 * (it then cannot read a database whose App Check enforcement is on, guests included; docs/setup.md).
 */
export interface AppCheckConfig {
  /** The reCAPTCHA site key of the web app's App Check registration. "" = App Check off. */
  siteKey: string;
  /** Which reCAPTCHA the key belongs to: "enterprise" (the default) or "v3". */
  provider: "enterprise" | "v3";
  /**
   * A debug token for local development against a real project whose enforcement is on, honoured only by the Vite dev
   * server (never by a production build): a registered token string, or `true` for the SDK to print a new one to the
   * console for you to register. Undefined: none.
   */
  debugToken?: string | true;
}

/** The App Check settings from the environment. A bad provider value falls back to enterprise rather than blocking startup. */
export function readAppCheckConfig(env: Record<string, unknown>): AppCheckConfig {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const siteKey = str(env.VITE_STARFISH_APPCHECK_SITE_KEY);
  const provider = str(env.VITE_STARFISH_APPCHECK_PROVIDER).toLowerCase() === "v3" ? "v3" : "enterprise";
  // Vite sets DEV to true only for `vite` (the dev server), never for `vite build`.
  const dev = env.DEV === true || env.DEV === "true";
  const raw = str(env.VITE_STARFISH_APPCHECK_DEBUG_TOKEN);
  const debugToken = !dev || raw === "" ? undefined : raw.toLowerCase() === "true" ? true : raw;
  return { siteKey, provider, ...(debugToken !== undefined && { debugToken }) };
}

/** A number above zero, else the default: a bad value here only affects a status line, so it never blocks startup. */
function positiveMinutes(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A usable admin API base URL without its trailing slash, or "" (a bad value only hides the controls, it never blocks startup). */
export function normalizeAdminApiUrl(raw: string | undefined): string {
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "";
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "";
  if (url.username || url.password || url.search || url.hash) return "";
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

let cached: WebConfig | undefined;
let inflight: Promise<WebConfig> | undefined;

/**
 * Resolve the config once, before anything renders. `webConfig()` stays
 * synchronous for every caller; it just can't be called before this settles.
 * Concurrent calls share one resolution (React StrictMode runs an effect
 * twice in development); after a failure the next call tries again.
 */
export function bootstrapWebConfig(
  env: Record<string, string | undefined> = import.meta.env,
  fetchImpl: typeof fetch = fetch
): Promise<WebConfig> {
  if (cached) return Promise.resolve(cached);
  inflight ??= resolveFirebaseConfig(env, fetchImpl).then(
    (firebase) => {
      cached = {
        firebase,
        databaseId: env.VITE_STARFISH_DATABASE_ID || "starfish",
        incidentCollection: env.VITE_STARFISH_INCIDENT_COLLECTION || "incidents",
        usersCollection: env.VITE_STARFISH_USERS_COLLECTION || "starfish_users",
        settingsCollection: env.VITE_STARFISH_SETTINGS_COLLECTION || "starfish_settings",
        runCollection: env.VITE_STARFISH_RUN_COLLECTION || "starfish_runs",
        cycleCollection: env.VITE_STARFISH_CYCLE_COLLECTION || "starfish_cycles",
        publicIncidentCollection: env.VITE_STARFISH_PUBLIC_INCIDENT_COLLECTION || "starfish_public_incidents",
        publicCycleCollection: env.VITE_STARFISH_PUBLIC_CYCLE_COLLECTION || "starfish_public_cycles",
        publicEventCollection: env.VITE_STARFISH_PUBLIC_EVENT_COLLECTION || "starfish_public_events",
        onCallCollection: env.VITE_STARFISH_ONCALL_COLLECTION || "starfish_oncall",
        onCallPeopleCollection: env.VITE_STARFISH_ONCALL_PEOPLE_COLLECTION || "starfish_oncall_people",
        engineStaleMinutes: positiveMinutes(env.VITE_STARFISH_STALE_MINUTES, 90),
        adminApiUrl: normalizeAdminApiUrl(env.VITE_STARFISH_ADMIN_API_URL),
        environment: env.VITE_STARFISH_ENV || "dev",
        functionsRegion: env.VITE_FUNCTIONS_REGION || "us-central1",
        useEmulators: env.VITE_USE_EMULATORS === "1",
        appCheck: readAppCheckConfig(env),
      };
      return cached;
    },
    (err: unknown) => {
      inflight = undefined;
      throw err;
    }
  );
  return inflight;
}

export function webConfig(): WebConfig {
  if (!cached) throw new Error("webConfig() called before bootstrapWebConfig() settled");
  return cached;
}
