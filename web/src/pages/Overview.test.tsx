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

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
    expect(screen.getByTestId("engine")).toHaveTextContent("demo");
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
