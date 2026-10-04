import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "../auth/authCore";

vi.mock("../lib/config", () => ({ webConfig: () => ({ firebase: { projectId: "demo" }, environment: "prod" }) }));
vi.mock("../lib/useSettings", () => ({ useEnvironment: () => ({ environment: "staging-eu", ready: true }) }));
vi.mock("./SettingsEditor", () => ({ SettingsEditor: () => <div>settings editor</div> }));

import Settings, { CONNECTIONS } from "./Settings";

function renderSettings(guest = false) {
  const ctx: StarfishAuthCtx = {
    user: { uid: "u1", isAnonymous: guest } as StarfishAuthCtx["user"],
    roles: guest ? [] : ["admin"],
    role: guest ? null : "admin",
    loading: false,
    signOut: async () => {},
    guest,
    enterAsGuest: async () => false,
  };
  return render(
    <Ctx.Provider value={ctx}>
      <Settings />
    </Ctx.Provider>
  );
}

describe("Settings", () => {
  it("reports unbuilt integrations as not connected — never as working", () => {
    renderSettings();
    const planned = CONNECTIONS.filter((c) => c.state === "planned").map((c) => c.name);
    expect(planned).toEqual(expect.arrayContaining(["GitHub", "Slack"]));
    expect(screen.getAllByText("Not connected yet")).toHaveLength(planned.length);
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
});
