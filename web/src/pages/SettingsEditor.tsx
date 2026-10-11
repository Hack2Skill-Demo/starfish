/**
 * SettingsEditor: the runtime settings an admin overrides, plus the recent
 * changes. The engine applies a saved document over its environment defaults
 * (src/runtimeSettings.ts); firestore.rules lets only admins write it, and every
 * save is recorded with its before and after.
 *
 * The browser can't see the engine's defaults, so each field is either "use the
 * engine's default" or an override, and the form never shows a default value.
 *
 * SettingsReadOnly is the same fields for everyone else (operators and guests): read from
 * the copy each save writes beside the settings (`settings` on `<settings>_public`), shown
 * as text, with no control to change them. firestore.rules is what stops a write.
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
import { usePublicSettings } from "../lib/useSettings";

const FIELDS: Record<
  FieldName,
  { label: string; multiline: boolean; placeholder: string; hint: string; kind?: "switch" | "number" }
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
  dryRun: {
    label: "Dry run",
    multiline: false,
    kind: "switch",
    placeholder: "",
    hint: "On: the agent loop drafts, verifies and reviews fixes and opens nothing. Off: a verified, reviewed patch may become a pull request. The engine's default is on. The agent job runs on the demo project.",
  },
  reviewRequired: {
    label: "Review required",
    multiline: false,
    kind: "switch",
    placeholder: "",
    hint: "On: a patch must survive the adversarial review before it can become a pull request.",
  },
  automationEnabled: {
    label: "Automation",
    multiline: false,
    kind: "switch",
    placeholder: "",
    hint: "The kill switch. Off: the agent loop stops at its next step and opens nothing, whatever the other switches say. The engine's default is on. The agent job runs on the demo project.",
  },
  autoMerge: {
    label: "Auto-merge",
    multiline: false,
    kind: "switch",
    placeholder: "",
    hint: "On: Starfish merges a fix itself when Gemini decides the incident is one of the merge cases below, the change stays outside the hard-exclude list (auth, security rules, money, secrets, schema, dependencies, CI config; tests only added, never changed) and every required check is green. Each merge is reverted if the same error comes back soon after. Only for a target the engine lists as auto-mergeable (the demo); any other target stays pull-request-only. Needs dry run off. A merge is a release: Starfish runs no deploy itself, but the target's own CI/CD ships what is merged. The engine's default is off. Never run against real GitHub.",
  },
  mergeFreeze: {
    label: "Merge freeze",
    multiline: false,
    kind: "switch",
    placeholder: "",
    hint: "The global off switch for merging. On: Starfish merges and reverts nothing, whatever auto-merge says; a pull request waiting to merge is handed to a person. The engine's default is off.",
  },
  mergeCases: {
    label: "Merge cases",
    multiline: true,
    placeholder: "missing-index: a Firestore query fails because a composite index is missing\nfirestore-undefined-field: a Firestore write fails because a field is undefined",
    hint: 'One "id: description" per line, at most 20. The kinds of incident Starfish may merge a fix for by itself: Gemini reads the descriptions and must name one to choose "merge". missing-index is the index path\'s own case (no model): listed, its evidence pull request merges once its checks are green. An override with nothing in it, like the engine\'s default, means nothing merges.',
  },
  classRules: {
    label: "Class rules",
    multiline: true,
    placeholder: "payments-human | service=payments | log | money: a person fixes it\nhealth-noise | functionName=healthCheck, errorType=TimeoutError | noise",
    hint: 'The rules engine. One "id | key=value, key=value | level | note" per line, at most 50; keys errorType, errorCode, service, functionName, matched exactly; level noise, log or fix; the note optional. An incident matching every field of a rule goes no further than its level, whatever Gemini decides: noise declines it without asking the model, log files the issue and stops, fix opens the pull request but never merges it. Rules only hold Starfish back; an operator\'s correction on an incident\'s page caps it the same way, and the lowest wins. Built and tested against fakes and the emulator; not yet run on a real incident.',
  },
  modelCallBudget: {
    label: "Model calls per cycle",
    multiline: false,
    kind: "number",
    placeholder: "6",
    hint: "The most model calls one cycle may make (triage, each fix attempt, each review), 1 to 50. A spend cap per incident.",
  },
  model: {
    label: "Gemini model",
    multiline: false,
    placeholder: "gemini-3.1-pro-preview",
    hint: "The Vertex AI model id the agent loop asks for triage, fix drafting and review. It must be available in the region below. The agent job runs on the demo project.",
  },
  location: {
    label: "Vertex AI region",
    multiline: false,
    placeholder: "us-central1",
    hint: "Where those model calls go: a GCP region such as us-central1, or global.",
  },
  vertexProjectId: {
    label: "Vertex AI project",
    multiline: false,
    placeholder: "my-ai-project",
    hint: "The GCP project those model calls run in and are billed to. The agent's service account needs roles/aiplatform.user there and the Vertex AI API enabled; the deploy script grants that only on its own VERTEX_PROJECT_ID.",
  },
};

const INPUT =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-500 disabled:bg-gray-100 disabled:text-gray-400 dark:border-gray-700 dark:placeholder:text-gray-400 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800";

const SETTINGS_QUERY = ["settings", "admin"] as const;
const CHANGES_QUERY = ["settings", "changes"] as const;

export function SettingsEditor() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const cols = settingsCollections(webConfig().settingsCollection);

  const stored = useQuery({ queryKey: SETTINGS_QUERY, queryFn: () => readSettings(firestore(), cols), retry: false });
  // The copy operators and guests read. One written before it carried the settings stays behind
  // until the next save, so the editor offers that save even with nothing changed.
  const copy = usePublicSettings();
  const copyBehind = stored.data != null && copy.isSuccess && copy.data?.settings === undefined;
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

  if (stored.isPending) return <p className="text-sm text-gray-600 dark:text-gray-400">Loading settings…</p>;
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
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Override the engine&apos;s defaults. A field left on its default uses the engine&apos;s environment variables.
          The engine applies a saved document at the start of each run of its scheduled job. If no job is deployed for
          this project, nothing reads these. Secrets are not stored here.
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
              {spec.kind === "switch" ? (
                <select
                  id={id}
                  className={`${INPUT} mt-2`}
                  disabled={!field.override}
                  value={field.text}
                  onChange={(e) => update(name, { text: e.target.value })}
                >
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </select>
              ) : spec.multiline ? (
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
                  type={spec.kind === "number" ? "number" : "text"}
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

        {copyBehind && (
          <p role="status" className="text-sm text-gray-700 dark:text-gray-300">
            The read-only copy operators and guests see doesn&apos;t show these settings yet: it was written before
            it carried them. Save once to bring it up to date.
          </p>
        )}

        {problems.length > 0 && (
          <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-error-700 dark:text-error-400">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={(!dirty && !copyBehind) || save.isPending}>
            {save.isPending ? "Saving…" : "Save settings"}
          </Button>
          <Button variant="secondary" disabled={!dirty || save.isPending} onClick={() => setForm(formFromStored(stored.data ?? null))}>
            Discard changes
          </Button>
          <Button variant="secondary" disabled={save.isPending || storedRevision === 0} onClick={resetAll}>
            Reset to defaults
          </Button>
          {storedRevision > 0 && (
            <span className="text-xs text-gray-600 dark:text-gray-400">Revision {storedRevision}</span>
          )}
        </div>
      </form>

      <div>
        <h3 className="font-medium text-gray-900 dark:text-white">Recent changes</h3>
        {changes.isError ? (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Couldn&apos;t read the change history.</p>
        ) : !changes.data || changes.data.length === 0 ? (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">No changes yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-200 text-sm dark:divide-gray-700">
            {changes.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="font-mono text-xs text-gray-600 dark:text-gray-400">r{c.revision}</span>
                <span className="text-gray-700 dark:text-gray-300">{formatDateTime(c.at)}</span>
                <span className="font-mono text-xs text-gray-600 dark:text-gray-400">by {c.by}</span>
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

/** One field as text: the override's value, or that the engine's default applies. */
function ReadOnlyValue({ name, field }: { name: FieldName; field: FormState[FieldName] }) {
  const spec = FIELDS[name];
  if (!field.override) return <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Using the engine&apos;s default.</p>;
  if (spec.kind === "switch") {
    return <p className="mt-2 text-sm font-medium text-gray-900 dark:text-white">{field.text === "true" ? "On" : "Off"}</p>;
  }
  if (field.text === "") {
    return <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">Overridden with nothing in it.</p>;
  }
  return spec.multiline ? (
    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 px-3 py-2 font-mono text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100">
      {field.text}
    </pre>
  ) : (
    <p className="mt-2 break-all font-mono text-sm text-gray-900 dark:text-gray-100">{field.text}</p>
  );
}

