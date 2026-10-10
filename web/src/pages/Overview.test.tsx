import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncidentRow } from "../lib/incidents";
import { parseCycle, type CycleRow } from "../lib/runsModel";
import { parseActivity, type ActivityRow } from "../lib/overviewModel";

const mocks = vi.hoisted(() => ({
  env: { environment: "demo", ready: true, settingsUnavailable: false },
  cyclesCb: undefined as undefined | ((rows: unknown[], capped: boolean) => void),
  cyclesErr: undefined as undefined | ((e: Error) => void),
  eventsCb: undefined as undefined | ((rows: unknown[]) => void),
  eventsErr: undefined as undefined | ((e: Error) => void),
  unsub: vi.fn(),
  listIncidents: vi.fn(),
}));
vi.mock("../lib/useSettings", () => ({ useEnvironment: () => mocks.env }));
vi.mock("../components/EngineStatus", () => ({ EngineStatus: ({ environment }: { environment: string }) => <div data-testid="engine">{environment}</div> }));
vi.mock("../components/AgentStatus", () => ({ AgentStatus: ({ environment }: { environment: string }) => <div data-testid="agent">{environment}</div> }));
vi.mock("../lib/incidents", async (orig) => ({ ...(await orig<typeof import("../lib/incidents")>()), listIncidents: mocks.listIncidents }));
vi.mock("../lib/runs", async (orig) => ({
  ...(await orig<typeof import("../lib/runs")>()),
  subscribeCycles: (_e: string, ok: (rows: CycleRow[], capped: boolean) => void, err: (e: Error) => void) => {
    mocks.cyclesCb = ok as never;
    mocks.cyclesErr = err;
    return mocks.unsub;
  },
  subscribeLatestEvents: (_e: string, ok: (rows: ActivityRow[]) => void, err: (e: Error) => void) => {
    mocks.eventsCb = ok as never;
    mocks.eventsErr = err;
    return mocks.unsub;
  },
}));

import Overview from "./Overview";

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const now = Date.now();
const cycle = (id: string, over: Record<string, unknown> = {}): CycleRow =>
  parseCycle(id, { incidentId: id, environment: "demo", state: "done", createdAt: ts(now - 60_000), updatedAt: ts(now - 1000), leaseExpiresAt: null, ...over })!;
const incident = (over: Partial<IncidentRow> = {}): IncidentRow => ({
  id: "i1", functionName: "f", service: "s", environment: "demo", errorType: "E", errorMessage: "m", occurrenceCount: 5, windowedCount: 5,
  firstOccurredAt: "", lastOccurredAt: "", status: "new", recurrenceCount: 0, ...over,
});

function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const tile = (label: string) => screen.getByTestId(`tile-${label}`);

