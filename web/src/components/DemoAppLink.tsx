/**
 * The public demo's way into the app Starfish watches: its Lab, where a visitor breaks one part on purpose and then
 * watches the incident arrive here. Only when the build sets `VITE_STARFISH_DEMO_APP_URL`; unset, nothing renders, which
 * is how a private deployment (or the demo after its event) has no such link. The Incidents page carries it as a
 * banner (`DemoAppLink`); every page's header as a flask button that opens the same words in a dialog (`DemoLabButton`).
 */
import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink, FlaskConical, X } from "lucide-react";
import { webConfig } from "../lib/config";
import { keepTabInside } from "./ui/dialogFocus";

const INVITE =
  "Want to watch Starfish take on a new incident? Break one part of the demo shop on purpose from its Lab (it asks " +
  "for the access code the team gave you), then come back here.";

function LabLink({ url, className }: { url: string; className: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className={className}>
      Open the demo shop&apos;s Lab
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

export function DemoAppLink() {
  const url = webConfig().demoAppUrl;
  if (!url) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 p-4 text-sm text-gray-800 dark:border-brand-800 dark:bg-brand-900/20 dark:text-gray-200">
      <FlaskConical className="h-4 w-4 flex-shrink-0 text-brand-700 dark:text-brand-300" aria-hidden="true" />
      <span className="min-w-0 flex-1">{INVITE}</span>
      <LabLink
        url={url}
        className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline dark:text-brand-300"
      />
    </div>
  );
}

/** The header's flask button: opens the Lab invitation in a dialog. Nothing when no demo app is configured. */
export function DemoLabButton() {
  const url = webConfig().demoAppUrl;
  const [open, setOpen] = useState(false);
  if (!url) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Break the demo shop on purpose: open its Lab"
        title="The demo shop's Lab"
        className="rounded-lg border border-gray-200 p-2 text-gray-500 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700/50"
      >
        <FlaskConical className="h-4 w-4" />
      </button>
      {open && <DemoLabDialog url={url} onClose={() => setOpen(false)} />}
    </>
  );
}

function DemoLabDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const titleId = useId();
  const textId = useId();
  const panel = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog when it opens and back to the flask button when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => before?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    keepTabInside(e, panel.current);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl focus:outline-none dark:border-gray-700 dark:bg-gray-800"
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300">
              <FlaskConical className="h-5 w-5" aria-hidden="true" />
            </span>
            <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-white">
              The demo shop&apos;s Lab
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p id={textId} className="px-6 py-4 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
          {INVITE}
        </p>
        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Not now
          </button>
          <LabLink
            url={url}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-700 px-3 text-sm font-medium text-white hover:bg-brand-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/20"
          />
        </div>
      </div>
    </div>
  );
}
