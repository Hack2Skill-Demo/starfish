/**
 * Everything deployment-specific about the web UI, and the only file in web/src
 * that reads import.meta.env — the UI's counterpart to the engine's
 * src/config.ts. Nobody should have to edit a component to point Starfish at
 * their own project.
 */

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set — copy web/.env.example to web/.env`);
  return value;
}

export interface WebConfig {
  firebase: { apiKey: string; authDomain: string; projectId: string; appId: string };
  /** Firestore database id; must match the engine's STARFISH_DATABASE_ID. */
  databaseId: string;
  /** Must match the engine's STARFISH_INCIDENT_COLLECTION. */
  incidentCollection: string;
  /** Operator records: {uid} → { roles: StarfishRole[] }. */
  usersCollection: string;
  /** Curated synthetic evidence only; viewers cannot read the engine store. */
  demoIncidentCollection: string;
  /** Label for the environment the incidents come from. */
  environment: string;
  /** Region the watched Cloud Functions deploy to, for Cloud Logging links. */
  functionsRegion: string;
  /** Use the local Auth + Firestore emulators (`pnpm dev:emulated`), never a real project. */
  useEmulators: boolean;
}

let cached: WebConfig | undefined;

export function webConfig(): WebConfig {
  const env = import.meta.env;
  cached ??= {
    firebase: {
      apiKey: required("VITE_FIREBASE_API_KEY", env.VITE_FIREBASE_API_KEY),
      authDomain: required("VITE_FIREBASE_AUTH_DOMAIN", env.VITE_FIREBASE_AUTH_DOMAIN),
      projectId: required("VITE_FIREBASE_PROJECT_ID", env.VITE_FIREBASE_PROJECT_ID),
      appId: required("VITE_FIREBASE_APP_ID", env.VITE_FIREBASE_APP_ID),
    },
    databaseId: env.VITE_STARFISH_DATABASE_ID || "starfish",
    incidentCollection: env.VITE_STARFISH_INCIDENT_COLLECTION || "incidents",
    usersCollection: env.VITE_STARFISH_USERS_COLLECTION || "starfish_users",
    demoIncidentCollection: env.VITE_STARFISH_DEMO_INCIDENT_COLLECTION || "demo_incidents",
    environment: env.VITE_STARFISH_ENV || "dev",
    functionsRegion: env.VITE_FUNCTIONS_REGION || "us-central1",
    useEmulators: env.VITE_USE_EMULATORS === "1",
  };
  return cached;
}
