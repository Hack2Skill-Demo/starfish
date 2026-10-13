import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";
import type { IncidentRow } from "../lib/incidents";

const mocks = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/firebase", () => ({ firebaseAuth: vi.fn(), firestore: vi.fn() }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ incidentCollection: "starfish_incidents" }) }));
vi.mock("./ui/toast", () => ({ toast: mocks.toast }));
vi.mock("./RetryRunButton", () => ({ RetryRunButton: ({ incidentId }: { incidentId: string }) => <button type="button">Retry with agent ({incidentId})</button> }));

import { HandoffCard } from "./HandoffCard";

const row = (status: IncidentRow["status"]) => ({ id: "inc-a", status }) as IncidentRow;

function renderWith(ui: React.ReactNode, roles: StarfishAuthCtx["roles"]) {
  const ctx: StarfishAuthCtx = {
    user: roles.length > 0 ? ({ uid: "u1" } as StarfishAuthCtx["user"]) : ({ uid: "guest", isAnonymous: true } as StarfishAuthCtx["user"]),
    roles,
    role: roles[0] ?? null,
    loading: false,
    signOut: async () => {},
    guest: roles.length === 0,
    enterAsGuest: async () => false,
  };
  return render(
    <Ctx.Provider value={ctx}>
      <MemoryRouter>{ui}</MemoryRouter>
    </Ctx.Provider>
  );
}

beforeEach(() => vi.clearAllMocks());

describe("HandoffCard", () => {
  it("lists every step a person has, beside the control that does it", () => {
    renderWith(<HandoffCard path="human" incidentId="inc-a" incident={row("new")} issueUrl="https://github.com/o/r/issues/7" canRetry />, ["operator"]);
    const card = screen.getByRole("region", { name: "What you can do now" });
    for (const title of ["Take it", "Fix it yourself", "Let Starfish try again", "Starfish judged it wrong?", "Not worth fixing?"]) {
      expect(within(card).getByText(title)).toBeInTheDocument();
    }
    expect(within(card).getByRole("button", { name: "Acknowledge" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Mark resolved" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Ignore" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Retry with agent (inc-a)" })).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Open the issue/ })).toHaveAttribute("href", "https://github.com/o/r/issues/7");
    expect(within(card).getByRole("link", { name: /Correct triage/ })).toHaveAttribute("href", "/incidents/inc-a");
  });

  it("acts on the incident as the signed-in operator, then asks the page to re-read it", async () => {
    const act = vi.fn().mockResolvedValue(undefined);
    const onChanged = vi.fn();
    const incident = row("new");
    renderWith(<HandoffCard path="notify" incidentId="inc-a" incident={incident} canRetry={false} act={act} onChanged={onChanged} />, ["operator"]);
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(act).toHaveBeenCalledWith(incident, "acknowledge", "u1");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledWith("Acknowledged.");
  });

  it("says a refused change, and does not claim it", async () => {
    const act = vi.fn().mockRejectedValue(new Error("Missing or insufficient permissions."));
    const onChanged = vi.fn();
    renderWith(<HandoffCard path="human" incidentId="inc-a" incident={row("new")} canRetry={false} act={act} onChanged={onChanged} />, ["operator"]);
    await userEvent.click(screen.getByRole("button", { name: "Ignore" }));
    expect(mocks.toast.error).toHaveBeenCalledWith("Missing or insufficient permissions.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("offers only what the incident's status allows", () => {
    const { unmount } = renderWith(<HandoffCard path="human" incidentId="inc-a" incident={row("acknowledged")} canRetry={false} />, ["operator"]);
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.getByText("Acknowledged")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry with agent/ })).toBeNull();
    unmount();
    renderWith(<HandoffCard path="human" incidentId="inc-a" incident={row("recurred")} canRetry={false} />, ["operator"]);
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(screen.getByText(/Only a new incident can be acknowledged; this one is recurred/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark resolved" })).toBeInTheDocument();
  });

  it("shows a guest the steps without any button that changes the incident", () => {
    renderWith(<HandoffCard path="human" incidentId="inc-a" incident={row("new")} canRetry={false} />, []);
    expect(screen.getByText("Take it")).toBeInTheDocument();
    for (const name of ["Acknowledge", "Mark resolved", "Ignore"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("points at the evidence page when no issue was filed", () => {
    renderWith(<HandoffCard path="human" incidentId="inc-a" incident={row("new")} canRetry={false} />, ["operator"]);
    expect(screen.queryByRole("link", { name: /Open the issue/ })).toBeNull();
    expect(screen.getByText(/the incident's evidence page/)).toBeInTheDocument();
  });
});