describe("Overview page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cyclesCb = mocks.cyclesErr = mocks.eventsCb = mocks.eventsErr = undefined;
    mocks.listIncidents.mockResolvedValue({ rows: [], capped: false });
    mocks.env = { environment: "demo", ready: true, settingsUnavailable: false };
  });

  it("says the settings couldn't be read, so empty counts aren't taken for a quiet day (#143)", async () => {
    mocks.env = { environment: "build-label", ready: true, settingsUnavailable: true };
    renderPage();
    act(() => mocks.cyclesCb!([], false));
    const notice = screen.getByText(/Couldn't read the runtime settings/);
    expect(notice).toHaveTextContent("build-label");
    expect(await screen.findByText(/No logged errors in the last 24 hours/)).toBeInTheDocument();
  });

  it("shows no settings notice when the settings read succeeded", () => {
    renderPage();
    act(() => mocks.cyclesCb!([], false));
    expect(screen.queryByText(/Couldn't read the runtime settings/)).toBeNull();
  });

  it("says nothing is recorded, instead of reading an empty store as good news", async () => {
    renderPage();
    act(() => mocks.cyclesCb!([], false));
    expect(screen.getByTestId("headline")).toHaveTextContent("No agent runs are recorded for this environment.");
    expect(await screen.findByText(/No logged errors in the last 24 hours/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has run the agent loop/)).toBeInTheDocument();
    // Both lines, side by side: the ingest's and the agent's (#274).
    expect(screen.getByTestId("engine")).toHaveTextContent("demo");
    expect(screen.getByTestId("agent")).toHaveTextContent("demo");
  });

  it("counts what is waiting on a human, running, open and regressed from stored records", async () => {
    const hour = String(Math.floor(now / 3_600_000));
    mocks.listIncidents.mockResolvedValue({
      rows: [incident({ occurrencesByHour: { [hour]: 7 } }), incident({ id: "i2", status: "recurred", recurrenceCount: 1 })],
      capped: false,
    });
    renderPage();
    act(() =>
      mocks.cyclesCb!(
        [cycle("a", { state: "waiting-human", path: "pr" }), cycle("b", { state: "running", leaseExpiresAt: ts(now + 60_000) }), cycle("c", { state: "declined", path: "decline" })],
        false
      )
    );
    expect(screen.getByTestId("headline")).toHaveTextContent("One run is waiting on a human.");
    expect(tile("Waiting on a human")).toHaveTextContent("1");
    expect(tile("Runs in progress")).toHaveTextContent("1");
    expect(await screen.findByText(/7 occurrences in the last 24 hours/)).toBeInTheDocument();
    expect(tile("Open incidents")).toHaveTextContent("2");
    expect(tile("Regressions")).toHaveTextContent("1");
    const did = screen.getByRole("region", { name: "What the agent did" });
    expect(within(did).getByText("Pull request opened")).toBeInTheDocument();
    expect(within(did).getByRole("link", { name: /Pull request opened/ })).toHaveAttribute("href", "/runs?path=pr");
    expect(within(did).getByText("Declined: no fix attempted")).toBeInTheDocument();
    expect(within(did).getByText("Not finished")).toBeInTheDocument();
  });

  it("counts healed on its own only from a missing-index run recorded as healed, and links the filtered list (#38)", () => {
    renderPage();
    act(() => mocks.cyclesCb!([], false));
    expect(tile("Healed on its own")).toHaveTextContent("0");
    expect(tile("Healed on its own").closest("a")).toHaveAttribute("href", "/runs?heal=healed");
    expect(screen.getByText(/none recorded: only a missing-index heal that held/)).toBeInTheDocument();
    act(() =>
      mocks.cyclesCb!(
        [
          cycle("a", { path: "index", summary: { index: { runtime: "healed" } } }),
          cycle("b", { path: "index", summary: { index: { runtime: "observing" } } }),
          cycle("c", { path: "pr", summary: { prState: { state: "merged" } } }),
          cycle("d", { path: "index", synthetic: true, summary: { index: { runtime: "healed" } } }),
        ],
        false
      )
    );
    expect(tile("Healed on its own")).toHaveTextContent("1");
    expect(tile("Waiting on a human").closest("a")).toHaveAttribute("href", "/runs?state=waiting-human");
    expect(tile("Runs in progress").closest("a")).toHaveAttribute("href", "/runs?state=running");
    // An index run is counted by its path too (it was missing from the list, which made the count NaN).
    const did = screen.getByRole("region", { name: "What the agent did" });
    expect(within(did).getByRole("link", { name: /Missing index/ })).toHaveTextContent("3");
  });

  it("shows key figures that keep their denominators, and dashes when there is nothing to divide", async () => {
    const hour = String(Math.floor(now / 3_600_000));
    mocks.listIncidents.mockResolvedValue({
      rows: [incident({ triageState: "pending", occurrencesByHour: { [hour]: 5 } }), incident({ id: "i2", triageState: "declined" })],
      capped: false,
    });
    renderPage();
    expect(screen.getByTestId("kpi-Pull requests opened")).toHaveTextContent("…");
    act(() => mocks.cyclesCb!([], false));
    expect(screen.getByTestId("kpi-Pull requests opened")).toHaveTextContent("–");
    expect(screen.getByTestId("kpi-Median run length")).toHaveTextContent("–");
    act(() => mocks.cyclesCb!([cycle("a", { state: "waiting-human", path: "pr" }), cycle("b", { state: "failed", path: "failed" })], false));
    expect(screen.getByTestId("kpi-Pull requests opened")).toHaveTextContent("1 of 2");
    expect(screen.getByTestId("kpi-Failed runs")).toHaveTextContent("1 of 2");
    await waitFor(() => expect(screen.getByTestId("kpi-Untriaged incidents")).toHaveTextContent("1"));
    expect(screen.getByTestId("kpi-Errors this hour")).toHaveTextContent("5");
  });

  it("links the latest runs to their pages", () => {
    renderPage();
    act(() => mocks.cyclesCb!([cycle("inc-a_r0", { incidentId: "inc-a" })], false));
    const latest = screen.getByRole("region", { name: "Latest runs" });
    expect(within(latest).getByRole("link", { name: "inc-a" })).toHaveAttribute("href", "/runs?run=inc-a_r0");
  });

  it("says when the runs or the incidents can't be read", async () => {
    mocks.listIncidents.mockRejectedValue(new Error("denied"));
    renderPage();
    act(() => mocks.cyclesErr!(new Error("denied")));
    expect(screen.getByTestId("headline")).toHaveTextContent("The agent's runs couldn't be read.");
    expect(await screen.findByText("Couldn't read the incidents.")).toBeInTheDocument();
  });

  // #262: a UI deployed ahead of its rules or indexes read "couldn't be read" on every tile, with nothing to say why.
  it("says what to check when a read fails, the hint the Runs page gives, and nothing when every read works", async () => {
    renderPage();
    act(() => mocks.cyclesCb!([], false));
    act(() => mocks.eventsCb!([]));
    await waitFor(() => expect(tile("Open incidents")).toHaveTextContent("0"));
    expect(screen.queryByTestId("read-failure-hint")).toBeNull();

    act(() => mocks.eventsErr!(new Error("failed-precondition: the query requires an index")));
    const hint = screen.getByTestId("read-failure-hint");
    expect(hint).toHaveTextContent("Some of this page couldn't be read.");
    expect(hint).toHaveTextContent("Check that firestore.rules and firestore.indexes.json are deployed to the Starfish database.");
    expect(hint).toHaveTextContent("An index deployed in the last few minutes may still be building");
    expect(screen.getAllByTestId("read-failure-hint")).toHaveLength(1);
  });

  it("gives the hint when the incidents can't be read", async () => {
    mocks.listIncidents.mockRejectedValue(new Error("denied"));
    renderPage();
    expect(await screen.findByTestId("read-failure-hint")).toBeInTheDocument();
  });

  it("gives the hint when the runs can't be read", () => {
    renderPage();
    act(() => mocks.cyclesErr!(new Error("denied")));
    expect(screen.getByTestId("read-failure-hint")).toBeInTheDocument();
  });

  it("stops showing the last figures once a read fails, instead of passing them off as current (#195)", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.listIncidents.mockResolvedValue({ rows: [incident(), incident({ id: "i2", status: "recurred", recurrenceCount: 1 })], capped: false });
    renderPage(client);
    act(() => mocks.cyclesCb!([cycle("a", { state: "waiting-human", path: "pr" })], false));
    await waitFor(() => expect(tile("Open incidents")).toHaveTextContent("2"));
    expect(tile("Waiting on a human")).toHaveTextContent("1");

    mocks.listIncidents.mockRejectedValue(new Error("denied"));
    await act(() => client.refetchQueries());
    act(() => mocks.cyclesErr!(new Error("denied")));
    for (const label of ["Open incidents", "Regressions", "Waiting on a human", "Runs in progress", "Healed on its own"]) {
      expect(tile(label), label).toHaveTextContent("–");
    }
    expect(screen.getByTestId("kpi-Untriaged incidents")).toHaveTextContent("–");
    expect(screen.getByTestId("kpi-Pull requests opened")).toHaveTextContent("–");
    expect(within(screen.getByRole("region", { name: "Latest runs" })).getByText("Couldn't read the runs.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "What the agent did" })).getByText("Couldn't read the runs.")).toBeInTheDocument();
  });

  it("says when run counts cover only the most recent runs", () => {
    renderPage();
    act(() => mocks.cyclesCb!([cycle("a")], true));
    expect(screen.getByText(/most recently updated runs only/)).toBeInTheDocument();
  });
});

describe("Overview latest activity", () => {
  const activity = (cycleId: string, seq: number, over: Record<string, unknown> = {}): ActivityRow =>
    parseActivity("starfish_cycles", "demo", `starfish_cycles/${cycleId}/events/${String(seq).padStart(6, "0")}`, {
      seq,
      environment: "demo",
      stage: "triage",
      type: "decision",
      summary: "act: the error is new and recurring",
      at: ts(now - 120_000),
      ...over,
    })!;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cyclesCb = mocks.cyclesErr = mocks.eventsCb = mocks.eventsErr = undefined;
    mocks.listIncidents.mockResolvedValue({ rows: [], capped: false });
  });

  it("lists the newest run events with their stage, type, summary and time, each linking to its run", () => {
    renderPage();
    act(() => mocks.eventsCb!([activity("inc-b_r1", 3, { stage: "verify", type: "passed", summary: "pnpm test passed" }), activity("inc-a_r0", 1)]));
    const feed = screen.getByRole("region", { name: "Latest activity" });
    const links = within(feed).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/runs?run=inc-b_r1");
    expect(links[0]).toHaveTextContent("Verify gate · passed");
    expect(links[0]).toHaveTextContent("pnpm test passed");
    expect(links[1]).toHaveAttribute("href", "/runs?run=inc-a_r0");
    expect(links[1]).toHaveTextContent("Triage · decision");
    expect(within(feed).getAllByText("2 minutes ago")).toHaveLength(2);
  });

  it("says no events are recorded rather than showing an empty list", () => {
    renderPage();
    expect(within(screen.getByRole("region", { name: "Latest activity" })).getByText("Loading…")).toBeInTheDocument();
    act(() => mocks.eventsCb!([]));
    expect(screen.getByText("No run events are recorded for this environment.")).toBeInTheDocument();
  });

  it("says the events couldn't be read, and not that there are none", () => {
    renderPage();
    act(() => mocks.eventsErr!(new Error("failed-precondition: needs an index")));
    const feed = screen.getByRole("region", { name: "Latest activity" });
    expect(within(feed).getByRole("alert")).toHaveTextContent("Couldn't read the run events.");
    expect(within(feed).queryByText(/No run events/)).not.toBeInTheDocument();
  });
});
