/**
 * Settings — the connections Starfish is built around: Gemini, GitHub, Slack.
 *
 * Deliberately honest: GitHub and Slack integrations are design-only today
 * (docs/design/auto-merge-policy.md), so this page reports them as not
 * connected rather than offering controls that do nothing. Gemini runs through
 * the engine's own config (src/config.ts), which this page describes but can't
 * read from the browser. The rules and feedback engines land here once built.
 */
import { Bot, GitBranch, MessageSquare, SlidersHorizontal, type LucideIcon } from "lucide-react";
import PageMeta from "../components/PageMeta";
import { Badge } from "../components/ui/Badge";
import { webConfig } from "../lib/config";

type ConnectionState = "engine" | "planned";

interface Connection {
  name: string;
  icon: LucideIcon;
  state: ConnectionState;
  purpose: string;
  detail: string;
}

export const CONNECTIONS: Connection[] = [
  {
    name: "Gemini (Vertex AI)",
    icon: Bot,
    state: "engine",
    purpose:
      "The model Starfish will use for triage, fix drafting and adversarial review. Today only the fix-quality spike calls it; those three agents are not built yet.",
    detail: "Configured on the engine: GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, STARFISH_MODEL.",
  },
  {
    name: "GitHub",
    icon: GitBranch,
    state: "planned",
    purpose: "File an issue per incident, open fix PRs, and sync status back when they close.",
    detail: "Design only; not built yet.",
  },
  {
    name: "Slack",
    icon: MessageSquare,
    state: "planned",
    purpose: "Notify on incidents, escalate what needs a human, report what healed.",
    detail: "Design only.",
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

export default function Settings() {
  const cfg = webConfig();
  return (
    <>
      <PageMeta title="Settings | Starfish" description="Connections and configuration" />
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Connections for project <span className="font-mono">{cfg.firebase.projectId}</span> ({cfg.environment})
          </p>
        </div>
        <ul className="grid gap-4 md:grid-cols-2">
          {CONNECTIONS.map((c) => (
            <li
              key={c.name}
              className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <c.icon className="h-5 w-5 text-gray-500 dark:text-gray-400" />
                  <h2 className="font-semibold text-gray-900 dark:text-white">{c.name}</h2>
                </div>
                <Badge tone={STATE_BADGE[c.state].tone}>
                  {STATE_BADGE[c.state].label}
                </Badge>
              </div>
              <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">{c.purpose}</p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{c.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
