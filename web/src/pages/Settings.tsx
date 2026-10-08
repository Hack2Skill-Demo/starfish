/**
 * Settings — the connections Starfish is built around: Gemini, GitHub, Slack.
 *
 * Deliberately honest: GitHub and Slack have never run against the real services, so this page
 * never says "connected". The secrets are mounted on the agent job only and the browser can't read
 * them; the agent states at the start of each pass whether each is set (`lib/integrations.ts`), and
 * the page then says "configured" and when it was reported. Until the agent has reported, it says
 * "not connected yet". Gemini runs through the engine's own config (src/config.ts), which this page
 * describes but can't read from the browser. The rules and feedback engines land here once built.
 */
import { useQuery } from "@tanstack/react-query";
import { Bot, GitBranch, MessageSquare, SlidersHorizontal, type LucideIcon } from "lucide-react";
import PageMeta from "../components/PageMeta";
import { Badge } from "../components/ui/Badge";
import { useAuth } from "../auth/authCore";
import { webConfig } from "../lib/config";
import { useEnvironment } from "../lib/useSettings";
import { firestore } from "../lib/firebase";
import { formatRelativeTime } from "../lib/formatters";
import { readIntegrations, reportFor, type Integrations } from "../lib/integrations";
import { SettingsEditor } from "./SettingsEditor";
import { OnCallEditor } from "./OnCallEditor";

type ConnectionState = "engine" | "planned";

interface Connection {
  name: string;
  icon: LucideIcon;
  state: ConnectionState;
  /** Which of the agent's reports this connection reads, if any. */
  reported?: "github" | "slack";
  purpose: string;
  detail: string;
}

export const CONNECTIONS: Connection[] = [
  {
    name: "Gemini (Vertex AI)",
    icon: Bot,
    state: "engine",
    purpose:
      "The model Starfish uses for triage, fix drafting and adversarial review. Those stages are built as the agent job (pnpm agent), which is deployable but has never run; the scheduled ingest does not call Gemini.",
    detail:
      "The Vertex project, model and region default to STARFISH_VERTEX_PROJECT_ID (else GOOGLE_CLOUD_PROJECT), STARFISH_MODEL and GOOGLE_CLOUD_LOCATION; an admin can override all three under Runtime settings, and the agent job reads them at the start of each pass.",
  },
  {
    name: "GitHub",
    icon: GitBranch,
    state: "planned",
    reported: "github",
    purpose: "File an issue per incident, open fix PRs, and sync status back when they close.",
    detail:
      "The pull-request opener and the incident's issue are built, tested against a local remote and a fake GitHub API, and have never run against real GitHub. Syncing status back when a PR merges or its CI finishes is not built.",
  },
  {
    name: "Slack",
    icon: MessageSquare,
    state: "planned",
    reported: "slack",
    purpose: "Notify on incidents, escalate what needs a human, report what healed.",
    detail:
      "The \"needs a human\" message is built, tested over local HTTP against a fake webhook, and has never run against real Slack. When an urgent one goes unacknowledged, the phone escalation (On-call, below, admins only) calls the on-call people through Twilio: built, tested against a fake Twilio, never run against real Twilio, off by default. The #ops-log message is not built.",
  },
  {
    name: "Rules & feedback engines",
    icon: SlidersHorizontal,
    state: "planned",
    purpose: "Which incident classes may auto-fix, and human corrections that retrain them.",
    detail: "Policy written in docs/design/auto-merge-policy.md; not built.",
  },
];

const STATE_BADGE: Record<ConnectionState, { tone: "success" | "neutral"; label: string }> = {
  engine: { tone: "success", label: "Configured on the engine" },
  planned: { tone: "neutral", label: "Not connected yet" },
};

type Badged = { tone: "success" | "neutral"; label: string };

/** What the agent reported for one connection, or null when it has said nothing (the static badge stands). */
export function reportedState(c: Connection, report: Integrations | null): { badge: Badged; note: string } | null {
  if (!report || !c.reported) return null;
  const when = `Reported by the agent ${formatRelativeTime(report.checkedAt)}.`;
  if (c.reported === "github") {
    return report.github
      ? { badge: { tone: "success", label: "Token configured" }, note: `${when} A token is set; nothing has checked it against GitHub yet.` }
      : { badge: { tone: "neutral", label: "No token set" }, note: `${when} No STARFISH_GITHUB_TOKEN on the agent job.` };
  }
  const hooks = [report.slackOnCall && "on-call", report.slackAlerts && "alerts"].filter(Boolean).join(" and ");
  const twilio = report.twilio ? " Twilio credentials are set." : "";
  return hooks
    ? { badge: { tone: "success", label: "Webhook configured" }, note: `${when} The ${hooks} webhook is set; nothing has posted to Slack yet.${twilio}` }
    : { badge: { tone: "neutral", label: "No webhook set" }, note: `${when} No Slack webhook on the agent job.${twilio}` };
}

export default function Settings() {
  const cfg = webConfig();
  const { environment } = useEnvironment();
  // A read that fails says nothing, so the static "not connected yet" stands rather than a guess.
  const integrations = useQuery({
    queryKey: ["engine", "integrations"],
    queryFn: () => readIntegrations(firestore(), cfg.runCollection),
    retry: false,
  });
  const report = reportFor(integrations.data, environment);
  const { guest, roles } = useAuth();
  return (
    <>
      <PageMeta title="Settings | Starfish" description="Connections and configuration" />
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Connections for project <span className="font-mono">{cfg.firebase.projectId}</span> ({environment})
          </p>
        </div>
        <ul className="grid gap-4 md:grid-cols-2">
          {CONNECTIONS.map((c) => {
            const live = reportedState(c, report);
            const badge = live?.badge ?? STATE_BADGE[c.state];
            return (
            <li
              key={c.name}
              className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <c.icon className="h-5 w-5 text-gray-500 dark:text-gray-400" />
                  <h2 className="font-semibold text-gray-900 dark:text-white">{c.name}</h2>
                </div>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </div>
              <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">{c.purpose}</p>
              {live && <p className="mt-1 text-xs text-gray-700 dark:text-gray-300">{live.note}</p>}
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{c.detail}</p>
            </li>
            );
          })}
        </ul>
        {guest ? (
          <p
            role="note"
            className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          >
            The runtime settings are editable by the team only, and nothing here can be changed from the public demo.
            Secrets never appear on this page.
          </p>
        ) : (
          <SettingsEditor />
        )}
        {/* Phone numbers are personal data: admins only, never a guest or a plain operator (#37). */}
        {!guest && roles.includes("admin") && <OnCallEditor />}
      </div>
    </>
  );
}
