import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "./authCore";
import { SignIn } from "./SignIn";
import { hasChosenGuestView } from "../lib/demoGuide";

const mocks = vi.hoisted(() => ({ environment: "demo" }));
vi.mock("../lib/config", () => ({
  webConfig: () => ({ environment: mocks.environment, demoSignInHint: "They are in our slides." }),
}));
vi.mock("../lib/firebase", () => ({ firebaseAuth: () => ({}) }));

const baseCtx: StarfishAuthCtx = {
  user: null,
  roles: [],
  role: null,
  loading: false,
  signOut: async () => {},
  guest: false,
  enterAsGuest: async () => false,
};

/** The sign-in page under a context the test can change, the way a token event would. */
function renderSignIn(ctx: Partial<StarfishAuthCtx>) {
  let setCtx: (c: StarfishAuthCtx) => void = () => {};
  function Harness() {
    const [value, set] = useState<StarfishAuthCtx>({ ...baseCtx, ...ctx });
    setCtx = set;
    return (
      <Ctx.Provider value={value}>
        <MemoryRouter initialEntries={["/signin"]}>
          <Routes>
            <Route path="/signin" element={<SignIn />} />
            <Route path="/overview" element={<>overview page</>} />
          </Routes>
        </MemoryRouter>
      </Ctx.Provider>
    );
  }
  render(<Harness />);
  return (c: Partial<StarfishAuthCtx>) => act(() => setCtx({ ...baseCtx, ...ctx, ...c }));
}

const guestUser = { uid: "guest-1", isAnonymous: true } as StarfishAuthCtx["user"];
const operator = { uid: "op-1", isAnonymous: false } as StarfishAuthCtx["user"];

describe("SignIn: the demo view link", () => {
  beforeEach(() => {
    mocks.environment = "demo";
    localStorage.clear();
  });

  it("says where the sign-in details are on the demo, and nowhere else", () => {
    renderSignIn({});
    expect(screen.getByText("They are in our slides.", { exact: false })).toBeInTheDocument();

    mocks.environment = "prod";
    renderSignIn({});
    expect(screen.getAllByText("They are in our slides.", { exact: false })).toHaveLength(1);
  });

  it("remembers that the visitor chose the demo view, so the app does not ask them to sign in", async () => {
    renderSignIn({ enterAsGuest: async () => true });
    await userEvent.setup().click(screen.getByRole("button", { name: "See the demo view" }));
    expect(hasChosenGuestView()).toBe(true);
  });

  it("asks for a guest session and opens Overview once the session is in", async () => {
    const enterAsGuest = vi.fn(async () => true);
    const update = renderSignIn({ enterAsGuest });
    await userEvent.setup().click(screen.getByRole("button", { name: "See the demo view" }));
    expect(enterAsGuest).toHaveBeenCalledWith({ requested: true });
    // Not before the token event: the route guard would find nobody signed in.
    expect(screen.queryByText("overview page")).toBeNull();
    await update({ user: guestUser, guest: true, enterAsGuest });
    expect(await screen.findByText("overview page")).toBeInTheDocument();
  });

  it("says so, and stays on sign-in, when a guest session can't start", async () => {
    renderSignIn({ enterAsGuest: async () => false });
    await userEvent.setup().click(screen.getByRole("button", { name: "See the demo view" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The demo view isn't available right now");
    await waitFor(() => expect(screen.getByRole("button", { name: "See the demo view" })).toBeEnabled());
  });

  it("is a plain link back for someone who is already a guest", () => {
    const enterAsGuest = vi.fn(async () => true);
    renderSignIn({ user: guestUser, guest: true, enterAsGuest });
    expect(screen.getByRole("link", { name: "See the demo view" })).toHaveAttribute("href", "/overview");
    expect(enterAsGuest).not.toHaveBeenCalled();
  });

  it("isn't offered to a signed-in team member, or by a build for another environment", () => {
    renderSignIn({ user: operator, roles: ["operator"], role: "operator" });
    expect(screen.queryByText("See the demo view")).toBeNull();

    mocks.environment = "prod";
    renderSignIn({});
    expect(screen.queryByText("See the demo view")).toBeNull();
  });
});
