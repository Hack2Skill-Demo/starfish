import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  config: { incidentCollection: "starfish_incidents", adminApiUrl: "" },
  markStarted: vi.fn(),
}));
vi.mock("../lib/firebase", () => ({ firebaseAuth: vi.fn(), firestore: vi.fn() }));
vi.mock("../lib/config", () => ({ webConfig: () => mocks.config }));
vi.mock("./ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../lib/agentStart", () => ({ markAgentStartRequested: mocks.markStarted }));

import { RetryRunButton } from "./RetryRunButton";

function renderWith(ui: React.ReactNode, roles: StarfishAuthCtx["roles"], signedIn = true) {
  const ctx: StarfishAuthCtx = {
    user: signedIn ? ({ uid: "u1" } as StarfishAuthCtx["user"]) : null,
    roles,
    role: roles[0] ?? null,
    loading: false,
    signOut: async () => {},
    guest: false,
    enterAsGuest: async () => false,
  };
  return render(<Ctx.Provider value={ctx}>{ui}</Ctx.Provider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.adminApiUrl = "";
});

describe("RetryRunButton", () => {
  it("asks for the incident's retry once, as the signed-in operator", async () => {
    const ask = vi.fn().mockResolvedValue(undefined);
    renderWith(<RetryRunButton incidentId="inc-a" ask={ask} />, ["operator"]);
    await userEvent.click(screen.getByRole("button", { name: "Retry with agent" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry requested" })).toBeDisabled());
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith("inc-a", "u1");
    expect(mocks.toast.success).toHaveBeenCalledWith(expect.stringContaining("Retry requested"));
  });

  it("says so when the request is refused, and can be tried again", async () => {
    const ask = vi.fn().mockRejectedValue(new Error("permission-denied"));
    renderWith(<RetryRunButton incidentId="inc-a" ask={ask} />, ["operator"]);
    await userEvent.click(screen.getByRole("button", { name: "Retry with agent" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Retry with agent" })).toBeEnabled();
  });

  it("is not offered to a visitor with no role or no session", () => {
    renderWith(<RetryRunButton incidentId="inc-a" ask={vi.fn()} />, []);
    expect(screen.queryByRole("button")).toBeNull();
    renderWith(<RetryRunButton incidentId="inc-a" ask={vi.fn()} />, ["operator"], false);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("starts an agent pass for an admin, after the retry is recorded, and says the agent is starting", async () => {
    mocks.config.adminApiUrl = "https://admin.example.test";
    const order: string[] = [];
    const ask = vi.fn(async () => void order.push("ask"));
    const startAgent = vi.fn(async () => (order.push("start"), { ok: true as const, value: null }));
    renderWith(<RetryRunButton incidentId="inc-a" ask={ask} startAgent={startAgent} />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: "Retry with agent" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Agent started" })).toBeDisabled());
    expect(order).toEqual(["ask", "start"]);
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(mocks.markStarted).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledWith(expect.stringContaining("agent pass started"));
  });

  it("keeps the retry when the pass cannot be started, and says the next pass runs it", async () => {
    mocks.config.adminApiUrl = "https://admin.example.test";
    const startAgent = vi.fn().mockResolvedValue({ ok: false, message: "This deployment has no agent job the admin service can start." });
    renderWith(<RetryRunButton incidentId="inc-a" ask={vi.fn().mockResolvedValue(undefined)} startAgent={startAgent} />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: "Retry with agent" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry requested" })).toBeDisabled());
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining("no agent job"));
    expect(mocks.markStarted).not.toHaveBeenCalled();
  });

  it("starts nothing when the retry itself was refused", async () => {
    mocks.config.adminApiUrl = "https://admin.example.test";
    const startAgent = vi.fn();
    renderWith(<RetryRunButton incidentId="inc-a" ask={vi.fn().mockRejectedValue(new Error("permission-denied"))} startAgent={startAgent} />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: "Retry with agent" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(startAgent).not.toHaveBeenCalled();
  });

  it("leaves an operator's retry, or one on a build with no admin API, to the next scheduled pass", async () => {
    mocks.config.adminApiUrl = "https://admin.example.test";
    const startAgent = vi.fn();
    const { unmount } = renderWith(<RetryRunButton incidentId="inc-a" ask={vi.fn().mockResolvedValue(undefined)} startAgent={startAgent} />, ["operator"]);
    await userEvent.click(screen.getByRole("button", { name: "Retry with agent" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry requested" })).toBeDisabled());
    unmount();

    mocks.config.adminApiUrl = "";
    renderWith(<RetryRunButton incidentId="inc-a" ask={vi.fn().mockResolvedValue(undefined)} startAgent={startAgent} />, ["admin"]);
    await userEvent.click(screen.getByRole("button", { name: "Retry with agent" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry requested" })).toBeDisabled());
    expect(startAgent).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenLastCalledWith(expect.stringContaining("next scheduled agent pass"));
  });
});
