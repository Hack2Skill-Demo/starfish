import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/config", () => ({ webConfig: () => ({ firebase: { projectId: "demo" }, environment: "prod" }) }));

import Settings, { CONNECTIONS } from "./Settings";

describe("Settings", () => {
  it("reports unbuilt integrations as not connected — never as working", () => {
    render(<Settings />);
    const planned = CONNECTIONS.filter((c) => c.state === "planned").map((c) => c.name);
    expect(planned).toEqual(expect.arrayContaining(["GitHub", "Slack"]));
    expect(screen.getAllByText("Not connected yet")).toHaveLength(planned.length);
  });
});
