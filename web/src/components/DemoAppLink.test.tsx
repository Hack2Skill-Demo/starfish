import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DemoAppLink } from "./DemoAppLink";

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
