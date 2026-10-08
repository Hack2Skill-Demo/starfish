import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";
import type { IncidentRow } from "../lib/incidents";
import { parseCycle, type CycleRow } from "../lib/runsModel";

const mocks = vi.hoisted(() => ({
  listIncidents: vi.fn(),
  applyAction: vi.fn(),
  env: { environment: "prod", ready: true, settingsUnavailable: false },
  cycles: [] as unknown[],
  cyclesCapped: false,
  readCycle: vi.fn(),
}));
vi.mock("../lib/runs", () => ({
  subscribeCycles: (_env: string, ok: (rows: unknown[], capped: boolean) => void) => {
    ok(mocks.cycles, mocks.cyclesCapped);
    return () => {};
  },
  readCycle: mocks.readCycle,
}));
vi.mock("../components/EngineStatus", () => ({
  EngineStatus: ({ environment }: { environment: string }) => <div data-testid="engine-status-stub">{environment}</div>,
}));
vi.mock("../lib/useSettings", () => ({ useEnvironment: () => mocks.env }));
vi.mock("../lib/incidents", async (orig) => ({
  ...(await orig<typeof import("../lib/incidents")>()),
  listIncidents: mocks.listIncidents,
  applyAction: mocks.applyAction,
}));
vi.mock("../lib/firebase", () => ({ firestore: vi.fn() }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ functionsRegion: "us-central1", incidentCollection: "incidents" }) }));

import Incidents, { filterRows } from "./Incidents";

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
function cycle(id: string, over: Record<string, unknown> = {}): CycleRow {
  return parseCycle(id, {
    incidentId: id.replace(/_r\d+$/, ""),
    environment: "prod",
    recurrence: Number(/_r(\d+)$/.exec(id)![1]),
    state: "declined",
    path: "decline",
    attempts: 1,
    eventCount: 1,
    createdAt: ts(Date.now() - 60_000),
    updatedAt: ts(Date.now() - 1000),
    leaseExpiresAt: null,
    deadlineAt: null,
    summary: { triage: { decision: "decline", rule: "model-decline", reason: "A single 404 from a demo stub; no user impact." } },
    ...over,
  })!;
}

const base: IncidentRow = {
  id: "1",
  functionName: "mailDrainer",
  service: "mail",
  environment: "prod",
  errorType: "UnknownError",
  errorMessage: "send failed",
  occurrenceCount: 40,
  windowedCount: 12,
  firstOccurredAt: "2026-09-24T08:00:00.000Z",
  lastOccurredAt: "2026-09-24T11:00:00.000Z",
  status: "new",
  sourceProjectId: "demo",
  recurrenceCount: 0,
};
const rows: IncidentRow[] = [
  base,
  { ...base, id: "2", functionName: "orders-updateOrder", service: "orders", status: "ignored" },
];

function renderPage(roles: StarfishAuthCtx["roles"] = ["operator"], guest = false) {
  const ctx: StarfishAuthCtx = {
    user: { uid: "u1", isAnonymous: guest } as StarfishAuthCtx["user"],
    roles,
    role: roles[0] ?? null,
    loading: false,
    signOut: async () => {},
    guest,
    enterAsGuest: async () => false,
  };
  return render(
    <Ctx.Provider value={ctx}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <Incidents />
        </MemoryRouter>
      </QueryClientProvider>
    </Ctx.Provider>
  );
}

