/**
 * The routes as App declares them, with the real guards and the real Settings page: who reaches /settings, and what
 * they see there (#355). The layout is reduced to its outlet and the editors to a marker each.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx, type StarfishRole } from "./auth/authCore";

vi.mock("./layout/StarfishLayout", () => ({ StarfishLayout: () => <Outlet /> }));
vi.mock("./pages/Overview", () => ({ default: () => <p>overview page</p> }));
vi.mock("./lib/config", () => ({ webConfig: () => ({ firebase: { projectId: "demo" }, environment: "prod", runCollection: "starfish_runs" }) }));
vi.mock("./lib/firebase", () => ({ firestore: () => ({}) }));
vi.mock("./lib/integrations", async (orig) => ({ ...(await orig<typeof import("./lib/integrations")>()), readIntegrations: vi.fn(async () => null) }));
vi.mock("./lib/useSettings", () => ({ useEnvironment: () => ({ environment: "prod", ready: true, settingsUnavailable: false }) }));
vi.mock("./pages/SettingsEditor", () => ({
  SettingsEditor: () => <div>settings editor</div>,
  SettingsReadOnly: ({ note }: { note: string }) => <p role="note">read-only settings: {note}</p>,
}));
vi.mock("./pages/OnCallEditor", () => ({ OnCallEditor: () => <div>on-call editor</div> }));

import App from "./App";

function renderAt(path: string, who: { roles: StarfishRole[] } | "guest") {
  const guest = who === "guest";
  const roles = guest ? [] : who.roles;
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
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Ctx.Provider value={ctx}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </Ctx.Provider>
    </QueryClientProvider>
  );
}

describe("App routes: /settings (#355)", () => {
  it("opens Settings read-only for an operator: no editor, no On-call, never access denied", async () => {
    renderAt("/settings", { roles: ["operator"] });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("only an admin can change");
    expect(screen.queryByText("settings editor")).toBeNull();
    expect(screen.queryByText("on-call editor")).toBeNull();
    expect(screen.queryByText("overview page")).toBeNull();
    expect(screen.queryByText(/access denied/i)).toBeNull();
  });

  it("opens the editor and On-call for an admin", async () => {
    renderAt("/settings", { roles: ["admin"] });
    expect(await screen.findByText("settings editor")).toBeInTheDocument();
    expect(screen.getByText("on-call editor")).toBeInTheDocument();
  });

  it("opens Settings read-only for a guest, with no On-call", async () => {
    renderAt("/settings", "guest");
    expect(await screen.findByRole("note")).toHaveTextContent("editable by the team only");
    expect(screen.queryByText("on-call editor")).toBeNull();
  });
});
