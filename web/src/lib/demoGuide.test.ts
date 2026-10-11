import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ hint: "" }));
vi.mock("./config", () => ({ webConfig: () => ({ demoSignInHint: mocks.hint }) }));

import { hasChosenGuestView, hasSeenWelcome, markGuestViewChosen, markWelcomeSeen, signInHint } from "./demoGuide";

describe("demoGuide", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("remembers that the guide was seen and that the demo view was chosen, separately", () => {
    expect(hasSeenWelcome()).toBe(false);
    expect(hasChosenGuestView()).toBe(false);
    markWelcomeSeen();
    expect(hasSeenWelcome()).toBe(true);
    expect(hasChosenGuestView()).toBe(false);
    markGuestViewChosen();
    expect(hasChosenGuestView()).toBe(true);
  });

  it("reads blocked storage as nothing remembered, and never throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => markWelcomeSeen()).not.toThrow();
    expect(hasSeenWelcome()).toBe(false);
  });

  it("uses the deployment's hint, else a generic line", () => {
    mocks.hint = "";
    expect(signInHint()).toBe("Use the email and password you were given.");
    mocks.hint = "They are in our slides.";
    expect(signInHint()).toBe("They are in our slides.");
  });
});
