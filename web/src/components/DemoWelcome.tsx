/**
 * The public demo's welcome guide (#12): three short steps on what Starfish is, how an incident moves through it, and
 * where to look. It opens by itself once per tab and from the header any time (StarfishLayout). Its last
 * step offers "Don't show this again", kept in this browser only (`setWelcomeDismissed`): ticked, it stops opening by
 * itself, however the guide is then closed.
 *
 * A guest who did not choose the view-only demo (made a guest on arrival) is asked to sign in, and told where the
 * sign-in details are (`signInHint`, never the credentials). One who chose it, or a signed-in visitor, is not asked.
 *
 * Where the public demo's open actions are on (`visitorActions`), a guest is told what they can do without signing in
 * and that those actions are limited per IP address to protect billing; the view-only wording is not shown then.
 *
 * Every claim here is about what the code does; whether a stage has run on a real incident is what the pages show.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { ExternalLink, LogIn, X } from "lucide-react";
import { Button } from "./ui/Button";
import { isWelcomeDismissed, markGuestViewChosen, setWelcomeDismissed, signInHint, visitorActions } from "../lib/demoGuide";

const FLOW: { name: string; text: string }[] = [
  {
    name: "Ingest",
    text: "Reads the watched project's new error logs on a schedule and folds repeats of one error into one incident.",
  },
  { name: "Triage", text: "Gemini judges whether it needs action and how far to go: noise, log it, or attempt a fix." },
  { name: "Fix", text: "Gemini drafts a minimal patch, or declines when there is no confident one-step fix." },
  { name: "Verify", text: "Deterministic, not a model: here, the watched project's own CI checks judge the patch." },
  { name: "Review", text: "A second Gemini pass attacks the verified patch before anything is opened." },
  { name: "Pull request", text: "Opened with its evidence. Then Starfish stops and a person decides." },
];

const PAGES: { name: string; text: string }[] = [
  { name: "Overview", text: "Is the engine alive, and what is waiting on a person." },
  { name: "Incidents", text: "Each error, how often it fires, and what the agent decided. Open one for its evidence." },
  { name: "Runs", text: "Every agent run, step by step, with its log." },
  { name: "Settings", text: "The switches and rules an admin controls." },
];

const STEP_TITLES = ["Meet Starfish", "How an incident moves", "Take a look around"] as const;

/** The focusable elements of the dialog, in order, for keeping Tab inside it (the last step's checkbox included, #359). */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

