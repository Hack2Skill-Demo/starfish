import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";

const mocks = vi.hoisted(() => ({
  adminApiUrl: "https://admin.example",
  runIngestNow: vi.fn(),
  runAgentNow: vi.fn(),
  retireIncident: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  navigate: vi.fn(),
  markAgentStartRequested: vi.fn(),
}));
vi.mock("../lib/agentStart", () => ({ markAgentStartRequested: mocks.markAgentStartRequested }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ adminApiUrl: mocks.adminApiUrl }) }));
vi.mock("../lib/firebase", () => ({ firebaseAuth: vi.fn() }));
vi.mock("../lib/adminApi", () => ({
  appAdminApi: () => ({ baseUrl: "x", getToken: async () => "t" }),
  runIngestNow: mocks.runIngestNow,
  runAgentNow: mocks.runAgentNow,
  retireIncident: mocks.retireIncident,
}));
vi.mock("./ui/toast", () => ({ toast: mocks.toast }));
vi.mock("react-router", async (orig) => ({ ...(await orig<typeof import("react-router")>()), useNavigate: () => mocks.navigate }));

import { RetireControl, RunAgentButton, RunIngestButton, describeRun } from "./AdminActions";

function renderWith(ui: React.ReactNode, roles: StarfishAuthCtx["roles"]) {
  const ctx: StarfishAuthCtx = { user: null, roles, role: roles[0] ?? null, loading: false, signOut: async () => {}, guest: false, enterAsGuest: async () => false };
  return render(
    <Ctx.Provider value={ctx}>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </Ctx.Provider>
  );
}

const summary = { outcome: "ok", windows: 1, entriesProcessed: 5, incidentsCreated: 2, incidentsUpdated: 1, incidentsRecurred: 0, capped: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adminApiUrl = "https://admin.example";
});

describe("describeRun", () => {
  it("reports counts for a finished run, and a floor when capped", () => {
    expect(describeRun(summary)).toEqual({ ok: true, text: "Run finished: 2 new, 1 updated, 0 recurred." });
    expect(describeRun({ ...summary, capped: true }).text).toContain("floor");
  });
  it("calls an idle run nothing to read, not a failure", () => {
    expect(describeRun({ ...summary, outcome: "idle", windows: 0 })).toMatchObject({ ok: true, text: expect.stringContaining("no new log window") });
  });
  it("does not call a failed run finished", () => {
    expect(describeRun({ ...summary, outcome: "failed", error: "quota" })).toEqual({ ok: false, text: "The run did not finish (failed): quota." });
  });
});

describe("RunIngestButton", () => {
  it("is absent for operators, guests, and a site with no admin API URL", () => {
    renderWith(<RunIngestButton />, ["operator"]);
    renderWith(<RunIngestButton />, []);
    mocks.adminApiUrl = "";
    renderWith(<RunIngestButton />, ["admin"]);
    expect(screen.queryByRole("button", { name: /run ingest now/i })).toBeNull();
  });

  it("runs, then reports the outcome", async () => {
    mocks.runIngestNow.mockResolvedValue({ ok: true, value: summary });
    const done = vi.fn();
    renderWith(<RunIngestButton onDone={done} />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: /run ingest now/i }));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Run finished: 2 new, 1 updated, 0 recurred."));
    expect(done).toHaveBeenCalled();
  });

  it("shows the refusal and nothing else when the call fails", async () => {
    mocks.runIngestNow.mockResolvedValue({ ok: false, message: "Only admins can do this." });
    renderWith(<RunIngestButton />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: /run ingest now/i }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Only admins can do this."));
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});

describe("RunAgentButton (#276)", () => {
  it("is absent for operators, guests, and a site with no admin API URL", () => {
    renderWith(<RunAgentButton />, ["operator"]);
    renderWith(<RunAgentButton />, []);
    mocks.adminApiUrl = "";
    renderWith(<RunAgentButton />, ["admin"]);
    expect(screen.queryByRole("button", { name: /run agent now/i })).toBeNull();
  });

  it("says the pass started, never that it finished", async () => {
    mocks.runAgentNow.mockResolvedValue({ ok: true, value: null });
    renderWith(<RunAgentButton />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: /run agent now/i }));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledTimes(1));
    const said = String(mocks.toast.success.mock.calls[0]![0]);
    expect(said).toContain("Agent pass started");
    expect(said).not.toMatch(/finished|done|complete/i);
    expect(mocks.runAgentNow).toHaveBeenCalledTimes(1);
    // The agent's status is told, so it shows the start without a page refresh.
    expect(mocks.markAgentStartRequested).toHaveBeenCalledTimes(1);
  });

  it("shows the refusal and nothing else when the start fails", async () => {
    mocks.runAgentNow.mockResolvedValue({ ok: false, message: "The agent job could not be started. Check the admin service's logs." });
    renderWith(<RunAgentButton />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: /run agent now/i }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("The agent job could not be started. Check the admin service's logs."));
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.markAgentStartRequested).not.toHaveBeenCalled();
  });

  it("cannot be clicked twice while a start is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    mocks.runAgentNow.mockReturnValue(new Promise((r) => (release = r)));
    renderWith(<RunAgentButton />, ["admin"]);
    const button = screen.getByRole("button", { name: /run agent now/i });
    await userEvent.click(button);
    expect(screen.getByRole("button", { name: /starting/i })).toHaveProperty("disabled", true);
    release({ ok: true, value: null });
    await waitFor(() => expect(screen.getByRole("button", { name: /run agent now/i })).toHaveProperty("disabled", false));
    expect(mocks.runAgentNow).toHaveBeenCalledTimes(1);
  });
});

describe("RetireControl", () => {
  it("is absent unless the viewer is an admin", () => {
    renderWith(<RetireControl incidentId="i1" />, ["operator"]);
    expect(screen.queryByRole("button", { name: /retire/i })).toBeNull();
  });

  it("asks first, says what it does, and sends the reason", async () => {
    mocks.retireIncident.mockResolvedValue({ ok: true, value: { alreadyRetired: false } });
    renderWith(<RetireControl incidentId="i1" />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: "Retire" }));
    expect(screen.getByText(/frees its fingerprint/i)).toBeTruthy();
    expect(mocks.retireIncident).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/reason/i), " test noise ");
    await userEvent.click(screen.getByRole("button", { name: "Retire incident" }));
    await waitFor(() => expect(mocks.retireIncident).toHaveBeenCalledWith(expect.anything(), "i1", "test noise"));
    expect(mocks.navigate).toHaveBeenCalledWith("/incidents");
  });

  it("stays on the page and says why when it fails", async () => {
    mocks.retireIncident.mockResolvedValue({ ok: false, message: "That incident no longer exists." });
    renderWith(<RetireControl incidentId="i1" />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: "Retire" }));
    await userEvent.click(screen.getByRole("button", { name: "Retire incident" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("cancel closes the form without calling the API", async () => {
    renderWith(<RetireControl incidentId="i1" />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: "Retire" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Retire" })).toBeTruthy();
    expect(mocks.retireIncident).not.toHaveBeenCalled();
  });
});
