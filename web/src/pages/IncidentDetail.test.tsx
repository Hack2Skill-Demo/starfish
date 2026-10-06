import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncidentRow } from "../lib/incidents";
import { parseCycle } from "../lib/runsModel";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";

const mocks = vi.hoisted(() => ({
  getIncident: vi.fn(),
  readCycle: vi.fn(),
  env: { environment: "demo", ready: true, settingsUnavailable: false },
}));
vi.mock("../lib/useSettings", () => ({ useEnvironment: () => mocks.env }));
vi.mock("../lib/incidents", async (orig) => ({ ...(await orig<typeof import("../lib/incidents")>()), getIncident: mocks.getIncident }));
vi.mock("../lib/runs", async (orig) => ({ ...(await orig<typeof import("../lib/runs")>()), readCycle: mocks.readCycle }));
vi.mock("../lib/firebase", () => ({ firestore: vi.fn() }));
vi.mock("../lib/config", () => ({ webConfig: () => ({}) }));

import IncidentDetail from "./IncidentDetail";

const row: IncidentRow = {
  id: "inc-1",
  functionName: "orders-create",
  service: "orders",
  environment: "demo",
  errorType: "TypeError",
  errorMessage: "x is undefined",
  occurrenceCount: 12,
  windowedCount: 12,
  firstOccurredAt: "2026-10-04T10:00:00.000Z",
  lastOccurredAt: "2026-10-04T11:00:00.000Z",
  status: "new",
  recurrenceCount: 0,
};
const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const cycle = (summary: Record<string, unknown>) =>
  parseCycle("inc-1_r0", { incidentId: "inc-1", environment: "demo", state: "waiting-human", createdAt: ts(0), updatedAt: ts(1000), summary })!;

const guestCtx: StarfishAuthCtx = {
  user: null,
  roles: [],
  role: null,
  loading: false,
  signOut: async () => {},
  guest: true,
  enterAsGuest: async () => false,
};

function renderPage(id = "inc-1") {
  return render(
    <Ctx.Provider value={guestCtx}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[`/incidents/${id}`]}>
          <Routes>
            <Route path="/incidents/:id" element={<IncidentDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </Ctx.Provider>
  );
}
const stage = (id: string) => document.querySelector(`[data-stage="${id}"]`)!;

describe("IncidentDetail page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIncident.mockResolvedValue(row);
    mocks.readCycle.mockResolvedValue(null);
    mocks.env = { environment: "demo", ready: true, settingsUnavailable: false };
  });

  it("says the settings couldn't be read, so \"no incident here\" isn't taken at face value (#143)", async () => {
    mocks.env = { environment: "build-label", ready: true, settingsUnavailable: true };
    mocks.getIncident.mockResolvedValue(null);
    renderPage();
    expect(await screen.findByText("No incident with this id in this environment.")).toBeInTheDocument();
    const notice = screen.getByText(/Couldn't read the runtime settings/);
    expect(notice).toHaveTextContent("build-label");
    expect(mocks.getIncident).toHaveBeenCalledWith("inc-1", "build-label");
  });

  it("shows no settings notice when the settings read succeeded", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "orders-create" });
    expect(screen.queryByText(/Couldn't read the runtime settings/)).toBeNull();
  });

  it("shows what was detected, and every later stage as not reached when no run is recorded", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "orders-create" })).toBeInTheDocument();
    expect(mocks.getIncident).toHaveBeenCalledWith("inc-1", "demo");
    expect(mocks.readCycle).toHaveBeenCalledWith("inc-1_r0", "demo");
    await screen.findAllByText("Not reached");
    for (const id of ["counter-check", "triage", "fix", "verify", "review", "pr"]) expect(stage(id).getAttribute("data-status")).toBe("not-reached");
  });

  it("draws this incident's own hourly occurrences, and nothing when it had none in the last day", async () => {
    const hour = Math.floor(Date.now() / 3_600_000);
    mocks.getIncident.mockResolvedValue({ ...row, occurrencesByHour: { [String(hour)]: 4, [String(hour - 1)]: 2, [String(hour - 90)]: 50 } });
    const first = renderPage();
    const bars = await screen.findByRole("list", { name: "Occurrences by hour, last 24 hours" });
    expect(bars.querySelectorAll("li")).toHaveLength(24);
    expect(bars.textContent).toMatch(/: 4/);
    expect(bars.textContent).not.toMatch(/: 50/);
    first.unmount();

    mocks.getIncident.mockResolvedValue({ ...row, occurrencesByHour: { [String(hour - 90)]: 50 } });
    renderPage();
    await screen.findByRole("heading", { name: "orders-create" });
    expect(screen.queryByRole("list", { name: /Occurrences by hour/ })).toBeNull();
  });

  it("shows a recorded stage's result and links the pull request", async () => {
    mocks.readCycle.mockResolvedValue(
      cycle({
        triage: { decision: "act", rule: "model-act", reason: "worth fixing" },
        pr: { opened: true, number: 42, url: "https://github.com/o/r/pull/42" },
      })
    );
    renderPage();
    expect(await screen.findByText("worth fixing")).toBeInTheDocument();
    expect(stage("triage").getAttribute("data-status")).toBe("recorded");
    expect(stage("fix").getAttribute("data-status")).toBe("not-reached");
    expect(screen.getByRole("link", { name: /github.com\/o\/r\/pull\/42/ })).toHaveAttribute("href", "https://github.com/o/r/pull/42");
    expect(screen.getByRole("link", { name: "inc-1_r0" })).toHaveAttribute("href", "/runs?run=inc-1_r0");
  });

  it("says so when the run record can't be read, and claims nothing about the later stages", async () => {
    mocks.readCycle.mockRejectedValue(new Error("denied"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read the agent's run record");
    expect(stage("triage")).toBeNull();
    expect(stage("detected")).not.toBeNull();
  });

  it("warns when the stages are not about the same patch", async () => {
    mocks.readCycle.mockResolvedValue(
      cycle({ verify: { status: "passed", patchSha256: "a".repeat(64) }, review: { verdict: "approve", patchSha256: "b".repeat(64) } })
    );
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("patch hash differs");
  });

  it("says there is no such incident, and when it can't be read", async () => {
    mocks.getIncident.mockResolvedValue(null);
    const first = renderPage("nope");
    expect(await screen.findByRole("alert")).toHaveTextContent("No incident with this id");
    first.unmount();
    mocks.getIncident.mockRejectedValue(new Error("denied"));
    renderPage("x");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read this incident");
    expect(mocks.readCycle).not.toHaveBeenCalled();
  });
});
