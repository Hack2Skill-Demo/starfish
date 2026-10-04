/**
 * The runtime settings an operator can see: the copy in `<settings>_public`.
 *
 * It is read after sign-in (it needs a role), so the build-time environment label
 * stays the fallback: when no settings exist, or the read fails (the rules not
 * deployed yet, a network blip), the UI behaves exactly as it did before.
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
 */
export function useEnvironment(): { environment: string; ready: boolean } {
  const settings = usePublicSettings();
  return { environment: settings.data?.environment ?? webConfig().environment, ready: !settings.isPending };
}
