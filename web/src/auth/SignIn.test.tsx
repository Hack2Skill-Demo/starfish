import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx } from "./authCore";
import { SignIn } from "./SignIn";
import { hasChosenGuestView } from "../lib/demoGuide";

const mocks = vi.hoisted(() => ({ environment: "demo", actions: false }));
vi.mock("../lib/config", () => ({
  webConfig: () => ({ environment: mocks.environment, publicDemoActions: mocks.actions, demoSignInHint: "They are in our slides.", sourceUrl: "" }),
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
function renderSignIn(ctx: Partial<StarfishAuthCtx>, entry: string | { pathname: string; search?: string; state?: unknown } = "/signin") {
  let setCtx: (c: StarfishAuthCtx) => void = () => {};
  function Harness() {
    const [value, set] = useState<StarfishAuthCtx>({ ...baseCtx, ...ctx });
    setCtx = set;
    return (
      <Ctx.Provider value={value}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/signin" element={<SignIn />} />
            <Route path="/overview" element={<>overview page</>} />
            <Route path="/runs" element={<>runs page</>} />
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

describe("SignIn: the open demo asks nobody to sign in", () => {
  beforeEach(() => {
    mocks.environment = "demo";
    mocks.actions = true;
    localStorage.clear();
  });

  it("opens the demo by itself, with no form, and goes on to the page the visitor asked for", async () => {
    const enterAsGuest = vi.fn(async () => true);
    const update = renderSignIn({ enterAsGuest }, { pathname: "/signin", state: { from: { pathname: "/runs", search: "?run=inc1_r0" } } });
    expect(screen.getByRole("status")).toHaveTextContent("Opening the demo…");
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.getByText(/limited per IP address/)).toBeInTheDocument();
    await waitFor(() => expect(enterAsGuest).toHaveBeenCalledTimes(1));
    expect(enterAsGuest).toHaveBeenCalledWith({ requested: true });
    expect(hasChosenGuestView()).toBe(true);
    update({ user: guestUser, guest: true, enterAsGuest });
    expect(await screen.findByText("runs page")).toBeInTheDocument();
  });

  it("takes a visitor who is already a guest straight on", async () => {
    const enterAsGuest = vi.fn(async () => true);
    renderSignIn({ user: guestUser, guest: true, enterAsGuest });
    expect(await screen.findByText("overview page")).toBeInTheDocument();
    expect(enterAsGuest).not.toHaveBeenCalled();
  });

  it("shows the team's form behind Team sign-in, and keeps it there when the demo's session lands after", async () => {
    const enterAsGuest = vi.fn(async () => true);
    const update = renderSignIn({ enterAsGuest });
    await userEvent.setup().click(screen.getByRole("link", { name: "Team sign-in" }));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    // The visit's own start is the only one: the form does not open the demo again.
    expect(enterAsGuest).toHaveBeenCalledTimes(1);
    // The guest session the visit started arrives while the visitor is on the form: they stay on it.
    update({ user: guestUser, guest: true, enterAsGuest });
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByText("overview page")).toBeNull();
  });

  it("shows a guest who asks for Team sign-in the form, without sending them back into the demo", () => {
    const enterAsGuest = vi.fn(async () => true);
    renderSignIn({ user: guestUser, guest: true, enterAsGuest }, "/signin?team=1");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByText("overview page")).toBeNull();
    expect(enterAsGuest).not.toHaveBeenCalled();
  });

  it("falls back to the form with the reason when the demo cannot be opened", async () => {
    renderSignIn({ enterAsGuest: async () => false });
    expect(await screen.findByRole("alert")).toHaveTextContent("The demo view isn't available right now");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("shows a signed-in team member the form as before", () => {
    const enterAsGuest = vi.fn(async () => true);
    renderSignIn({ user: operator, roles: ["operator"], role: "operator", enterAsGuest });
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(enterAsGuest).not.toHaveBeenCalled();
  });
});

describe("SignIn: the demo view link", () => {
  beforeEach(() => {
    mocks.environment = "demo";
    mocks.actions = false;
    localStorage.clear();
  });

  it("says where the sign-in details are on the demo, and nowhere else", () => {
    renderSignIn({});
    expect(screen.getByText("They are in our slides.", { exact: false })).toBeInTheDocument();

    mocks.environment = "prod";
    renderSignIn({});
    expect(screen.getAllByText("They are in our slides.", { exact: false })).toHaveLength(1);
  });

  it("tells a visitor without the details they can still look around, with less to see", () => {
    renderSignIn({});
    expect(screen.getByText(/look around in the view-only demo/)).toHaveTextContent("fewer details");

    renderSignIn({ user: operator, roles: ["operator"], role: "operator" });
    expect(screen.getAllByText(/look around in the view-only demo/)).toHaveLength(1);
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
