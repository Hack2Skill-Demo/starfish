/**
 * The admin-only controls over the admin API (#63, #65): "Run ingest now" on the Incidents page, "Run agent now" on
 * the Runs page (#276) and "Retire" on an incident. They render only for an admin and only when the site was built with an admin API URL
 * (the two run buttons also for a public demo visitor where its open actions are on; Retire never); the
 * server checks the role again on every call, so these are a convenience and never the gate. An outcome is
 * reported as the engine reported it: a run that failed says so, and nothing is called done early.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Play, Archive, Workflow } from "lucide-react";
import { Button } from "./ui/Button";
import { toast } from "./ui/toast";
import { useAuth } from "../auth/authCore";
import { webConfig } from "../lib/config";
import { markAgentStartRequested } from "../lib/agentStart";
import { actsThroughAdminApi } from "../lib/dataSource";
import { appAdminApi, retireIncident, runAgentNow, runIngestNow, type AdminApiDeps, type IngestSummary } from "../lib/adminApi";

/** True when this viewer should see the admin controls. */
export function useAdminControls(): boolean {
  const { roles } = useAuth();
  return roles.includes("admin") && Boolean(webConfig().adminApiUrl);
}

/**
 * True when this viewer should see "Run ingest now" and "Run agent now": an admin, or a public demo visitor where its
 * open actions are on (the server then counts the start against the visitor's hourly limits). Retire stays an admin's.
 */
export function useRunControls(): boolean {
  const { guest } = useAuth();
  return useAdminControls() || (guest && actsThroughAdminApi());
}

export function describeRun(s: IngestSummary): { ok: boolean; text: string } {
  // The engine's outcomes (src/ingest/run.ts): ok, idle (no window was due yet: normal, not a failure) and failed.
  // Anything else is not read as a success.
  if (s.outcome === "idle") return { ok: true, text: "Nothing to read yet: no new log window was due. Try again in a few minutes." };
  if (s.outcome !== "ok") return { ok: false, text: `The run did not finish (${s.outcome})${s.error ? `: ${s.error}` : ""}.` };
  const counts = `${s.incidentsCreated} new, ${s.incidentsUpdated} updated, ${s.incidentsRecurred} recurred`;
  return { ok: true, text: `Run finished: ${counts}${s.capped ? ". The read hit its cap, so counts are a floor." : "."}` };
}

export function RunIngestButton({ api = appAdminApi, onDone }: { api?: () => AdminApiDeps; onDone?: () => void }) {
  const show = useRunControls();
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  if (!show) return null;

  const click = async () => {
    setBusy(true);
    const r = await runIngestNow(api());
    setBusy(false);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    const d = describeRun(r.value);
    (d.ok ? toast.success : toast.error)(d.text);
    await queryClient.invalidateQueries({ queryKey: ["incidents"] });
    onDone?.();
  };

  return (
    <Button variant="secondary" size="sm" onClick={click} disabled={busy} aria-busy={busy}>
      <Play className="h-4 w-4" aria-hidden /> {busy ? "Running…" : "Run ingest now"}
    </Button>
  );
}

/**
 * Starts one agent pass (#276): the pass the schedule runs, started now, with the same switches and caps. The answer is
 * only that it started; the Runs page shows what it does as the engine records it. The agent's status is told a start was
 * requested, so it says so and watches the record until the pass shows (`lib/agentStart.ts`), with no page refresh.
 */
export function RunAgentButton({ api = appAdminApi }: { api?: () => AdminApiDeps }) {
  const show = useRunControls();
  const [busy, setBusy] = useState(false);
  if (!show) return null;

  const click = async () => {
    setBusy(true);
    const r = await runAgentNow(api());
    setBusy(false);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success("Agent pass started. It runs in its own job and takes a few minutes; its runs appear here as it records them.");
    markAgentStartRequested();
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={click}
      disabled={busy}
      aria-busy={busy}
      title="Starts the pass the schedule runs, now: same switches, same caps"
    >
      <Workflow className="h-4 w-4" aria-hidden /> {busy ? "Starting…" : "Run agent now"}
    </Button>
  );
}

export function RetireControl({ incidentId, api = appAdminApi }: { incidentId: string; api?: () => AdminApiDeps }) {
  const show = useAdminControls();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  if (!show) return null;

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Archive className="h-4 w-4" aria-hidden /> Retire
      </Button>
    );
  }

  const confirm = async () => {
    setBusy(true);
    const r = await retireIncident(api(), incidentId, reason.trim());
    setBusy(false);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success(r.value.alreadyRetired ? "Already retired." : "Incident retired. If it fires again it will be a new incident.");
    await queryClient.invalidateQueries({ queryKey: ["incidents"] });
    await queryClient.invalidateQueries({ queryKey: ["incident"] });
    navigate("/incidents");
  };

  return (
    <div role="group" aria-label="Retire this incident" className="space-y-2 rounded-lg border border-gray-300 p-3 dark:border-gray-700">
      <p className="text-sm text-gray-700 dark:text-gray-300">
        Retiring closes this incident for good and frees its fingerprint: the next occurrence starts a new incident. It is recorded in the audit trail.
      </p>
      <label className="block text-sm text-gray-700 dark:text-gray-300">
        Reason (optional)
        <input
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
        />
      </label>
      <div className="flex gap-2">
        <Button size="sm" onClick={confirm} disabled={busy}>
          {busy ? "Retiring…" : "Retire incident"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
