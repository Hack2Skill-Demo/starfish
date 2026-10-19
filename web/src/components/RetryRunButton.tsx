/**
 * "Retry with agent": asks the agent to run a finished incident's cycle again, with the engine as it is now. Only for a
 * run a person was told about or that was declined, on an open incident; for anyone with a role (the rules check the
 * role again). The same cycle is reused, so it files no second issue and opens no second pull request; its Slack
 * messages go out again for the new round, worded as a retry.
 *
 * The request alone runs on the next agent pass. For an admin on a build with the admin API it also starts that pass at
 * once (`POST /api/agent/run`, #276), as "Run agent now" does, so the retry runs without waiting for the schedule; the
 * agent's status then says a start was requested (`lib/agentStart.ts`). An operator's retry waits for the next pass:
 * starting the agent stays an admin's action, and the server checks the role again either way. Where the public demo's
 * open actions are on, a visitor's retry goes to the admin API and starts a pass too, within the visitor's hourly limits.
 *
 * Held back (#456): the engine reopens a run at most a few times a day (src/reopenLimit.ts). When the page knows the run
 * has reached that limit (`hold`, lib/retryHold.ts), the button is disabled and says, beside it, how many reopenings,
 * the limit, and when a retry can start again; a request already made stands until then.
 */
import { useState } from "react";
import { Bot } from "lucide-react";
import { Button } from "./ui/Button";
import { toast } from "./ui/toast";
import { useAuth } from "../auth/authCore";
import { requestRetriage } from "../lib/incidents";
import { webConfig } from "../lib/config";
import { markAgentStartRequested } from "../lib/agentStart";
import { appAdminApi, runAgentNow, type AdminResult } from "../lib/adminApi";
import { actsThroughAdminApi, canOperate } from "../lib/dataSource";
import { formatDateTime } from "../lib/formatters";
import { retryHoldWords, type RetryHold } from "../lib/retryHold";

export function RetryRunButton({
  incidentId,
  ask = requestRetriage,
  startAgent = () => runAgentNow(appAdminApi()),
  size = "sm",
  hold = null,
  onDark = false,
}: {
  incidentId: string;
  ask?: (incidentId: string, uid: string) => Promise<void>;
  /** Starts one agent pass; called only for an admin on a build with the admin API. */
  startAgent?: () => Promise<AdminResult<null>>;
  /** `md` matches the run hero's other actions (44 px). */
  size?: "sm" | "md";
  /** The daily reopen limit holds a retry back now (lib/retryHold.ts): disabled, with why and until when. */
  hold?: RetryHold | null;
  /** On the run hero's dark card: the note beside the button in light text. */
  onDark?: boolean;
}) {
  const { user, roles, guest } = useAuth();
  const [state, setState] = useState<"idle" | "busy" | "requested" | "started">("idle");
  if (!user || !canOperate(roles, guest)) return null;
  // An admin, or a public demo visitor where its open actions are on, also starts the pass (within the visitor's limits).
  const canStart = (roles.includes("admin") || actsThroughAdminApi()) && Boolean(webConfig().adminApiUrl);

  const click = async () => {
    setState("busy");
    try {
      await ask(incidentId, user.uid);
    } catch (e) {
      setState("idle");
      // A visitor's refusal comes from the admin API with its own reason (a limit reached, say).
      toast.error(
        actsThroughAdminApi() && e instanceof Error && e.message
          ? e.message
          : "The retry could not be requested. It is allowed only on an open incident, for an operator."
      );
      return;
    }
    if (!canStart) {
      setState("requested");
      toast.success("Retry requested. The next scheduled agent pass runs this again (an admin's retry starts one at once). It files nothing twice.");
      return;
    }
    // The retry is recorded before the pass starts, so the pass it starts is the one that picks it up.
    const started = await startAgent();
    if (!started.ok) {
      setState("requested");
      toast.error(`Retry requested, but the agent pass could not be started: ${started.message} The next scheduled pass runs it.`);
      return;
    }
    setState("started");
    markAgentStartRequested();
    toast.success("Retry requested and an agent pass started. It takes a few minutes; this run updates as the agent records it. It files nothing twice.");
  };

  const label = state === "started" ? "Agent started" : state === "requested" ? "Retry requested" : state === "busy" ? "Requesting…" : "Retry with agent";
  // Only before a press: once this tab asked, the toast and the label say what happened, and the run says the rest.
  if (hold && state === "idle") {
    const noteId = `retry-hold-${incidentId}`;
    return (
      <span className="inline-flex max-w-md flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="secondary" size={size} disabled aria-describedby={noteId}>
          <Bot className="h-4 w-4" aria-hidden /> Retry with agent
        </Button>
        <span id={noteId} role="note" className={onDark ? "text-xs text-gray-300" : "text-xs text-gray-700 dark:text-gray-300"}>
          {retryHoldWords(hold, formatDateTime(hold.nextPossibleAt))}
        </span>
      </span>
    );
  }
  return (
    <Button
      variant="secondary"
      size={size}
      onClick={click}
      disabled={state !== "idle"}
      aria-busy={state === "busy"}
      title={
        canStart
          ? "Runs this again now, with the engine as it is: starts an agent pass. The same run is reused: no second issue, alert, message or pull request."
          : "Runs this again on the next agent pass, with the engine as it is then. The same run is reused: no second issue, alert, message or pull request."
      }
    >
      <Bot className="h-4 w-4" aria-hidden /> {label}
    </Button>
  );
}