export function DemoWelcome({
  guest,
  askToSignIn,
  onClose,
}: {
  /** The viewer is a guest (an anonymous session: read-only, unless the public demo's open actions are on). */
  guest: boolean;
  /** A guest who did not choose the view-only demo: ask them to sign in. */
  askToSignIn: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(isWelcomeDismissed);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const last = step === STEP_TITLES.length - 1;
  // Where the public demo's open actions are on: what a visitor can do, and the limits that protect our billing.
  const open = visitorActions();

  // Focus moves into the dialog when it opens and back to where it was when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => before?.focus?.();
  }, []);

  // Next and Back can unmount the button that was pressed ("Next" is gone on the last step, "Back" on the first), and
  // focus would fall to the page, outside the overlay that holds Escape and the Tab trap (#359). Each new step puts
  // focus on its heading instead, so it is also read out.
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    heading.current?.focus();
  }, [step]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = focusables(panel.current);
    if (items.length === 0) return;
    const first = items[0];
    const end = items[items.length - 1];
    // Shift+Tab from the first control, or from something the trap does not list (the panel, a step's heading), wraps.
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !active || !items.includes(active))) {
      e.preventDefault();
      end.focus();
    } else if (!e.shiftKey && document.activeElement === end) {
      e.preventDefault();
      first.focus();
    }
  };

  const signIn = () => {
    onClose();
    navigate("/signin", { state: { from: location } });
  };
  const toggleDontShowAgain = (checked: boolean) => {
    setDontShowAgain(checked);
    setWelcomeDismissed(checked);
  };
  const continueViewOnly = () => {
    markGuestViewChosen();
    onClose();
  };

  const signInCallout = askToSignIn && (
    <div className="rounded-lg border border-brand-200 bg-brand-50 p-4 text-sm text-gray-800 dark:border-brand-800 dark:bg-brand-900/20 dark:text-gray-200">
      <p className="font-medium">You are in the view-only demo. Sign in for the full records.</p>
      <p className="mt-1 text-gray-700 dark:text-gray-300">{signInHint()}</p>
      <Button size="sm" className="mt-3" onClick={signIn}>
        <LogIn className="h-4 w-4" />
        Sign in
      </Button>
    </div>
  );

  const openCallout = guest && open && (
    <div data-testid="visitor-actions" className="rounded-lg border border-brand-200 bg-brand-50 p-4 text-sm text-gray-800 dark:border-brand-800 dark:bg-brand-900/20 dark:text-gray-200">
      <p className="font-medium">{open.full}</p>
      <p className="mt-1 text-gray-700 dark:text-gray-300">{open.limits}</p>
    </div>
  );

  let body: ReactNode;
  if (step === 0) {
    body = (
      <>
        {signInCallout}
        {openCallout}
        <p className="text-base font-medium text-gray-900 dark:text-white">
          An AI ops engineer for teams that don't have one.
        </p>
        <p>
          Starfish watches a Firebase or Google Cloud project's error logs, judges which incidents are urgent, and
          drafts a fix with Gemini on Vertex AI. The fix is checked by the project's own tests and attacked by a second
          review before Starfish opens a pull request.
        </p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            One incident per error, however often it fires; one that comes back after a fix is reopened as a regression.
          </li>
          <li>When it has no confident fix, it says so and hands the incident to a person instead of guessing.</li>
          <li>
            It stops at a pull request. It merges only where an admin has turned that on, for the cases they listed,
            with every check green.
          </li>
          <li>An admin's rules and an operator's corrections can only hold it back, never push it further.</li>
        </ul>
      </>
    );
  } else if (step === 1) {
    body = (
      <ol className="space-y-3">
        {FLOW.map((s, i) => (
          <li key={s.name} className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand-700 text-xs font-semibold text-white"
            >
              {i + 1}
            </span>
            <span>
              <span className="font-medium text-gray-900 dark:text-white">{s.name}.</span> {s.text}
            </span>
          </li>
        ))}
      </ol>
    );
  } else {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    body = (
      <>
        <dl className="space-y-2">
          {PAGES.map((p) => (
            <div key={p.name}>
              <dt className="inline font-medium text-gray-900 dark:text-white">{p.name}: </dt>
              <dd className="inline">{p.text}</dd>
            </div>
          ))}
        </dl>
        <p>
          Everything shown is what this deployment recorded from the project it watches. A record marked Synthetic is an
          illustration, not a run that happened.
        </p>
        {guest && !open && (
          <p>
            The view-only demo shows trimmed copies: no stack traces, error detail, Gemini's reasoning or patches.
            {!askToSignIn && " Sign in from the bar at the bottom to see them."}
          </p>
        )}
        {guest && open && <p>{open.limits}</p>}
        {signInCallout}
        {origin && (
          <p className="text-gray-600 dark:text-gray-400">
            Demo link, to open it again or on another device:{" "}
            <a
              href={origin}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 break-all font-medium text-brand-700 hover:underline dark:text-brand-400"
            >
              {origin.replace(/^https?:\/\//, "")}
              <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            </a>
          </p>
        )}
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onKeyDown={onKeyDown}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-lg flex-col rounded-xl border border-gray-200 bg-white shadow-xl focus:outline-none dark:border-gray-700 dark:bg-gray-800"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
              Step {step + 1} of {STEP_TITLES.length}
            </p>
            <h2 id={titleId} ref={heading} tabIndex={-1} className="mt-1 text-lg font-semibold text-gray-900 focus:outline-none dark:text-white">
              {STEP_TITLES[step]}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the guide"
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-6 py-5 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
          {body}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          <div className="flex flex-wrap items-center gap-3">
            {step > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            {last && (
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={dontShowAgain}
                  onChange={(e) => toggleDontShowAgain(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 accent-brand-700 dark:border-gray-600"
                />
                Don't show this again
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {!last && (
              <Button size="sm" onClick={() => setStep(step + 1)}>
                Next
              </Button>
            )}
            {last && askToSignIn && (
              <Button variant="secondary" size="sm" onClick={continueViewOnly}>
                Continue view-only
              </Button>
            )}
            {last && !askToSignIn && (
              <Button size="sm" onClick={onClose}>
                Start exploring
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
