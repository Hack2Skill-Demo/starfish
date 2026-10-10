import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";

vi.mock("../lib/config", () => ({ webConfig: () => ({ firebase: { projectId: "demo" }, environment: "prod", runCollection: "starfish_runs" }) }));
vi.mock("../lib/firebase", () => ({ firestore: () => ({}) }));
const { readIntegrations } = vi.hoisted(() => ({ readIntegrations: vi.fn() }));
vi.mock("../lib/integrations", async (orig) => ({ ...(await orig<typeof import("../lib/integrations")>()), readIntegrations }));
vi.mock("../lib/useSettings", () => ({ useEnvironment: () => ({ environment: "staging-eu", ready: true }) }));
vi.mock("./SettingsEditor", () => ({ SettingsEditor: () => <div>settings editor</div> }));
vi.mock("./OnCallEditor", () => ({ OnCallEditor: () => <div>on-call editor</div> }));

import Settings, { CONNECTIONS } from "./Settings";

function renderSettings(guest = false, role: "admin" | "operator" = "admin") {
  const ctx: StarfishAuthCtx = {
    user: { uid: "u1", isAnonymous: guest } as StarfishAuthCtx["user"],
    roles: guest ? [] : [role],
    role: guest ? null : role,
    loading: false,
    signOut: async () => {},
    guest,
    enterAsGuest: async () => false,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Ctx.Provider value={ctx}>
        <Settings />
      </Ctx.Provider>
    </QueryClientProvider>
  );
}

const report = (over: Record<string, unknown> = {}) => ({
  environment: "staging-eu",
  checkedAt: new Date(),
  github: false,
  slackOnCall: false,
  slackAlerts: false,
  twilio: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  readIntegrations.mockResolvedValue(null);
});

describe("Settings", () => {
  it("reports unbuilt integrations as not connected — never as working", () => {
    renderSettings();
    const planned = CONNECTIONS.filter((c) => c.state === "planned").map((c) => c.name);
    expect(planned).toEqual(expect.arrayContaining(["GitHub", "Slack"]));
    expect(screen.getAllByText("Not connected yet")).toHaveLength(planned.length);
  });

  it("says the rules and feedback engines are built, and that they only hold Starfish back", () => {
    renderSettings();
    const card = CONNECTIONS.find((c) => c.name === "Rules & feedback engines")!;
    expect(card.state).toBe("built");
    expect(screen.getByText("Built")).toBeInTheDocument();
    expect(card.detail).toContain("only hold Starfish back");
    expect(card.detail).toContain("not yet run on a real incident");
  });

  it("says the token is configured, never connected, once the agent has reported one", async () => {
    readIntegrations.mockResolvedValue(report({ github: true }));
    renderSettings();
    expect(await screen.findByText("Token configured")).toBeInTheDocument();
    expect(screen.getByText(/A token is set; the agent reports only that it is set, not whether it works\./)).toBeInTheDocument();
    expect(screen.queryByText(/nothing has checked it/)).toBeNull();
    expect(screen.queryByText(/^Connected/)).toBeNull();
    // Slack was reported with no webhook: neutral. The rules card is built and reads no report.
    expect(screen.getByText("No webhook set")).toBeInTheDocument();
    expect(screen.queryByText("Not connected yet")).toBeNull();
  });

  it("says no token is set when the agent reported none", async () => {
    readIntegrations.mockResolvedValue(report());
    renderSettings();
    expect(await screen.findByText("No token set")).toBeInTheDocument();
  });

  it("names which Slack webhooks are set", async () => {
    readIntegrations.mockResolvedValue(report({ slackOnCall: true, slackAlerts: true, twilio: true }));
    renderSettings();
    expect(await screen.findByText("Webhook configured")).toBeInTheDocument();
    expect(screen.getByText(/on-call and alerts webhooks are set; the agent reports only that they are set, not whether they work\./)).toBeInTheDocument();
    expect(screen.queryByText(/nothing has posted/)).toBeNull();
    expect(screen.getByText(/Twilio credentials are set/)).toBeInTheDocument();
  });

  it("says a single webhook is set, and only that", async () => {
    readIntegrations.mockResolvedValue(report({ slackAlerts: true }));
    renderSettings();
    expect(await screen.findByText(/The alerts webhook is set; the agent reports only that it is set, not whether it works\./)).toBeInTheDocument();
  });

  it("ignores a report written for another environment", async () => {
    readIntegrations.mockResolvedValue(report({ github: true, environment: "prod" }));
    renderSettings();
    await waitFor(() => expect(readIntegrations).toHaveBeenCalled());
    expect(screen.queryByText("Token configured")).toBeNull();
    expect(screen.getAllByText("Not connected yet")).toHaveLength(2);
  });

  it("keeps 'not connected yet' when the report cannot be read", async () => {
    readIntegrations.mockRejectedValue(new Error("permission-denied"));
    renderSettings();
    // Let the rejection settle inside the test, so it is not left to surface after it.
    await waitFor(() => expect(readIntegrations).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getAllByText("Not connected yet")).toHaveLength(2);
  });

  it("names the environment the settings resolved, and mounts the editor for an admin", () => {
    renderSettings();
    expect(screen.getByText(/staging-eu/)).toBeInTheDocument();
    expect(screen.getByText("settings editor")).toBeInTheDocument();
  });

  it("is view-only for a guest: the same connections, no editor, and a note saying why (#12)", () => {
    renderSettings(true);
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("settings editor")).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("editable by the team only");
    expect(screen.getByRole("note")).toHaveTextContent("Secrets never appear on this page");
  });

  it("shows the on-call rota (phone numbers) to an admin only: never an operator or a guest (#37)", () => {
    renderSettings();
    expect(screen.getByText("on-call editor")).toBeInTheDocument();
  });

  it("hides the on-call rota from an operator", () => {
    renderSettings(false, "operator");
    expect(screen.queryByText("on-call editor")).toBeNull();
  });

  it("hides the on-call rota from a guest", () => {
    renderSettings(true);
    expect(screen.queryByText("on-call editor")).toBeNull();
  });
});
