/**
 * "Retry with agent": asks the agent to run a finished incident's cycle again, with the engine as it is now. Only for a
 * run a person was told about or that was declined, on an open incident; for anyone with a role (the rules check the
 * role again). The retry is idempotent: the same cycle is reused, so it files no second issue, sends no second alert or
 * message and opens no second pull request. It is a request: it runs on the next agent pass.
 */
import { useState } from "react";
import { Bot } from "lucide-react";
import { Button } from "./ui/Button";
import { toast } from "./ui/toast";
import { useAuth } from "../auth/authCore";
import { requestRetriage } from "../lib/incidents";

export function RetryRunButton({
  incidentId,
  ask = requestRetriage,
  size = "sm",
}: {
  incidentId: string;
  ask?: (incidentId: string, uid: string) => Promise<void>;
  /** `md` matches the run hero's other actions (44 px). */
  size?: "sm" | "md";
}) {
  const { user, roles } = useAuth();
  const [state, setState] = useState<"idle" | "busy" | "requested">("idle");
  if (!user || roles.length === 0) return null;

  const click = async () => {
    setState("busy");
    try {
      await ask(incidentId, user.uid);
      setState("requested");
      toast.success("Retry requested. The next agent pass runs this again; use Run agent now to start one. It files nothing twice.");
    } catch {
      setState("idle");
      toast.error("The retry could not be requested. It is allowed only on an open incident, for an operator.");
    }
  };

  return (
    <Button
      variant="secondary"
      size={size}
      onClick={click}
      disabled={state !== "idle"}
      aria-busy={state === "busy"}
      title="Runs this again with the engine as it is now. The same run is reused: no second issue, alert, message or pull request."
    >
      <Bot className="h-4 w-4" aria-hidden /> {state === "requested" ? "Retry requested" : state === "busy" ? "Requesting…" : "Retry with agent"}
    </Button>
  );
}
