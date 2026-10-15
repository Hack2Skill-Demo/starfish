import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuestBar } from "./GuestBar";

const cfg = vi.hoisted(() => ({ open: false }));
vi.mock("../lib/config", () => ({
  webConfig: () => ({
    demoSignInHint: "They are in our slides.",
    sourceUrl: "",
    environment: "demo",
    publicDemoActions: cfg.open,
    publicLimits: { actionsPerIpPerHour: 30, runsPerIpPerHour: 3, agentRunsPerHour: 6 },
  }),
}));

describe("GuestBar", () => {
  beforeEach(() => {
    cfg.open = false;
  });

  it("says view only, and nothing about limits, where the public demo's open actions are off", () => {
    render(
      <MemoryRouter>
        <GuestBar askToSignIn={false} />
      </MemoryRouter>
    );
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Public demo · view only");
    expect(screen.getByRole("contentinfo")).not.toHaveTextContent(/IP address|billing/);
  });

  it("where they are on, says no sign-in is needed and that actions are limited per IP address to protect billing", () => {
    cfg.open = true;
    render(
      <MemoryRouter>
        <GuestBar askToSignIn={false} />
      </MemoryRouter>
    );
    const bar = screen.getByRole("contentinfo");
    expect(bar).toHaveTextContent("No sign-in needed: triage, retry and run the agent");
    expect(bar).toHaveTextContent("limited per IP address to protect our cloud and model billing");
    expect(bar).not.toHaveTextContent("view only");
  });

  it("asks a guest who did not choose the demo view to sign in, with the hint", () => {
    render(
      <MemoryRouter>
        <GuestBar askToSignIn />
      </MemoryRouter>
    );
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Sign in for the full records. They are in our slides.");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
  });

  it("only offers the link to one who chose it, and reopens the guide", async () => {
    const onOpenGuide = vi.fn();
    render(
      <MemoryRouter>
        <GuestBar askToSignIn={false} onOpenGuide={onOpenGuide} />
      </MemoryRouter>
    );
    expect(screen.getByRole("contentinfo")).not.toHaveTextContent("They are in our slides.");
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "What is Starfish?" }));
    expect(onOpenGuide).toHaveBeenCalled();
  });
});