/**
 * The runtime settings for anyone who can't edit them: the same fields as the editor, as text.
 * It reads the copy each admin save writes (`<settings>_public`), never the settings document,
 * which only admins may read. Nothing here writes.
 */
export function SettingsReadOnly({ note }: { note: string }) {
  const copy = usePublicSettings();

  let body;
  if (copy.isPending) {
    body = <p className="text-sm text-gray-600 dark:text-gray-400">Loading settings…</p>;
  } else if (copy.isError) {
    body = (
      <p role="alert" className="text-sm text-error-700 dark:text-error-400">
        Couldn&apos;t read the settings.
      </p>
    );
  } else if (copy.data && copy.data.settings === undefined) {
    // A copy from before it carried the settings: showing every field "on its default" would be a guess.
    body = (
      <p className="text-sm text-gray-700 dark:text-gray-300">
        The settings in force aren&apos;t shown here yet: this copy of them is written with each admin save, and none
        has been made since this view was added.
      </p>
    );
  } else {
    // No copy at all: no admin has saved settings, so every field is on the engine's default.
    const form = formFromStored(copy.data?.settings ?? null);
    body = (
      <dl className="space-y-4">
        {FIELD_NAMES.map((name) => (
          <div key={name} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <dt className="font-medium text-gray-900 dark:text-white">{FIELDS[name].label}</dt>
            <dd>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{FIELDS[name].hint}</p>
              <ReadOnlyValue name={name} field={form[name]} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  const revision = copy.data?.revision;
  return (
    <section aria-labelledby="runtime-settings" className="space-y-4">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="runtime-settings" className="text-lg font-semibold text-gray-900 dark:text-white">
            Runtime settings
          </h2>
          {typeof revision === "number" && revision > 0 && (
            <span className="text-xs text-gray-600 dark:text-gray-400">Revision {revision}</span>
          )}
        </div>
        <p role="note" className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {note}
        </p>
      </div>
      {body}
    </section>
  );
}
