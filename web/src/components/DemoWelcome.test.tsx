import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasChosenGuestView, isWelcomeDismissed, setWelcomeDismissed } from "../lib/demoGuide";
import { DemoWelcome } from "./DemoWelcome";

const cfg = vi.hoisted(() => ({ open: false, limits: { actionsPerIpPerHour: 30, runsPerIpPerHour: 3, agentRunsPerHour: 6 } }));
vi.mock("../lib/config", () => ({
  webConfig: () => ({ demoSignInHint: "They are in our slides.", environment: "demo", publicDemoActions: cfg.open, publicLimits: cfg.limits }),
}));

function SignInPage() {
  const from = (useLocation().state as { from?: { pathname?: string } } | null)?.from?.pathname;
  return <>sign-in page from {from}</>;
}

function renderGuide(props: { guest: boolean; askToSignIn: boolean }) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={["/runs"]}>
      <Routes>
        <Route path="/runs" element={<DemoWelcome {...props} onClose={onClose} />} />
        <Route path="/signin" element={<SignInPage />} />
      </Routes>
    </MemoryRouter>
  );
  return onClose;
}

describe("DemoWelcome", () => {
  beforeEach(() => {
    localStorage.clear();
    cfg.open = false;
    cfg.limits = { actionsPerIpPerHour: 30, runsPerIpPerHour: 3, agentRunsPerHour: 6 };
  });

  it("tells a guest nothing about open actions or limits where the public demo's open actions are off", async () => {
    const user = userEvent.setup();
    renderGuide({ guest: true, askToSignIn: false });
    expect(screen.queryByTestId("visitor-actions")).toBeNull();
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/IP address|billing/);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("The view-only demo shows trimmed copies");
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/IP address|billing/);
  });

  it("where they are on, tells a guest what they can do and the per-IP limits that protect billing, with the configured numbers", async () => {
    cfg.open = true;
    const user = userEvent.setup();
    renderGuide({ guest: true, askToSignIn: false });
    const callout = screen.getByTestId("visitor-actions");
    expect(callout).toHaveTextContent("No sign-in needed");
    expect(callout).toHaveTextContent("retry a run, correct triage, and start an ingest run or an agent pass yourself");
    expect(callout).toHaveTextContent("To protect our cloud and Gemini billing, these actions are limited per IP address");
    expect(callout).toHaveTextContent("up to 30 incident actions and 3 ingest or agent starts an hour from one address, and 6 agent passes an hour started by all visitors together");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog")).not.toHaveTextContent("view-only demo");
    expect(screen.getByRole("dialog")).toHaveTextContent("limited per IP address");
  });

  it("quotes the build's numbers, not fixed ones", () => {
    cfg.open = true;
    cfg.limits = { actionsPerIpPerHour: 10, runsPerIpPerHour: 1, agentRunsPerHour: 2 };
    renderGuide({ guest: true, askToSignIn: false });
    expect(screen.getByTestId("visitor-actions")).toHaveTextContent("up to 10 incident actions and 1 ingest or agent start an hour from one address, and 2 agent passes an hour");
  });

  it("does not show a signed-in visitor the visitors' limits", () => {
    cfg.open = true;
    renderGuide({ guest: false, askToSignIn: false });
    expect(screen.queryByTestId("visitor-actions")).toBeNull();
  });

  it("walks through three steps and ends on Start exploring for a signed-in visitor", async () => {
    const user = userEvent.setup();
    const onClose = renderGuide({ guest: false, askToSignIn: false });
    expect(screen.getByRole("dialog", { name: "Meet Starfish" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: "How an incident moves" })).toHaveTextContent("Pull request");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: "Take a look around" })).toHaveTextContent("Runs");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "How an incident moves" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Start exploring" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers Don't show this again only on the last step, and remembers it in this browser", async () => {
    const user = userEvent.setup();
    const onClose = renderGuide({ guest: false, askToSignIn: false });
    expect(screen.queryByRole("checkbox", { name: "Don't show this again" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.queryByRole("checkbox", { name: "Don't show this again" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    const box = screen.getByRole("checkbox", { name: "Don't show this again" });
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(isWelcomeDismissed()).toBe(true);
    await user.click(box);
    expect(isWelcomeDismissed()).toBe(false);
    await user.click(box);
    // Closing with the X keeps the choice, like Start exploring.
    await user.click(screen.getByRole("button", { name: "Close the guide" }));
    expect(onClose).toHaveBeenCalled();
    expect(isWelcomeDismissed()).toBe(true);
  });

  it("shows the box ticked when the guide is reopened after Don't show this again", async () => {
    setWelcomeDismissed(true);
    const user = userEvent.setup();
    renderGuide({ guest: false, askToSignIn: false });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("checkbox", { name: "Don't show this again" })).toBeChecked();
  });

  it("shows the demo's own link on the last step", async () => {
    const user = userEvent.setup();
    renderGuide({ guest: false, askToSignIn: false });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("link", { name: /localhost/ })).toHaveAttribute("href", window.location.origin);
  });

  it("asks a guest who did not choose the demo view to sign in, says where the details are, and returns them here", async () => {
    const user = userEvent.setup();
    const onClose = renderGuide({ guest: true, askToSignIn: true });
    expect(screen.getByRole("dialog")).toHaveTextContent("They are in our slides.");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByText("sign-in page from /runs")).toBeInTheDocument();
  });

  it("remembers Continue view-only, so the guest is not asked again", async () => {
    const user = userEvent.setup();
    const onClose = renderGuide({ guest: true, askToSignIn: true });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Continue view-only" }));
    expect(hasChosenGuestView()).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not ask a guest who chose the demo view, but says what the view leaves out", async () => {
    const user = userEvent.setup();
    renderGuide({ guest: true, askToSignIn: false });
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("trimmed copies");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start exploring" })).toBeInTheDocument();
  });

  it("closes on Escape and from the close button", async () => {
    const user = userEvent.setup();
    const onClose = renderGuide({ guest: false, askToSignIn: false });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close the guide" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  // #359: Next is gone on the last step and Back on the first; the pressed button unmounting dropped focus to the page,
  // outside the overlay that handles Escape and Tab.
  it("keeps focus in the dialog when Next or Back unmounts the button pressed, so Escape still closes it", async () => {
    const user = userEvent.setup();
    const onClose = renderGuide({ guest: false, askToSignIn: false });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Take a look around" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Meet Starfish" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps Tab inside the dialog, the Don't show this again box included", async () => {
    const user = userEvent.setup();
    renderGuide({ guest: false, askToSignIn: false });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    const close = screen.getByRole("button", { name: "Close the guide" });
    const box = screen.getByRole("checkbox", { name: "Don't show this again" });
    const done = screen.getByRole("button", { name: "Start exploring" });
    // From the step's heading, Shift+Tab wraps to the last control rather than leaving the dialog.
    await user.tab({ shift: true });
    expect(done).toHaveFocus();
    await user.tab({ shift: true });
    expect(box).toHaveFocus();
    await user.tab();
    expect(done).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(done).toHaveFocus();
  });
});
