import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LastRun } from "../lib/engineStatus";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../lib/firebase", () => ({ firestore: () => ({}) }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ runCollection: "starfish_runs", engineStaleMinutes: 90 }) }));
vi.mock("../lib/engineStatus", async (orig) => ({ ...(await orig<typeof import("../lib/engineStatus")>()), readLastRun: mocks.read }));

import { EngineStatus } from "./EngineStatus";

const run = (over: Partial<LastRun> = {}): LastRun => ({
  environment: "demo",
  outcome: "ok",
  finishedAt: new Date(Date.now() - 10 * 60_000),
  windows: 1,
  capped: false,
  totals: { entriesProcessed: 9, incidentsCreated: 2, incidentsUpdated: 5, incidentsRecurred: 1 },
  problems: [],
  ...over,
});

function renderStatus(environment = "demo") {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <EngineStatus environment={environment} />
    </QueryClientProvider>
  );
}

describe("EngineStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("says the engine is waiting, when it last ran and what it found", async () => {
    mocks.read.mockResolvedValue(run());
    renderStatus();
    expect(await screen.findByText("Ingest waiting")).toBeInTheDocument();
    expect(screen.getByTestId("engine-status")).toHaveTextContent("2 new, 5 updated, 1 recurred");
    expect(screen.getByTestId("engine-status")).toHaveTextContent("10 minutes ago");
  });

  it("says the engine stopped, instead of leaving a quiet list to look like good news", async () => {
    mocks.read.mockResolvedValue(run({ finishedAt: new Date(Date.now() - 5 * 3600_000) }));
    renderStatus();
    expect(await screen.findByText("Ingest not running")).toBeInTheDocument();
  });

  it("shows a failed run with its error label and no counts", async () => {
    mocks.read.mockResolvedValue(run({ outcome: "failed", error: "UNAVAILABLE" }));
    renderStatus();
    expect(await screen.findByText("Last ingest run failed")).toBeInTheDocument();
    const line = screen.getByTestId("engine-status");
    expect(line).toHaveTextContent("(UNAVAILABLE)");
    expect(line).not.toHaveTextContent("new,");
  });

  it("shows a refusal on unusable settings as failed, though it names the env default's environment (#223)", async () => {
    mocks.read.mockResolvedValue(run({ environment: "dev", outcome: "failed", error: "settings-unusable", problems: ["settings read failed: 14"] }));
    renderStatus("demo");
    expect(await screen.findByText("Last ingest run failed")).toBeInTheDocument();
    const line = screen.getByTestId("engine-status");
    expect(line).toHaveTextContent("(settings-unusable)");
    expect(line).toHaveTextContent("runtime settings not used: settings read failed: 14");
  });

  it("flags a capped read: the counts are a floor", async () => {
    mocks.read.mockResolvedValue(run({ capped: true }));
    renderStatus();
    expect(await screen.findByText("Ingest waiting, last read capped")).toBeInTheDocument();
    expect(screen.getByTestId("engine-status")).toHaveTextContent("a floor");
  });

  it("says the ingest is falling behind when its checkpoint lags past twice the schedule, though the run said ok (#297)", async () => {
    mocks.read.mockResolvedValue(run({ intervalMinutes: 60, lagSeconds: 3 * 3600, capped: true }));
    renderStatus();
    expect(await screen.findByText("Ingest falling behind")).toBeInTheDocument();
    const line = screen.getByTestId("engine-status");
    expect(line).toHaveTextContent("checkpoint 180 min behind the newest logs (more than 120 min)");
    // Behind outranks capped, but the floor is still said.
    expect(line).toHaveTextContent("a floor");
  });

  it("says when no run has been recorded, and that the list may be out of date", async () => {
    mocks.read.mockResolvedValue(null);
    renderStatus();
    expect(await screen.findByText("No ingest run recorded")).toBeInTheDocument();
    expect(screen.getByTestId("engine-status")).toHaveTextContent("may be out of date");
  });

  it("lists the runtime settings the engine could not use", async () => {
    mocks.read.mockResolvedValue(run({ problems: ["watchedProjectId must be a string"] }));
    renderStatus();
    await screen.findByText("Ingest waiting");
    expect(screen.getByTestId("engine-status")).toHaveTextContent("runtime settings not used: watchedProjectId must be a string");
  });

  it("doesn't alarm when the record can't be read (a viewer who may not read it)", async () => {
    mocks.read.mockRejectedValue(new Error("permission-denied"));
    renderStatus();
    expect(await screen.findByText("Ingest status unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("Ingest not running")).toBeNull();
  });

  it("treats a run recorded for another environment as no run", async () => {
    mocks.read.mockResolvedValue(run({ environment: "prod" }));
    renderStatus("demo");
    expect(await screen.findByText("No ingest run recorded")).toBeInTheDocument();
  });

  it("as a card, says the same and how far the engine is to its next run", async () => {
    const startedAt = new Date(Date.now() - 15 * 60_000);
    mocks.read.mockResolvedValue(run({ startedAt, intervalMinutes: 60 }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EngineStatus environment="demo" variant="card" />
      </QueryClientProvider>
    );
    expect(await screen.findByText("Ingest waiting")).toBeInTheDocument();
    expect(screen.getByTestId("engine-status")).toHaveTextContent("Last run 10 minutes ago: 2 new, 5 updated, 1 recurred.");
    expect(screen.getByTestId("engine-status")).toHaveTextContent("Next run expected in 45 minutes");
    expect(screen.getByRole("img", { name: "25% of the way to the next run" })).toBeInTheDocument();
  });

  it("as a card, draws no bar when the engine recorded no schedule", async () => {
    mocks.read.mockResolvedValue(run());
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EngineStatus environment="demo" variant="card" />
      </QueryClientProvider>
    );
    expect(await screen.findByText("Ingest waiting")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

