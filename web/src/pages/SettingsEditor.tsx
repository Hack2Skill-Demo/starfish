/**
 * SettingsEditor: the runtime settings an admin overrides, plus the recent
 * changes. The engine applies a saved document over its environment defaults
 * (src/runtimeSettings.ts); firestore.rules lets only admins write it, and every
 * save is recorded with its before and after.
 *
 * The browser can't see the engine's defaults, so each field is either "use the
 * engine's default" or an override, and the form never shows a default value.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/authCore";
import { Button } from "../components/ui/Button";
import { toast } from "../components/ui/toast";
import { firestore } from "../lib/firebase";
import { webConfig } from "../lib/config";
import { formatDateTime } from "../lib/formatters";
import {
  FIELD_NAMES,
  formFromStored,
  settingsFromForm,
  type FieldName,
  type FormState,
} from "../lib/settingsForm";
import {
  readRecentChanges,
  readSettings,
  saveSettings,
  settingsCollections,
  type StoredSettings,
} from "../lib/settingsWrite";

const FIELDS: Record<
  FieldName,
  { label: string; multiline: boolean; placeholder: string; hint: string }
> = {
  watchedProjectId: {
    label: "Watched project",
    multiline: false,
    placeholder: "my-app-prod",
    hint: "The GCP project whose logs are read for errors.",
  },
  environment: {
    label: "Environment label",
    multiline: false,
    placeholder: "prod",
    hint: "Stamped on every incident. Change it together with the watched project, or two projects' incidents share a label.",
  },
  logResourceTypes: {
    label: "Log resource types",
    multiline: true,
    placeholder: "cloud_function\ncloud_run_revision",
    hint: "One per line. Cloud Logging resource types whose errors count as incidents.",
  },
  servicePatterns: {
    label: "Service patterns",
    multiline: true,
    placeholder: "billing: payments\norders: checkout",
    hint: 'One "pattern: service" per line. A function whose name contains the pattern is attributed to the service.',
  },
  ignoredMessages: {
    label: "Ignored messages",
    multiline: true,
    placeholder: "Request has invalid method",
    hint: "One per line. Framework noise to leave out. An override with nothing in it suppresses nothing.",
  },
};

const INPUT =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:bg-gray-100 disabled:text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800";

const SETTINGS_QUERY = ["settings", "admin"] as const;
const CHANGES_QUERY = ["settings", "changes"] as const;

export function SettingsEditor() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const cols = settingsCollections(webConfig().settingsCollection);

  const stored = useQuery({ queryKey: SETTINGS_QUERY, queryFn: () => readSettings(firestore(), cols), retry: false });
  const changes = useQuery({ queryKey: CHANGES_QUERY, queryFn: () => readRecentChanges(firestore(), cols), retry: false });

  const storedRevision = typeof stored.data?.revision === "number" ? stored.data.revision : 0;
  const [form, setForm] = useState<FormState | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  // Load the form whenever the stored document is (re)loaded: on first read, after
  // a save, and after a refused save reloads the latest. Never on a plain
  // re-render, so unsaved edits stay.
  useEffect(() => {
    if (stored.isSuccess) {
      setForm(formFromStored(stored.data));
      setProblems([]);
    }
  }, [stored.isSuccess, stored.data]);

  const save = useMutation({
    mutationFn: (settings: Parameters<typeof saveSettings>[3]) =>
      saveSettings(firestore(), cols, user?.uid ?? "unknown", settings, stored.data ?? null),
    onSuccess: () => {
      toast.success("Settings saved");
      return queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: async (err: unknown) => {
      // The rules refuse a save that isn't the next revision of what is stored.
      const stale = (err as { code?: string } | null)?.code === "permission-denied";
      if (!stale) {
        // A network or server failure: keep the edits so the admin can try again.
        toast.error("Not saved: the write failed. Try again.");
        return;
      }
      toast.error(
        "Not saved: the settings changed since you opened this page, or your access changed. Reloaded the latest."
      );
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      // Reset the form explicitly: if the stored document turned out unchanged, the
      // refetch keeps the same data and the effect above would leave the edits in place.
      setForm(formFromStored(queryClient.getQueryData<StoredSettings | null>(SETTINGS_QUERY) ?? null));
      setProblems([]);
    },
  });

  if (stored.isPending) return <p className="text-sm text-gray-500 dark:text-gray-400">Loading settings…</p>;
  if (stored.isError || !form) {
    return (
      <p role="alert" className="text-sm text-error-700 dark:text-error-400">
        Couldn&apos;t read the settings. They may not be set up for this project yet; check that firestore.rules is
        deployed to the Starfish database.
      </p>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(formFromStored(stored.data ?? null));
  const update = (name: FieldName, patch: Partial<FormState[FieldName]>) =>
    setForm({ ...form, [name]: { ...form[name], ...patch } });

  const submit = (next: FormState) => {
    const result = settingsFromForm(next);
    if (!result.ok) return setProblems(result.problems);
    setProblems([]);
    save.mutate(result.settings);
  };
  const resetAll = () => {
    if (!window.confirm("Reset every setting to the engine's defaults?")) return;
    submit(formFromStored(null));
  };

  return (
    <section aria-labelledby="runtime-settings" className="space-y-4">
      <div>
        <h2 id="runtime-settings" className="text-lg font-semibold text-gray-900 dark:text-white">
          Runtime settings
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Override the engine&apos;s defaults. A field left on its default uses the engine&apos;s environment variables.
          The engine applies a saved document at the start of each run, but the scheduled job that runs it is not
          deployed yet, so nothing reads these today. Secrets are not stored here.
        </p>
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit(form);
        }}
      >
        {FIELD_NAMES.map((name) => {
          const spec = FIELDS[name];
          const field = form[name];
          const id = `setting-${name}`;
          return (
            <fieldset
              key={name}
              className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
            >
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={id} className="font-medium text-gray-900 dark:text-white">
                  {spec.label}
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={field.override}
                    onChange={(e) => update(name, { override: e.target.checked })}
                  />
                  Override the default
                </label>
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{spec.hint}</p>
              {spec.multiline ? (
                <textarea
                  id={id}
                  rows={4}
                  className={`${INPUT} mt-2 font-mono`}
                  placeholder={spec.placeholder}
                  disabled={!field.override}
                  value={field.text}
                  onChange={(e) => update(name, { text: e.target.value })}
                />
              ) : (
                <input
                  id={id}
                  type="text"
                  className={`${INPUT} mt-2`}
                  placeholder={spec.placeholder}
                  disabled={!field.override}
                  value={field.text}
                  onChange={(e) => update(name, { text: e.target.value })}
                />
              )}
              {!field.override && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Using the engine&apos;s default.</p>
              )}
            </fieldset>
          );
        })}

        {problems.length > 0 && (
          <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-error-700 dark:text-error-400">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save settings"}
          </Button>
          <Button variant="secondary" disabled={!dirty || save.isPending} onClick={() => setForm(formFromStored(stored.data ?? null))}>
            Discard changes
          </Button>
          <Button variant="secondary" disabled={save.isPending || storedRevision === 0} onClick={resetAll}>
            Reset to defaults
          </Button>
          {storedRevision > 0 && (
            <span className="text-xs text-gray-500 dark:text-gray-400">Revision {storedRevision}</span>
          )}
        </div>
      </form>

      <div>
        <h3 className="font-medium text-gray-900 dark:text-white">Recent changes</h3>
        {changes.isError ? (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Couldn&apos;t read the change history.</p>
        ) : !changes.data || changes.data.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">No changes yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-200 text-sm dark:divide-gray-700">
            {changes.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400">r{c.revision}</span>
                <span className="text-gray-700 dark:text-gray-300">{formatDateTime(c.at)}</span>
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400">by {c.by}</span>
                <span className="text-gray-900 dark:text-white">
                  {c.changed.length > 0 ? `changed ${c.changed.join(", ")}` : "saved with no change"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
