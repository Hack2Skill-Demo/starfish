/**
 * "What you can do now": on a run that ended with a person told, the steps that person has (src/handoff.ts, the same
 * list the Slack "needs a human" message carries), each beside the control that does it. Anyone may read it, a guest
 * included; the buttons show only for a role, and firestore.rules checks the role and the transition again.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Check, CheckCircle, ExternalLink, EyeOff, PencilLine } from "lucide-react";
import { handoffSteps, type HandoffPath } from "../../../src/handoff";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { toast } from "./ui/toast";
import { useAuth } from "../auth/authCore";
import { applyAction, nextStatus, type IncidentAction, type IncidentRow } from "../lib/incidents";
import { RetryRunButton } from "./RetryRunButton";

const DONE: Record<IncidentAction, string> = { acknowledge: "Acknowledged", resolve: "Resolved", ignore: "Ignored", reopen: "Reopened" };
const ICON = { acknowledge: Check, resolve: CheckCircle, ignore: EyeOff };

export function HandoffCard({
  path,
  incidentId,
  incident,
  issueUrl,
  canRetry,
  onChanged,
  act = applyAction,
}: {
  path: HandoffPath;
  incidentId: string;
  /** The stored incident; the page shows the card only while it is open. */
  incident: IncidentRow;
  issueUrl?: string;
  canRetry: boolean;
  /** After a status change: re-read the incident. */
  onChanged?: () => void;
  act?: (row: IncidentRow, action: IncidentAction, uid: string) => Promise<void>;
}) {
  const { user, roles } = useAuth();
  const [busy, setBusy] = useState<IncidentAction | null>(null);
  const canAct = user !== null && roles.length > 0;

  const statusButton = (action: "acknowledge" | "resolve" | "ignore", label: string): ReactNode => {
    if (!canAct || nextStatus(incident.status, action) === null) return null;
    const Icon = ICON[action];
    const click = async () => {
      setBusy(action);
      try {
        await act(incident, action, user.uid);
        toast.success(`${DONE[action]}.`);
        onChanged?.();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Couldn't ${action} the incident.`);
      } finally {
        setBusy(null);
      }
    };
    return (
      <Button variant="secondary" size="sm" onClick={click} disabled={busy !== null} aria-busy={busy === action}>
        <Icon className="h-4 w-4" aria-hidden /> {busy === action ? "Saving…" : label}
      </Button>
    );
  };

  const controls: Record<string, ReactNode> = {
    acknowledge:
      incident.status === "acknowledged" ? (
        <Badge tone="success">Acknowledged</Badge>
      ) : incident.status !== "new" ? (
        <span className="text-xs text-gray-600 dark:text-gray-400">Only a new incident can be acknowledged; this one is {incident.status}.</span>
      ) : (
        statusButton("acknowledge", "Acknowledge")
      ),
    fix: (
      <>
        {issueUrl && (
          <a
            href={issueUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            Open the issue <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        )}
        {statusButton("resolve", "Mark resolved")}
      </>
    ),
    retry: canRetry ? <RetryRunButton incidentId={incidentId} /> : null,
    correct: (
      <Link
        to={`/incidents/${encodeURIComponent(incidentId)}`}
        className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
      >
        <PencilLine className="h-4 w-4" aria-hidden /> Correct triage on the incident&apos;s page
      </Link>
    ),
    ignore: statusButton("ignore", "Ignore"),
  };

  return (
    <section
      aria-label="What you can do now"
      className="space-y-3 rounded-xl border border-warning-300 bg-warning-50 p-5 sm:p-6 dark:border-warning-700 dark:bg-warning-900/20"
    >
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-white">What you can do now</h3>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
          Starfish stopped here and told a person{path === "human" ? ": its fix did not get through" : ": triage judged no code change fixes this"}.
          It does not try this run again on its own: it waits for one of these.
        </p>
      </div>
      <ol className="divide-y divide-warning-200 dark:divide-warning-800">
        {handoffSteps(path, issueUrl !== undefined).map((step) => (
          <li key={step.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-[1_1_20rem]">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">{step.title}</p>
              <p className="text-sm text-gray-700 dark:text-gray-300">{step.text}</p>
            </div>
            {controls[step.id] && <div className="flex flex-wrap items-center gap-2">{controls[step.id]}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}
