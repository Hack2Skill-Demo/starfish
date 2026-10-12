import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ hint: "" }));
vi.mock("./config", () => ({ webConfig: () => ({ demoSignInHint: mocks.hint }) }));

import {
  hasChosenGuestView,
  isWelcomeDismissed,
  markGuestViewChosen,
  markWelcomeShownThisSession,
  setWelcomeDismissed,
  shouldAutoOpenWelcome,
  signInHint,
} from "./demoGuide";

describe("demoGuide", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens the guide by itself once per tab until Don't show this again is ticked", () => {
    expect(shouldAutoOpenWelcome()).toBe(true);
    markWelcomeShownThisSession();
    expect(shouldAutoOpenWelcome()).toBe(false);
    // A new tab (sessionStorage empty) opens it again: closing it is not "don't show again".
    sessionStorage.clear();
    expect(shouldAutoOpenWelcome()).toBe(true);
    setWelcomeDismissed(true);
    expect(isWelcomeDismissed()).toBe(true);
    expect(shouldAutoOpenWelcome()).toBe(false);
    // Unticking it forgets the choice.
    setWelcomeDismissed(false);
    expect(isWelcomeDismissed()).toBe(false);
    expect(shouldAutoOpenWelcome()).toBe(true);
  });

  it("keeps Don't show this again and the demo view choice separately", () => {
    setWelcomeDismissed(true);
    expect(hasChosenGuestView()).toBe(false);
    markGuestViewChosen();
    expect(hasChosenGuestView()).toBe(true);
    setWelcomeDismissed(false);
    expect(hasChosenGuestView()).toBe(true);
  });

  it("reads blocked storage as nothing remembered, and never throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => markWelcomeShownThisSession()).not.toThrow();
    expect(() => setWelcomeDismissed(true)).not.toThrow();
    expect(() => setWelcomeDismissed(false)).not.toThrow();
    expect(isWelcomeDismissed()).toBe(false);
    expect(shouldAutoOpenWelcome()).toBe(true);
  });

  it("uses the deployment's hint, else a generic line", () => {
    mocks.hint = "";
    expect(signInHint()).toBe("Use the email and password you were given.");
    mocks.hint = "They are in our slides.";
    expect(signInHint()).toBe("They are in our slides.");
  });
});
