import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRecord } from "../lib/engineStatus";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  inProgress: null as { environment: string; since: Date } | null,
  push: (() => {}) as (p: unknown) => void,
}));
vi.mock("../lib/firebase", () => ({ firestore: () => ({}) }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ runCollection: "starfish_runs", engineStaleMinutes: 90 }) }));
// `read` answers for the last finished pass, `inProgress` for a pass's start mark.
vi.mock("../lib/engineStatus", async (orig) => ({
  ...(await orig<typeof import("../lib/engineStatus")>()),
  subscribeAgentPass: (_db: unknown, _collection: string, onData: (p: unknown) => void, onError: (e: Error) => void) => {
    // A listener: the record as it stands, then each version `mocks.push` hands over.
    Promise.resolve(mocks.read()).then((run) => onData({ run, inProgress: mocks.inProgress }), onError);
    mocks.push = onData;
    return () => {};
  },
}));

import { AgentStatus } from "./AgentStatus";
import { markAgentStartRequested, resetAgentStartRequested } from "../lib/agentStart";

const pass = (over: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  environment: "demo",
  outcome: "ok",
  // Half a minute of slack, so "in 46 minutes" holds however long the render takes.
  startedAt: new Date(Date.now() - 14 * 60_000 + 30_000),
  finishedAt: new Date(Date.now() - 10 * 60_000),
  dryRun: true,
  considered: 2,
  ran: 1,
  cycleErrors: 0,
  aborted: false,
  gaveUp: 0,
  scanCapped: false,
  failedSteps: [],
  problems: [],
  ...over,
});

function renderStatus(environment = "demo") {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentStatus environment={environment} />
    </QueryClientProvider>
  );
}

