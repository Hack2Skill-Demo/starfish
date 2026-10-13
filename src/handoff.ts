/**
 * What a person can do once Starfish has handed an incident to them: the same list in the Slack "needs a human" message
 * (integrations/slack.ts) and on the Runs page, so the two never disagree. Pure, shared with the UI.
 *
 * Each step names a control that exists and says only what it does:
 *   acknowledge  the incident's status (Incidents page); it is also what stops the phone escalation (oncall/escalation.ts
 *                `ACK_STATUSES`), where that is on
 *   fix          a person ships the fix and marks the incident resolved; ingest reopens a resolved incident that fires
 *                again as `recurred` (ingest/store.ts), and the agent runs it again
 *   correct      "Correct triage" on the incident's page (triageRules.ts): it caps how far Starfish goes, never raises it
 *   retry        "Retry with agent" (reconsider.ts): the only thing that reopens a run a person was told about; the same
 *                run, so no second issue, alert, message or pull request
 *   ignore       ignored is never reopened by ingest
 */

export type HandoffPath = "notify" | "human";
export type HandoffStepId = "acknowledge" | "fix" | "correct" | "retry" | "ignore";

export interface HandoffStep {
  id: HandoffStepId;
  /** A few words: what the person would be doing. */
  title: string;
  /** One or two sentences: how, and what follows. */
  text: string;
}

/**
 * The steps for a run that ended with a person. `path` is the cycle's: `notify` when triage judged that no code change
 * helps, `human` when a fix was tried and not finished. `hasIssue` when a GitHub issue was filed for the incident.
 */
export function handoffSteps(path: HandoffPath, hasIssue: boolean): HandoffStep[] {
  const from = hasIssue ? "the GitHub issue" : "the incident's evidence page";
  return [
    {
      id: "acknowledge",
      title: "Take it",
      text: "Acknowledge the incident so the team knows someone has it. Where phone escalation is on, that also stops the calls.",
    },
    path === "human"
      ? {
          id: "fix",
          title: "Fix it yourself",
          text: `Start from ${from}: it holds what Starfish found, and this run's steps say why its fix stopped. Ship the fix, then mark the incident resolved. If the error fires again, Starfish reopens it and runs again.`,
        }
      : {
          id: "fix",
          title: "Deal with the cause",
          text: `Triage judged that no code change fixes this (a setting, a quota, an outside service); ${from} holds what it found. Fix the cause, then mark the incident resolved. If the error fires again, Starfish reopens it and runs again.`,
        },
    {
      id: "retry",
      title: "Let Starfish try again",
      text: "If what stopped it was Starfish's own limit and that has changed since, Retry with agent runs it again with the engine as it is now. It files and sends nothing twice.",
    },
    {
      id: "correct",
      title: "Starfish judged it wrong?",
      text: "Correct triage on the incident's page: noise, log only, or fix. From then on Starfish never goes further with it than that.",
    },
    {
      id: "ignore",
      title: "Not worth fixing?",
      text: "Ignore the incident. Starfish stops on it, and it is not reopened when the error fires again.",
    },
  ];
}
