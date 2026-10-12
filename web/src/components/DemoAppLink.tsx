import { ExternalLink, FlaskConical } from "lucide-react";
import { webConfig } from "../lib/config";

/**
 * The public demo's way into the app Starfish watches: its Lab, where a visitor breaks one part on purpose and then
 * watches the incident arrive here. Only when the build sets `VITE_STARFISH_DEMO_APP_URL`; unset, nothing renders, which
 * is how a private deployment (or the demo after its event) has no such link.
 */
export function DemoAppLink() {
  const url = webConfig().demoAppUrl;
  if (!url) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 p-4 text-sm text-gray-800 dark:border-brand-800 dark:bg-brand-900/20 dark:text-gray-200">
      <FlaskConical className="h-4 w-4 flex-shrink-0 text-brand-700 dark:text-brand-300" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Want to watch Starfish take on a new incident? Break one part of the demo shop on purpose from its Lab (it asks
        for the access code the team gave you), then come back here.
      </span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline dark:text-brand-300"
      >
        Open the demo shop&apos;s Lab
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}
