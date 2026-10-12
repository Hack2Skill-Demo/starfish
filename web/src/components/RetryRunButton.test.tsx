import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";

const mocks = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/firebase", () => ({ firebaseAuth: vi.fn(), firestore: vi.fn() }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ incidentCollection: "starfish_incidents" }) }));
vi.mock("./ui/toast", () => ({ toast: mocks.toast }));

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

beforeEach(() => vi.clearAllMocks());

describe("RetryRunButton", () => {
  it("asks for the incident's retry once, as the signed-in operator", async () => {
    const ask = vi.fn().mockResolvedValue(undefined);
    renderWith(<RetryRunButton incidentId="inc-a" ask={ask} />, ["operator"]);
    await userEvent.click(screen.getByRole("button", { name: "Retry this run" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry requested" })).toBeDisabled());
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith("inc-a", "u1");
    expect(mocks.toast.success).toHaveBeenCalledWith(expect.stringContaining("Retry requested"));
  });

  it("says so when the request is refused, and can be tried again", async () => {
    const ask = vi.fn().mockRejectedValue(new Error("permission-denied"));
    renderWith(<RetryRunButton incidentId="inc-a" ask={ask} />, ["operator"]);
    await userEvent.click(screen.getByRole("button", { name: "Retry this run" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Retry this run" })).toBeEnabled();
  });

  it("is not offered to a visitor with no role or no session", () => {
    renderWith(<RetryRunButton incidentId="inc-a" ask={vi.fn()} />, []);
    expect(screen.queryByRole("button")).toBeNull();
    renderWith(<RetryRunButton incidentId="inc-a" ask={vi.fn()} />, ["operator"], false);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
