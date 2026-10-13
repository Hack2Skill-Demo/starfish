import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceLink } from "./SourceLink";

const mocks = vi.hoisted(() => ({ sourceUrl: "" }));
vi.mock("../lib/config", () => ({ webConfig: () => ({ sourceUrl: mocks.sourceUrl }) }));

describe("SourceLink", () => {
  beforeEach(() => {
    mocks.sourceUrl = "";
  });

  it("renders nothing when no source URL is configured", () => {
    const { container } = render(<SourceLink />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links to the repository in a new tab", () => {
    mocks.sourceUrl = "https://github.com/Hack2Skill-Demo/starfish";
    render(<SourceLink />);
    const link = screen.getByRole("link", { name: "Source on GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/Hack2Skill-Demo/starfish");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });
});