describe("AgentStatus (#274)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inProgress = null;
    resetAgentStartRequested();
  });

  it("says a healthy agent between passes is waiting (not running), when its last pass finished, what it did and when the next is expected", async () => {
    mocks.read.mockResolvedValue(pass({ intervalMinutes: 60 }));
    renderStatus();
    expect(await screen.findByText("Agent waiting")).toBeInTheDocument();
    const line = screen.getByTestId("agent-status");
    expect(line).toHaveTextContent("last pass 10 minutes ago (dry run): 2 candidates, 1 run");
    expect(line).toHaveTextContent("next pass expected in 46 minutes");
  });

  it("promises no next pass when it does not know its schedule", async () => {
    mocks.read.mockResolvedValue(pass());
    renderStatus();
    await screen.findByText("Agent waiting");
    expect(screen.getByTestId("agent-status")).not.toHaveTextContent("next pass");
  });

  it("says no pass is recorded yet when there is none, or only one for another environment", async () => {
    mocks.read.mockResolvedValue(null);
    const { unmount } = renderStatus();
    expect(await screen.findByText("No agent pass recorded yet")).toBeInTheDocument();
    unmount();
    mocks.read.mockResolvedValue(pass({ environment: "prod" }));
    renderStatus("demo");
    expect(await screen.findByText("No agent pass recorded yet")).toBeInTheDocument();
  });

  it("shows a failed pass with the steps that failed, its error, and no next pass", async () => {
    mocks.read.mockResolvedValue(pass({ outcome: "failed", failedSteps: ["cycles", "pull-requests"], intervalMinutes: 60 }));
    const { unmount } = renderStatus();
    expect(await screen.findByText("Last agent pass failed")).toBeInTheDocument();
    expect(screen.getByTestId("agent-status")).toHaveTextContent("(failed: cycles, pull-requests)");
    expect(screen.getByTestId("agent-status")).not.toHaveTextContent("next pass");
    unmount();
    mocks.read.mockResolvedValue(pass({ environment: "dev", outcome: "failed", error: "settings-unusable", problems: ["settings read failed: 14"] }));
    renderStatus("demo");
    expect(await screen.findByText("Last agent pass failed")).toBeInTheDocument();
    expect(screen.getByTestId("agent-status")).toHaveTextContent("(settings-unusable)");
    expect(screen.getByTestId("agent-status")).toHaveTextContent("runtime settings not used: settings read failed: 14");
  });

  it("says when the agent stopped", async () => {
    mocks.read.mockResolvedValue(pass({ finishedAt: new Date(Date.now() - 5 * 3600_000) }));
    renderStatus();
    expect(await screen.findByText("Agent not running")).toBeInTheDocument();
  });

  it("says why a pass started nothing, and flags a capped scan", async () => {
    mocks.read.mockResolvedValue(pass({ skipped: "automation-disabled", considered: 0, ran: 0 }));
    const { unmount } = renderStatus();
    await screen.findByText("Agent waiting");
    expect(screen.getByTestId("agent-status")).toHaveTextContent("automation is off: no run started");
    unmount();
    mocks.read.mockResolvedValue(pass({ scanCapped: true }));
    renderStatus();
    expect(await screen.findByText("Agent waiting, last scan capped")).toBeInTheDocument();
    expect(screen.getByTestId("agent-status")).toHaveTextContent("older open incidents wait for a later pass");
  });

  it("as a card (the Runs page), says the same and how far the agent is to its next pass", async () => {
    mocks.read.mockResolvedValue(pass({ startedAt: new Date(Date.now() - 15 * 60_000), intervalMinutes: 60 }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentStatus environment="demo" variant="card" />
      </QueryClientProvider>
    );
    expect(await screen.findByText("Agent waiting")).toBeInTheDocument();
    const card = screen.getByTestId("agent-status");
    expect(card).toHaveTextContent("Last pass 10 minutes ago (dry run): 2 candidates, 1 run.");
    expect(card).toHaveTextContent("Next pass expected in 45 minutes");
    expect(screen.getByRole("img", { name: "25% of the way to the next pass" })).toBeInTheDocument();
  });

  it("as a card, says when no pass is recorded yet and draws no bar", async () => {
    mocks.read.mockResolvedValue(null);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentStatus environment="demo" variant="card" />
      </QueryClientProvider>
    );
    expect(await screen.findByText("No agent pass recorded yet")).toBeInTheDocument();
    expect(screen.getByTestId("agent-status")).toHaveTextContent("Nothing has said the agent has run in this environment.");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says a pass is in progress and when it started, with a sliding bar and where its runs appear (card)", async () => {
    mocks.read.mockResolvedValue(pass({ startedAt: new Date(Date.now() - 61 * 60_000), finishedAt: new Date(Date.now() - 59 * 60_000), intervalMinutes: 60 }));
    mocks.inProgress = { environment: "demo", since: new Date(Date.now() - 40_000) };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentStatus environment="demo" variant="card" />
      </QueryClientProvider>
    );
    expect(await screen.findByText("Agent running")).toBeInTheDocument();
    const card = screen.getByTestId("agent-status");
    expect(card).toHaveTextContent("Started 40 seconds ago");
    expect(card).toHaveTextContent("Runs it starts appear below as they start");
    expect(card).toHaveTextContent("Last pass 59 minutes ago (dry run): 2 candidates, 1 run.");
    expect(card).not.toHaveTextContent("Next pass");
    expect(screen.getByRole("img", { name: "A pass is under way" })).toBeInTheDocument();
  });

  it("says a pass is in progress on a first pass, without saying none has run (line)", async () => {
    mocks.read.mockResolvedValue(null);
    mocks.inProgress = { environment: "demo", since: new Date(Date.now() - 10_000) };
    renderStatus();
    expect(await screen.findByText("Agent running")).toBeInTheDocument();
    expect(screen.getByTestId("agent-status")).toHaveTextContent("started 10 seconds ago");
    expect(screen.getByTestId("agent-status")).not.toHaveTextContent("nothing has said");
  });

  it("after Run agent now, says a start was requested, in blue, until the pass records its start (no refresh)", async () => {
    mocks.read.mockResolvedValue(pass({ intervalMinutes: 60 }));
    markAgentStartRequested(Date.now() - 5_000);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentStatus environment="demo" variant="card" />
      </QueryClientProvider>
    );
    expect(await screen.findByText("Agent starting")).toBeInTheDocument();
    const card = screen.getByTestId("agent-status");
    expect(card).toHaveTextContent("Requested 5 seconds ago");
    expect(card).toHaveTextContent("Start requested: waiting for its job to come up");
    expect(screen.getByRole("img", { name: "A pass is under way" })).toBeInTheDocument();
  });

  it("drops the request once the record shows a pass since it", async () => {
    mocks.read.mockResolvedValue(pass({ intervalMinutes: 60 }));
    mocks.inProgress = { environment: "demo", since: new Date(Date.now() - 2_000) };
    markAgentStartRequested(Date.now() - 5_000);
    renderStatus();
    expect(await screen.findByText("Agent running")).toBeInTheDocument();
    expect(screen.queryByText("Agent starting")).toBeNull();
  });

  it("ignores a request a pass already answered: a pass that started after it and ended is waiting again", async () => {
    mocks.read.mockResolvedValue(pass({ startedAt: new Date(Date.now() - 2 * 60_000), finishedAt: new Date(Date.now() - 1_000), intervalMinutes: 60 }));
    markAgentStartRequested(Date.now() - 3 * 60_000);
    renderStatus();
    expect(await screen.findByText("Agent waiting")).toBeInTheDocument();
  });

  it("still says starting when the pass that ended since the request had started before it", async () => {
    mocks.read.mockResolvedValue(pass({ startedAt: new Date(Date.now() - 10 * 60_000), finishedAt: new Date(Date.now() - 1_000), intervalMinutes: 60 }));
    markAgentStartRequested(Date.now() - 3 * 60_000);
    renderStatus();
    expect(await screen.findByText("Agent starting")).toBeInTheDocument();
  });

  it("says when a started pass never recorded its end", async () => {
    mocks.read.mockResolvedValue(pass({ finishedAt: new Date(Date.now() - 3 * 3600_000), intervalMinutes: 60 }));
    mocks.inProgress = { environment: "demo", since: new Date(Date.now() - 2 * 3600_000) };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentStatus environment="demo" variant="card" />
      </QueryClientProvider>
    );
    expect(await screen.findByText("Agent pass has not finished")).toBeInTheDocument();
    expect(screen.getByTestId("agent-status")).toHaveTextContent("Started 2 hours ago");
    expect(screen.getByTestId("agent-status")).toHaveTextContent("It has not recorded its end");
    expect(screen.queryByRole("img", { name: "A pass is under way" })).toBeNull();
  });

  it("says a due pass is waiting to start, rather than 'just now'", async () => {
    mocks.read.mockResolvedValue(pass({ startedAt: new Date(Date.now() - 60 * 60_000 - 20_000), finishedAt: new Date(Date.now() - 59 * 60_000), intervalMinutes: 60 }));
    const { unmount } = renderStatus();
    await screen.findByText("Agent waiting");
    expect(screen.getByTestId("agent-status")).toHaveTextContent("next pass due now, waiting for it to start");
    unmount();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AgentStatus environment="demo" variant="card" />
      </QueryClientProvider>
    );
    await screen.findByText("Agent waiting");
    expect(screen.getByTestId("agent-status")).toHaveTextContent("Next pass due now");
    expect(screen.getByTestId("agent-status")).toHaveTextContent("Waiting for it to start");
  });

  it("doesn't alarm when the record can't be read", async () => {
    mocks.read.mockRejectedValue(new Error("permission-denied"));
    renderStatus();
    expect(await screen.findByText("Agent status unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("Agent not running")).toBeNull();
  });
});
