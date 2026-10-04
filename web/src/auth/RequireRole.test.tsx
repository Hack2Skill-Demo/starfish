import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { Ctx, type StarfishAuthCtx, type StarfishRole } from "./authCore";
import { RequireRole } from "./RequireRole";
import { normalizeRoles } from "./session";
import { returnPath, signInErrorMessage } from "./SignIn";

function renderAt(ctx: Partial<StarfishAuthCtx>, allowedRoles?: StarfishRole[], allowGuest = false) {
  const value: StarfishAuthCtx = {
    user: null,
    roles: [],
    role: null,
    loading: false,
    signOut: async () => {},
    guest: false,
    enterAsGuest: async () => false, // by default a project with Anonymous sign-in off
    ...ctx,
  };
  return render(
    <Ctx.Provider value={value}>
      <MemoryRouter initialEntries={["/secret"]}>
        <Routes>
          <Route path="/secret" element={<RequireRole allowedRoles={allowedRoles} allowGuest={allowGuest}>secret page</RequireRole>} />
          <Route path="/signin" element={<>sign in page</>} />
          <Route path="/access-denied" element={<>denied page</>} />
        </Routes>
      </MemoryRouter>
    </Ctx.Provider>
  );
}

const user = { uid: "u1" } as StarfishAuthCtx["user"];

describe("RequireRole", () => {
  it("waits while the session resolves instead of redirecting", () => {
    renderAt({ loading: true, user });
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("sends a signed-out visitor to sign-in when a guest session isn't possible", async () => {
    renderAt({});
    expect(await screen.findByText("sign in page")).toBeInTheDocument();
  });

  it("tries to start a guest session for a signed-out visitor, and waits rather than redirecting", async () => {
    const enterAsGuest = vi.fn(() => new Promise<boolean>(() => {})); // never settles
    renderAt({ enterAsGuest });
    expect(await screen.findByText("Loading...")).toBeInTheDocument();
    expect(enterAsGuest).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("sign in page")).toBeNull();
  });

  it("doesn't try a guest session while the session is still resolving, or for a signed-in user", () => {
    const enterAsGuest = vi.fn(async () => true);
    renderAt({ loading: true, enterAsGuest });
    renderAt({ user, roles: ["operator"], enterAsGuest });
    expect(enterAsGuest).not.toHaveBeenCalled();
  });

  it("denies a signed-in user with no Starfish role", () => {
    renderAt({ user, roles: [] });
    expect(screen.getByText("denied page")).toBeInTheDocument();
  });

  it("denies an operator on an admin-only route, and admits an admin", () => {
    renderAt({ user, roles: ["operator"] }, ["admin"]);
    expect(screen.getByText("denied page")).toBeInTheDocument();
  });

  it("admits a user holding an allowed role", () => {
    renderAt({ user, roles: ["admin"] }, ["admin"]);
    expect(screen.getByText("secret page")).toBeInTheDocument();
  });
});

describe("RequireRole: guests (issue #12)", () => {
  const guestUser = { uid: "g1", isAnonymous: true } as StarfishAuthCtx["user"];

  it("admits a guest on a route that allows guests", () => {
    renderAt({ user: guestUser, guest: true }, undefined, true);
    expect(screen.getByText("secret page")).toBeInTheDocument();
  });

  it("admits a guest on an admin-only route only if it also allows guests (view-only Settings)", () => {
    renderAt({ user: guestUser, guest: true }, ["admin"], true);
    expect(screen.getByText("secret page")).toBeInTheDocument();
  });

  it("sends a guest to sign-in, not access-denied, on a route that doesn't allow guests", async () => {
    renderAt({ user: guestUser, guest: true }, ["admin"]);
    await waitFor(() => expect(screen.getByText("sign in page")).toBeInTheDocument());
    expect(screen.queryByText("denied page")).toBeNull();
  });

  it("a guest never counts as holding a role", () => {
    renderAt({ user: guestUser, guest: true, roles: ["admin"] }, ["admin"]); // even a corrupted context
    expect(screen.getByText("sign in page")).toBeInTheDocument();
  });
});

describe("normalizeRoles", () => {
  it("keeps only known roles and rejects non-arrays", () => {
    expect(normalizeRoles(["admin", "root", 7])).toEqual(["admin"]);
    expect(normalizeRoles("admin")).toEqual([]);
  });
});

describe("signInErrorMessage", () => {
  it("never reveals whether an account exists", () => {
    expect(signInErrorMessage("auth/user-not-found")).toBe(signInErrorMessage("auth/wrong-password"));
    expect(signInErrorMessage(undefined)).toBe("Sign in failed. Please try again.");
  });
});

describe("returnPath", () => {
  it("returns to the page the guard bounced from, query included", () => {
    expect(returnPath({ from: { pathname: "/settings", search: "?x=1" } })).toBe("/settings?x=1");
  });
  it("falls back to incidents for missing, external or looping targets", () => {
    expect(returnPath(null)).toBe("/incidents");
    expect(returnPath({ from: { pathname: "//evil.example" } })).toBe("/incidents");
    expect(returnPath({ from: { pathname: "/signin" } })).toBe("/incidents");
  });
});
