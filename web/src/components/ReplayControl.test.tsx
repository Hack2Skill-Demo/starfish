import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReplayControl } from "./ReplayControl";
import type { ReplaySpeedChoice } from "../lib/runsModel";

function setup(over: { replaying?: boolean; speed?: ReplaySpeedChoice } = {}) {
  const onToggle = vi.fn();
  const onSpeed = vi.fn();
  render(
    <div>
      <ReplayControl replaying={over.replaying ?? false} onToggle={onToggle} speed={over.speed ?? 10} onSpeed={onSpeed} spanMs={144_000} />
      <p>Elsewhere</p>
    </div>
  );
  const trigger = screen.getByRole("button", { name: /^Replay speed:/ });
  return { onToggle, onSpeed, trigger };
}

describe("ReplayControl", () => {
  it("is one control: the left half plays or stops, the right half shows the current speed", () => {
    const { onToggle, trigger } = setup();
    expect(trigger).toHaveTextContent("10×");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Watch replay" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("says Stop replay while replaying", () => {
    setup({ replaying: true });
    expect(screen.getByRole("button", { name: "Stop replay" })).toBeInTheDocument();
  });

  it("shows Auto's speed for this run, and how long the run takes at each speed", () => {
    const { trigger } = setup({ speed: "auto" });
    // 144 s: auto plays it at 3×.
    expect(trigger).toHaveTextContent("Auto · 3×");
    fireEvent.click(trigger);
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.querySelector(".font-bold")?.textContent)).toEqual(["Auto (3×)", "1×", "2×", "5×", "10×", "30×", "60×"]);
    expect(items[0]).toHaveTextContent("This run: 48 s.");
    expect(items[1]).toHaveTextContent("As it happened: 2 min 24 s.");
    expect(items[4]).toHaveTextContent("This run in 14 s.");
  });

  it("opens on the checked speed, moves with the arrows, picks with Enter and gives focus back", () => {
    const { onSpeed, trigger } = setup();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const ten = screen.getByRole("menuitemradio", { name: /^10×/ });
    expect(ten).toHaveAttribute("aria-checked", "true");
    expect(ten).toHaveFocus();
    fireEvent.keyDown(ten, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: /^30×/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("menuitemradio", { name: /^60×/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: /^Auto/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    // Enter on a button is its click.
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^60×/ }));
    expect(onSpeed).toHaveBeenCalledWith(60);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape with focus back on the speed button, and on a click outside, choosing nothing", () => {
    const { onSpeed, trigger } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onSpeed).not.toHaveBeenCalled();
  });
});
