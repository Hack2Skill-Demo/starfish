import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { Ctx, type StarfishAuthCtx, type StarfishRole } from "./authCore";
import { RequireRole } from "./RequireRole";
import { normalizeRoles } from "./session";
import { returnPath, signInErrorMessage } from "./SignIn";

function renderAt(ctx: Partial<StarfishAuthCtx>, allowedRoles?: StarfishRole[]) {
  const value: StarfishAuthCtx = {
    user: null,
    roles: [],
    role: null,
    loading: false,
    signOut: async () => {},
    ...ctx,
  };
  return render(
    <Ctx.Provider value={value}>
      <MemoryRouter initialEntries={["/secret"]}>
        <Routes>
          <Route path="/secret" element={<RequireRole allowedRoles={allowedRoles}>secret page</RequireRole>} />
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

  it("sends a signed-out visitor to sign-in", () => {
    renderAt({});
    expect(screen.getByText("sign in page")).toBeInTheDocument();
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
