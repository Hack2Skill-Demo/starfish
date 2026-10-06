/**
 * Firebase App Check for the web app (#12): with a site key configured, every Firestore request (and the admin API
 * call, src/lib/adminApi.ts) carries a token proving it comes from this registered web app, so a project that turns
 * App Check enforcement on for Firestore serves only this app. Optional by design: no site key, no App Check, and the
 * UI (guests included) behaves exactly as it did before. Enforcement itself is a project setting, not code
 * (docs/setup.md).
 *
 * Nothing here throws into the caller: App Check failing to start is logged and the app carries on without it. With
 * enforcement off that changes nothing; with it on, reads are refused by Firestore, which the pages already report.
 */
import type { FirebaseApp } from "firebase/app";
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  ReCaptchaV3Provider,
  type AppCheck,
} from "firebase/app-check";
import type { AppCheckConfig } from "./config";

/** The SDK calls this module makes, injectable so the decisions are testable without reCAPTCHA. */
export interface AppCheckSdk {
  initializeAppCheck: typeof initializeAppCheck;
  getToken: typeof getToken;
  enterprise: (siteKey: string) => ReCaptchaEnterpriseProvider;
  v3: (siteKey: string) => ReCaptchaV3Provider;
}

const realSdk: AppCheckSdk = {
  initializeAppCheck,
  getToken,
  enterprise: (k) => new ReCaptchaEnterpriseProvider(k),
  v3: (k) => new ReCaptchaV3Provider(k),
};

/** Why App Check is or is not started, so the decision is one tested function. */
export function appCheckMode(cfg: AppCheckConfig, useEmulators: boolean): "off" | "emulators" | "on" {
  if (!cfg.siteKey) return "off";
  // The emulators do not check App Check tokens, and reCAPTCHA would refuse localhost anyway.
  if (useEmulators) return "emulators";
  return "on";
}

let instance: AppCheck | undefined;

/**
 * Start App Check on the app, before the first Firestore call (src/lib/firebase.ts calls this right after
 * initializeApp). Returns the instance, or undefined when App Check is off or failed to start.
 */
export function startAppCheck(
  app: FirebaseApp,
  cfg: AppCheckConfig,
  useEmulators: boolean,
  sdk: AppCheckSdk = realSdk,
  global: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): AppCheck | undefined {
  if (appCheckMode(cfg, useEmulators) !== "on") return undefined;
  // The SDK reads the debug token from this global when it initialises. readAppCheckConfig only yields one in a dev build.
  if (cfg.debugToken !== undefined) global.FIREBASE_APPCHECK_DEBUG_TOKEN = cfg.debugToken;
  try {
    instance = sdk.initializeAppCheck(app, {
      provider: cfg.provider === "v3" ? sdk.v3(cfg.siteKey) : sdk.enterprise(cfg.siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    console.error("App Check did not start; continuing without it:", err);
    instance = undefined;
  }
  return instance;
}

/**
 * The current App Check token for a request to the admin API, or null when App Check is off or has no token. Never
 * throws: the server, when it requires App Check, answers a missing token with the same 401 as any other.
 */
export async function appCheckToken(sdk: Pick<AppCheckSdk, "getToken"> = realSdk, appCheck: AppCheck | undefined = instance): Promise<string | null> {
  if (!appCheck) return null;
  try {
    const result = await sdk.getToken(appCheck, false);
    // On a failure the SDK can resolve with a placeholder token and an `error` field rather than reject.
    if ((result as { error?: unknown }).error !== undefined) return null;
    return typeof result.token === "string" && result.token !== "" ? result.token : null;
  } catch {
    return null;
  }
}
