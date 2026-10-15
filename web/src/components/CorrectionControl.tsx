/**
 * The feedback engine's control (src/triageRules.ts): an operator says how far Starfish should go with this incident,
 * at most. It only ever holds Starfish back: triage is capped at the level chosen, a merge waiting for its checks is
 * stopped, and a declined incident corrected to anything above noise is triaged again. "Merge" removes this person's
 * limit, never an admin's class rule. Shown to operators and admins; a guest sees nothing (firestore.rules refuses them),
 * unless the public demo's open actions are on: then a guest's correction goes to the admin API (src/publicDemo.ts).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "./ui/Button";
import { toast } from "./ui/toast";
import { useAuth } from "../auth/authCore";
import { firestore } from "../lib/firebase";
import { webConfig } from "../lib/config";
import { formatDateTime } from "../lib/formatters";
import { LEVEL_LABELS, readCorrections, saveCorrection } from "../lib/correctionWrite";
import { actsThroughAdminApi, canOperate } from "../lib/dataSource";
import { appAdminApi, correctTriageAsVisitor } from "../lib/adminApi";
import type { IncidentRow } from "../lib/incidents";
import { LEVELS, MAX_NOTE, type Level } from "../../../src/triageRules";

export function CorrectionControl({ row }: { row: IncidentRow }) {
  const { user, roles, guest } = useAuth();
  const viaApi = guest && actsThroughAdminApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<Level>(row.correction?.level ?? "log");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Operators and admins; a public demo visitor where its open actions are on (sent through the admin API). Never on a
  // trimmed copy, which is not the stored incident.
  const allowed = user !== null && canOperate(roles, guest) && (!guest || viaApi) && !row.trimmed;
  const history = useQuery({
    queryKey: ["corrections", row.id],
    queryFn: () => readCorrections(firestore(), webConfig().incidentCollection, row.id),
    enabled: allowed && open,
    retry: false,
  });
  if (!allowed) return null;

  const save = async () => {
    setBusy(true);
    try {
      if (viaApi) {
        const r = await correctTriageAsVisitor(appAdminApi(), row.id, level, note);
        if (!r.ok) throw new Error(r.message);
      } else {
        await saveCorrection(firestore(), webConfig().incidentCollection, row.id, user.uid, level, note);
      }
      toast.success("Correction saved. Starfish goes no further than this with the incident.");
      setNote("");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["incident"] });
      await queryClient.invalidateQueries({ queryKey: ["corrections", row.id] });
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Couldn't save the correction.");
    } finally {
      setBusy(false);
    }
  };

  const current = row.correction;
  return (
    <div className="space-y-2" data-testid="correction">
      {current && (
        <p className="text-xs text-gray-700 dark:text-gray-300">
          Corrected to <span className="font-medium">{current.level}</span>
          {current.at ? ` on ${formatDateTime(current.at)}` : ""}
          {current.note ? `: ${current.note}` : ""}
        </p>
      )}
      {!open ? (
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Correct triage
        </Button>
      ) : (
        <div role="group" aria-label="Correct triage" className="space-y-2 rounded-lg border border-gray-300 p-3 dark:border-gray-700">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            How far should Starfish go with this incident, at most? A correction only holds Starfish back: it never makes it
            merge or fix more than its own triage and the admin&apos;s rules allow. Every correction is kept.
          </p>
          <label className="block text-sm text-gray-700 dark:text-gray-300">
            At most
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as Level)}
              className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-gray-700 dark:text-gray-300">
            Why (optional)
            <input
              value={note}
              maxLength={MAX_NOTE}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </label>
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save correction"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
          {history.data && history.data.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Earlier corrections</p>
              <ul className="mt-1 space-y-0.5 text-xs text-gray-600 dark:text-gray-400">
                {history.data.map((h) => (
                  <li key={h.id}>
                    {h.at ? formatDateTime(h.at) : "unknown time"}: {h.level}
                    {h.note ? `: ${h.note}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
