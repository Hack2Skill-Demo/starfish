import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/config", () => ({ webConfig: () => ({ firebase: { projectId: "demo" }, environment: "prod" }) }));
vi.mock("../lib/useSettings", () => ({ useEnvironment: () => ({ environment: "staging-eu", ready: true }) }));
vi.mock("./SettingsEditor", () => ({ SettingsEditor: () => <div>settings editor</div> }));

import Settings, { CONNECTIONS } from "./Settings";

describe("Settings", () => {
  it("reports unbuilt integrations as not connected — never as working", () => {
    render(<Settings />);
    const planned = CONNECTIONS.filter((c) => c.state === "planned").map((c) => c.name);
    expect(planned).toEqual(expect.arrayContaining(["GitHub", "Slack"]));
    expect(screen.getAllByText("Not connected yet")).toHaveLength(planned.length);
  });

  it("names the environment the settings resolved, and mounts the editor", () => {
    render(<Settings />);
    expect(screen.getByText(/staging-eu/)).toBeInTheDocument();
    expect(screen.getByText("settings editor")).toBeInTheDocument();
  });
});
