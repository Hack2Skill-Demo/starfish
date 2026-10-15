import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DemoAppLink, DemoLabButton } from "./DemoAppLink";

const mocks = vi.hoisted(() => ({ demoAppUrl: "" }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ demoAppUrl: mocks.demoAppUrl }) }));

describe("DemoAppLink", () => {
  beforeEach(() => {
    mocks.demoAppUrl = "";
  });

  it("renders nothing when no demo app is configured", () => {
    const { container } = render(<DemoAppLink />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links to the configured Lab in a new tab", () => {
    mocks.demoAppUrl = "https://shop.example/#lab";
    render(<DemoAppLink />);
    const link = screen.getByRole("link", { name: /open the demo shop's lab/i });
    expect(link).toHaveAttribute("href", "https://shop.example/#lab");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });
});

describe("DemoLabButton", () => {
  beforeEach(() => {
    mocks.demoAppUrl = "";
  });

  it("renders nothing when no demo app is configured", () => {
    const { container } = render(<DemoLabButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens a dialog with the Lab invitation and its link, and closes it", () => {
    mocks.demoAppUrl = "https://shop.example/#lab";
    render(<DemoLabButton />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const opener = screen.getByRole("button", { name: /open its lab/i });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: /the demo shop's lab/i });
    expect(dialog).toHaveAccessibleDescription(/break one part of the demo shop on purpose/i);
    expect(dialog).toHaveFocus();
    const link = screen.getByRole("link", { name: /open the demo shop's lab/i });
    expect(link).toHaveAttribute("href", "https://shop.example/#lab");
    expect(link).toHaveAttribute("target", "_blank");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes from Not now, the close button and the backdrop, but not a click inside", () => {
    mocks.demoAppUrl = "https://shop.example/#lab";
    render(<DemoLabButton />);
    const open = () => fireEvent.click(screen.getByRole("button", { name: /open its lab/i }));

    open();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    open();
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps Tab inside the dialog", () => {
    mocks.demoAppUrl = "https://shop.example/#lab";
    render(<DemoLabButton />);
    fireEvent.click(screen.getByRole("button", { name: /open its lab/i }));
    const link = screen.getByRole("link", { name: /open the demo shop's lab/i });
    link.focus();
    fireEvent.keyDown(link, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Tab", shiftKey: true });
    expect(link).toHaveFocus();
  });
});
