import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";
import type { IncidentRow } from "../lib/incidents";

const mocks = vi.hoisted(() => ({ listIncidents: vi.fn(), applyAction: vi.fn() }));
vi.mock("../lib/incidents", async (orig) => ({
  ...(await orig<typeof import("../lib/incidents")>()),
  listIncidents: mocks.listIncidents,
  applyAction: mocks.applyAction,
}));
vi.mock("../lib/firebase", () => ({ firestore: vi.fn() }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ functionsRegion: "us-central1", incidentCollection: "incidents" }) }));

import Incidents, { filterRows } from "./Incidents";

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

function renderPage(roles: StarfishAuthCtx["roles"] = ["operator"]) {
  const ctx: StarfishAuthCtx = {
    user: { uid: "u1" } as StarfishAuthCtx["user"],
    roles,
    role: roles[0] ?? null,
    loading: false,
    signOut: async () => {},
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
    mocks.listIncidents.mockResolvedValue({ rows, capped: false });
    mocks.applyAction.mockResolvedValue(undefined);
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
