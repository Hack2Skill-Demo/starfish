/**
 * The runtime settings an operator can see: the copy in `<settings>_public`.
 *
 * It is read after sign-in (it needs a role), so the build-time environment label
 * stays the fallback. With no settings document that is exactly right. When the read
 * FAILS (rules not deployed yet, a network blip, a viewer who may not read it) the
 * fallback is a guess, and useEnvironment reports it so the page can say so.
 */
import { useQuery } from "@tanstack/react-query";
import { firestore } from "./firebase";
import { webConfig } from "./config";
import { readPublicSettings, settingsCollections } from "./settingsWrite";

export const PUBLIC_SETTINGS_KEY = ["settings", "public"] as const;

export function usePublicSettings() {
  return useQuery({
    queryKey: PUBLIC_SETTINGS_KEY,
    queryFn: () => readPublicSettings(firestore(), settingsCollections(webConfig().settingsCollection)),
    // A failed read means "no override", not "keep asking": the page must not hang on it.
    retry: false,
  });
}

/**
 * The environment label incidents are filtered by: the settings override when
 * there is one, else the build-time label. `ready` is false until the settings
 * read has settled, so a page doesn't query incidents under the wrong label first.
 *
 * `settingsUnavailable` is true when the read FAILED (as opposed to there being no
 * settings, which is normal). The build-time label is then a guess: if an admin has
 * overridden the label, it is the wrong one and the incident list comes back empty
 * with no error. Callers must say so rather than show that empty list as a quiet day.
 */
export function useEnvironment(): { environment: string; ready: boolean; settingsUnavailable: boolean } {
  const settings = usePublicSettings();
  return {
    environment: settings.data?.environment ?? webConfig().environment,
    ready: !settings.isPending,
    settingsUnavailable: settings.isError,
  };
}