describe("Incidents page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env = { environment: "prod", ready: true, settingsUnavailable: false };
    mocks.listIncidents.mockResolvedValue({ rows, capped: false });
    mocks.applyAction.mockResolvedValue(undefined);
    mocks.cycles = [];
    mocks.cyclesCapped = false;
    mocks.readCycle.mockResolvedValue(null);
  });

  describe("the agent's run for each incident", () => {
    it("shows the run's state, triage's decision and reason, and links to that run", async () => {
      mocks.cycles = [cycle("1_r0")];
      renderPage();
      const row = (await screen.findByText("mailDrainer")).closest("tr")!;
      expect(within(row).getByText("Declined")).toBeInTheDocument();
      expect(within(row).getByText("A single 404 from a demo stub; no user impact.")).toBeInTheDocument();
      expect(within(row).getByRole("link", { name: "Run for mailDrainer" })).toHaveAttribute("href", "/runs?run=1_r0");
    });

    it("uses the run of the incident's current recurrence, never an earlier one", async () => {
      mocks.listIncidents.mockResolvedValue({ rows: [{ ...base, recurrenceCount: 1, status: "recurred" }], capped: false });
      mocks.cycles = [cycle("1_r0"), cycle("1_r1", { state: "waiting-human", path: "notify", summary: { triage: { decision: "notify", reason: "The API is disabled." } } })];
      renderPage();
      const row = (await screen.findByText("mailDrainer")).closest("tr")!;
      expect(within(row).getByText("Waiting for a human")).toBeInTheDocument();
      expect(within(row).getByRole("link", { name: "Run for mailDrainer" })).toHaveAttribute("href", "/runs?run=1_r1");
    });

    it("says 'No run yet' only when every run was read", async () => {
      renderPage();
      const row = (await screen.findByText("mailDrainer")).closest("tr")!;
      expect(within(row).getByText("No agent run yet")).toBeInTheDocument();
      expect(mocks.readCycle).not.toHaveBeenCalled();
    });

    it("reads a run outside the newest by its id when the list is capped", async () => {
      mocks.cyclesCapped = true;
      mocks.readCycle.mockImplementation(async (id: string) => (id === "1_r0" ? cycle("1_r0") : null));
      renderPage();
      const row = (await screen.findByText("mailDrainer")).closest("tr")!;
      expect(await within(row).findByText("Declined")).toBeInTheDocument();
      expect(mocks.readCycle).toHaveBeenCalledWith("1_r0", "prod");
      const other = screen.getByText("orders-updateOrder").closest("tr")!;
      expect(await within(other).findByText("No agent run yet")).toBeInTheDocument();
    });

    it("says nothing about an incident whose run could not be read", async () => {
      mocks.cyclesCapped = true;
      mocks.readCycle.mockRejectedValue(new Error("denied"));
      renderPage();
      const row = (await screen.findByText("mailDrainer")).closest("tr")!;
      await vi.waitFor(() => expect(mocks.readCycle).toHaveBeenCalled());
      expect(within(row).queryByText("No agent run yet")).toBeNull();
      expect(within(row).queryByRole("link", { name: "Run for mailDrainer" })).toBeNull();
    });

    it("stops saying 'In progress' once the run's lease runs out, with no new snapshot", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mocks.cycles = [cycle("1_r0", { state: "running", path: undefined, leaseExpiresAt: ts(Date.now() + 5000) })];
        renderPage();
        const row = (await screen.findByText("mailDrainer")).closest("tr")!;
        expect(within(row).getByText("In progress")).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(16_000);
        });
        expect(within(row).getByText("Waiting for a worker")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows the full decision, its rule and the run in the expanded row", async () => {
      mocks.cycles = [cycle("1_r0")];
      renderPage();
      const row = (await screen.findByText("mailDrainer")).closest("tr")!;
      await userEvent.click(within(row).getByRole("button", { name: "Show incident details" }));
      expect(screen.getByText("Agent decision")).toBeInTheDocument();
      expect(screen.getByText("Decline")).toBeInTheDocument();
      expect(screen.getByText("model-decline")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Open the run/ })).toHaveAttribute("href", "/runs?run=1_r0");
    });
  });

  it("lists incidents under the environment label the settings resolved", async () => {
    mocks.env = { environment: "staging-eu", ready: true, settingsUnavailable: false };
    renderPage();
    await screen.findByText("mailDrainer");
    expect(mocks.listIncidents).toHaveBeenCalledWith(24, "staging-eu");
  });

  it("links each incident to its evidence page", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: "Evidence for mailDrainer" });
    expect(link).toHaveAttribute("href", "/incidents/1");
  });

  it("shows the engine's status for the environment being viewed, once the settings have settled", async () => {
    mocks.env = { environment: "staging-eu", ready: true, settingsUnavailable: false };
    renderPage();
    expect(await screen.findByTestId("engine-status-stub")).toHaveTextContent("staging-eu");
  });

  it("shows a guest the incidents but offers no triage action at all (#12)", async () => {
    renderPage([], true);
    const row = (await screen.findByText("mailDrainer")).closest("tr")!;
    expect(within(row).getByText("New")).toBeInTheDocument();
    // Row actions are labelled "<Action> <function>"; the status filter pills ("Resolved") are not them.
    expect(screen.queryAllByRole("button", { name: /^(Acknowledge|Resolve|Ignore|Reopen) \S/ })).toHaveLength(0);
    // And no Actions column to hold them.
    expect(screen.queryByRole("columnheader", { name: /actions/i })).toBeNull();
  });

  it("says so when the settings couldn't be read, instead of showing a possibly wrong list as a quiet day (#43)", async () => {
    mocks.env = { environment: "build-label", ready: true, settingsUnavailable: true };
    mocks.listIncidents.mockResolvedValue({ rows: [], capped: false });
    renderPage();
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("Couldn't read the runtime settings");
    expect(notice).toHaveTextContent("build-label");
    expect(await screen.findByText("No incidents")).toBeInTheDocument();
  });

  it("links a stored issue or PR only when it is an https URL (#144)", async () => {
    mocks.listIncidents.mockResolvedValue({
      rows: [
        { ...base, githubIssueUrl: "https://github.com/o/r/issues/7", githubIssueNumber: 7, githubPrUrl: "javascript:alert(1)", githubPrNumber: 8 },
        {
          ...base,
          id: "2",
          functionName: "orders-updateOrder",
          recurrenceCount: 1,
          previousIssueUrl: "http://example.com/issues/3",
          previousIssueNumber: 3,
        },
      ],
      capped: false,
    });
    renderPage();
    expect(await screen.findByRole("link", { name: "#7" })).toHaveAttribute("href", "https://github.com/o/r/issues/7");
    expect(screen.queryByRole("link", { name: /PR #8/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /was #3/ })).toBeNull();
  });

  it("shows no such notice when the settings simply don't exist", async () => {
    renderPage();
    await screen.findByText("mailDrainer");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("queries nothing until the settings have settled, so the wrong label's incidents never flash", async () => {
    mocks.env = { environment: "prod", ready: false, settingsUnavailable: false };
    renderPage();
    expect(screen.queryByText("mailDrainer")).toBeNull();
    expect(mocks.listIncidents).not.toHaveBeenCalled();
  });

  it("lists incidents with windowed counts, status, and a Logs link", async () => {
    renderPage();
    expect(await screen.findByText("mailDrainer")).toBeInTheDocument();
    expect(screen.getByText("orders-updateOrder")).toBeInTheDocument();
    const row = screen.getByText("mailDrainer").closest("tr")!;
    expect(within(row).getByText("12")).toBeInTheDocument();
    expect(within(row).getByText("New")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /Logs/ })).toHaveAttribute("href", expect.stringContaining("project=demo"));
  });

  it("offers only the actions valid for each status, and applies one", async () => {
    renderPage();
    const row = (await screen.findByText("mailDrainer")).closest("tr")!;
    expect(within(row).queryByRole("button", { name: /Reopen/ })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Acknowledge mailDrainer" }));
    expect(mocks.applyAction).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }), "acknowledge", "u1");

    const ignored = screen.getByText("orders-updateOrder").closest("tr")!;
    expect(within(ignored).getByRole("button", { name: "Reopen orders-updateOrder" })).toBeInTheDocument();
  });

  it("badges a Monitoring-only incident, and shows a log incident's Monitoring count beside its own (#19)", async () => {
    mocks.listIncidents.mockResolvedValue({
      rows: [
        { ...base, monitoringCount: 7 },
        { ...base, id: "m", functionName: "orders-sync", errorType: "UnloggedFailure", monitoringOnly: true, monitoringCount: 5 },
      ],
      capped: false,
    });
    renderPage();
    const mon = (await screen.findByText("orders-sync")).closest("tr")!;
    expect(within(mon).getByText("Monitoring only")).toBeInTheDocument();
    // Its count is its occurrences: no second Monitoring line.
    expect(within(mon).queryByText(/^Monitoring: /)).toBeNull();

    const logged = screen.getByText("mailDrainer").closest("tr")!;
    expect(within(logged).queryByText("Monitoring only")).toBeNull();
    expect(within(logged).getByText("Monitoring: 7 failed")).toBeInTheDocument();
  });

  it("marks a regression and links the issue whose fix didn't hold", async () => {
    mocks.listIncidents.mockResolvedValue({
      rows: [
        ...rows,
        {
          ...base,
          id: "3",
          functionName: "billing-charge",
          status: "recurred",
          recurrenceCount: 2,
          previousIssueNumber: 42,
          previousIssueUrl: "https://example.test/issues/42",
        },
      ],
      capped: false,
    });
    renderPage();
    const row = (await screen.findByText("billing-charge")).closest("tr")!;
    expect(within(row).getByText("Recurred")).toBeInTheDocument();
    expect(within(row).getByText("Regression ×2")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "was #42" })).toHaveAttribute("href", "https://example.test/issues/42");
    // A regression is open work: resolve or ignore, never acknowledge or reopen.
    expect(within(row).getByRole("button", { name: "Resolve billing-charge" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Ignore billing-charge" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Acknowledge|Reopen/ })).toBeNull();

    // A first occurrence carries no regression marker.
    const fresh = screen.getByText("mailDrainer").closest("tr")!;
    expect(within(fresh).queryByText(/Regression/)).toBeNull();
  });

  it("shows the empty state for a quiet window", async () => {
    mocks.listIncidents.mockResolvedValue({ rows: [], capped: false });
    renderPage();
    expect(await screen.findByText("No incidents")).toBeInTheDocument();
  });

  it("says so when the window was capped", async () => {
    mocks.listIncidents.mockResolvedValue({ rows, capped: true });
    renderPage();
    expect(await screen.findByText(/there may be more/)).toBeInTheDocument();
  });

  it("shows an error state when the store can't be read", async () => {
    mocks.listIncidents.mockRejectedValue(new Error("permission-denied"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load incidents");
  });
});

describe("filterRows", () => {
  it("filters by status, service, and a case-insensitive function substring", () => {
    expect(filterRows(rows, { status: "ignored", service: "", fn: "" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterRows(rows, { status: "", service: "mail", fn: "" }).map((r) => r.id)).toEqual(["1"]);
    expect(filterRows(rows, { status: "", service: "", fn: "MAIL" }).map((r) => r.id)).toEqual(["1"]);
  });
});
