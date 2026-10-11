import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { GuestBar } from "./GuestBar";

vi.mock("../lib/config", () => ({ webConfig: () => ({ demoSignInHint: "They are in our slides." }) }));

describe("GuestBar", () => {
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
