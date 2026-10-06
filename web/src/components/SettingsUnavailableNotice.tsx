/**
 * Said on every page that filters by the environment label when the runtime settings could not be
 * read (`useEnvironment().settingsUnavailable`). The label is then this build's default, a guess:
 * if an admin has changed it, the page's records come back empty with no error, and an empty page
 * must not read as a quiet day (#43, #143). `subject` is a plural noun phrase: "incidents", "runs".
 */
export default function SettingsUnavailableNotice({ environment, subject }: { environment: string; subject: string }) {
  return (
    <p
      role="status"
      className="rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-800 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-200"
    >
      Couldn&apos;t read the runtime settings, so {subject} are filtered by this build&apos;s environment label (
      <span className="font-mono">{environment}</span>). If an admin has changed the label, what this page shows may be
      empty or out of date.
    </p>
  );
}
