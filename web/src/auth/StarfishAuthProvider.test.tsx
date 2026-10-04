/**
 * Each case pins a race or failure mode that would strand or sign out a valid
 * operator; the roles source is injected instead of hitting Firestore.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StarfishRole } from "./authCore";

const mocks = vi.hoisted(() => ({
  tokenListener: null as null | ((user: unknown) => Promise<void>),
  unsubscribe: vi.fn(),
  authSignOut: vi.fn(),
  getIdToken: vi.fn(),
  queryClear: vi.fn(),
  resolveRoles: vi.fn(),
  signInAnonymously: vi.fn(),
  auth: { currentUser: null as null | { getIdToken: typeof vi.fn }, signOut: vi.fn() },
}));
mocks.auth.signOut = mocks.authSignOut;

vi.mock("firebase/auth", () => ({
  onIdTokenChanged: (_auth: unknown, callback: (user: unknown) => Promise<void>) => {
    mocks.tokenListener = callback;
    return mocks.unsubscribe;
  },
  signInAnonymously: (...args: unknown[]) => mocks.signInAnonymously(...args),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ clear: mocks.queryClear }) }));
vi.mock("../lib/firebase", () => ({ firebaseAuth: () => mocks.auth }));
vi.mock("./session", () => ({ readRoles: vi.fn() }));

import { StarfishAuthProvider, isNetworkError } from "./StarfishAuthProvider";
import { useAuth } from "./authCore";

function Consumer() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="state">
        {JSON.stringify({
          loading: auth.loading,
          roles: auth.roles,
          role: auth.role,
          uid: auth.user?.uid,
          guest: auth.guest,
        })}
      </span>
      <span data-testid="guest-result" />
      <button onClick={() => void auth.signOut()}>Sign out</button>
      <button
        onClick={() =>
          void auth.enterAsGuest().then((ok) => {
            document.querySelector('[data-testid="guest-result"]')!.textContent = String(ok);
          })
        }
      >
        Enter as guest
      </button>
    </div>
  );
}

const resolveRoles = (uid: string) => mocks.resolveRoles(uid) as Promise<StarfishRole[]>;

function renderProvider() {
  return render(
    <StarfishAuthProvider resolveRoles={resolveRoles}>
      <Consumer />
    </StarfishAuthProvider>
  );
}

const state = () => screen.getByTestId("state");

describe("StarfishAuthProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tokenListener = null;
    mocks.auth.currentUser = null;
    mocks.authSignOut.mockResolvedValue(undefined);
    mocks.resolveRoles.mockResolvedValue(["admin"]);
    mocks.signInAnonymously.mockResolvedValue({ user: { uid: "guest-1", isAnonymous: true } });
  });

  it("settles signed-out users without reading roles", async () => {
    renderProvider();
    await act(() => mocks.tokenListener!(null));
    expect(state()).toHaveTextContent('"loading":false');
    expect(state()).toHaveTextContent('"roles":[]');
    expect(mocks.resolveRoles).not.toHaveBeenCalled();
  });

  it("resolves roles from the operator record and derives the primary role", async () => {
    renderProvider();
    await act(() => mocks.tokenListener!({ uid: "op-1" }));
    expect(state()).toHaveTextContent('"roles":["admin"]');
    expect(state()).toHaveTextContent('"role":"admin"');
    expect(mocks.resolveRoles).toHaveBeenCalledWith("op-1");
  });

  it("re-validates the same user without re-entering the loading gate", async () => {
    renderProvider();
    await act(() => mocks.tokenListener!({ uid: "op-1" }));

    let finish: (() => void) | undefined;
    mocks.resolveRoles.mockImplementationOnce(() => new Promise((res) => (finish = () => res(["operator"]))));
    await act(async () => {
      void mocks.tokenListener!({ uid: "op-1" });
    });
    // In flight: the page must stay mounted, so loading stays false.
    expect(state()).toHaveTextContent('"loading":false');

    await act(async () => {
      finish?.();
      await Promise.resolve();
    });
    expect(state()).toHaveTextContent('"roles":["operator"]');
  });

  it("re-raises the loading gate for a new identity", async () => {
    renderProvider();
    await act(() => mocks.tokenListener!({ uid: "op-1" }));
    await act(() => mocks.tokenListener!(null));

    let finish: (() => void) | undefined;
    mocks.resolveRoles.mockImplementationOnce(() => new Promise((res) => (finish = () => res(["admin"]))));
    await act(async () => {
      void mocks.tokenListener!({ uid: "op-2" });
    });
    expect(state()).toHaveTextContent('"loading":true');

    await act(async () => {
      finish?.();
      await Promise.resolve();
    });
    expect(state()).toHaveTextContent('"loading":false');
    expect(state()).toHaveTextContent('"roles":["admin"]');
  });

  it("drops a stale resolution that lands after a newer one", async () => {
    // The race that strands a valid operator on Access Denied: an older,
    // slower read completing after a newer good one must not overwrite it.
    renderProvider();
    let finishOld: (() => void) | undefined;
    mocks.resolveRoles
      .mockImplementationOnce(() => new Promise((res) => (finishOld = () => res([]))))
      .mockResolvedValueOnce(["admin"]);

    await act(async () => {
      void mocks.tokenListener!({ uid: "op-1" });
      await mocks.tokenListener!({ uid: "op-1" });
    });
    expect(state()).toHaveTextContent('"roles":["admin"]');

    await act(async () => {
      finishOld?.();
      await Promise.resolve();
    });
    expect(state()).toHaveTextContent('"roles":["admin"]');
    expect(state()).toHaveTextContent('"loading":false');
  });

  it("signs out and clears cached data after a definitive failure", async () => {
    mocks.resolveRoles.mockRejectedValueOnce({ code: "permission-denied" });
    renderProvider();
    await act(() => mocks.tokenListener!({ uid: "op-1" }));
    expect(mocks.queryClear).toHaveBeenCalled();
    expect(mocks.authSignOut).toHaveBeenCalled();
    expect(state()).toHaveTextContent('"loading":true');
  });

  it.each([
    { code: "unavailable" },
    { code: "deadline-exceeded" },
    { code: "auth/network-request-failed" },
    { message: "Failed to fetch" },
    { message: "Load failed" },
  ])("keeps the session through a transient failure %#", async (failure) => {
    mocks.resolveRoles.mockRejectedValueOnce(failure);
    renderProvider();
    await act(() => mocks.tokenListener!({ uid: "op-1" }));
    expect(mocks.authSignOut).not.toHaveBeenCalled();
    expect(mocks.queryClear).not.toHaveBeenCalled();
    expect(state()).toHaveTextContent('"loading":true');
  });

  it("clears cached data on sign-out", async () => {
    renderProvider();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mocks.authSignOut).toHaveBeenCalled());
    expect(mocks.queryClear).toHaveBeenCalled();
  });

  it("signs out when a focus-time token refresh proves the token invalid", async () => {
    mocks.getIdToken.mockRejectedValueOnce({ code: "auth/user-token-expired" });
    mocks.auth.currentUser = { getIdToken: mocks.getIdToken };
    renderProvider();
    await waitFor(() => expect(mocks.authSignOut).toHaveBeenCalled());
  });

  it("treats permission-denied as definitive, not network", () => {
    expect(isNetworkError({ code: "permission-denied" })).toBe(false);
  });

  describe("guests (anonymous sessions, issue #12)", () => {
    const guestResult = () => screen.getByTestId("guest-result");

    it("treats an anonymous session as a guest: no roles, and no operator-record read", async () => {
      renderProvider();
      await act(() => mocks.tokenListener!({ uid: "guest-1", isAnonymous: true }));
      expect(state()).toHaveTextContent('"guest":true');
      expect(state()).toHaveTextContent('"roles":[]');
      expect(state()).toHaveTextContent('"loading":false');
      expect(mocks.resolveRoles).not.toHaveBeenCalled();
    });

    it("a signed-in operator is not a guest", async () => {
      renderProvider();
      await act(() => mocks.tokenListener!({ uid: "op-1", isAnonymous: false }));
      expect(state()).toHaveTextContent('"guest":false');
      expect(state()).toHaveTextContent('"roles":["admin"]');
    });

    it("starts a guest session on request, once however often it is asked", async () => {
      renderProvider();
      await act(() => mocks.tokenListener!(null));
      const user = userEvent.setup();
      await user.click(screen.getByText("Enter as guest"));
      await user.click(screen.getByText("Enter as guest"));
      await waitFor(() => expect(guestResult()).toHaveTextContent("true"));
      expect(mocks.signInAnonymously).toHaveBeenCalledTimes(1);
      expect(mocks.signInAnonymously).toHaveBeenCalledWith(mocks.auth);
    });

    it("reports false, without throwing, when Anonymous sign-in is off for the project", async () => {
      mocks.signInAnonymously.mockRejectedValue(Object.assign(new Error("off"), { code: "auth/admin-restricted-operation" }));
      renderProvider();
      await act(() => mocks.tokenListener!(null));
      await userEvent.setup().click(screen.getByText("Enter as guest"));
      await waitFor(() => expect(guestResult()).toHaveTextContent("false"));
    });

    it("makes no guest session after a deliberate sign-out: that visitor is heading to the sign-in page", async () => {
      renderProvider();
      await act(() => mocks.tokenListener!({ uid: "op-1", isAnonymous: false }));
      const user = userEvent.setup();
      await user.click(screen.getByText("Sign out"));
      await act(() => mocks.tokenListener!(null));
      await user.click(screen.getByText("Enter as guest"));
      await waitFor(() => expect(guestResult()).toHaveTextContent("false"));
      expect(mocks.signInAnonymously).not.toHaveBeenCalled();
    });

    it("clears cached data when a guest signs in as a team member, but not on a first sign-in", async () => {
      renderProvider();
      await act(() => mocks.tokenListener!({ uid: "first-visit", isAnonymous: false }));
      expect(mocks.queryClear).not.toHaveBeenCalled();

      mocks.queryClear.mockClear();
      await act(() => mocks.tokenListener!({ uid: "guest-1", isAnonymous: true }));
      expect(mocks.queryClear).toHaveBeenCalledTimes(1); // first-visit -> guest-1 is a different identity
      await act(() => mocks.tokenListener!({ uid: "op-1", isAnonymous: false }));
      expect(mocks.queryClear).toHaveBeenCalledTimes(2); // guest -> team member
      await act(() => mocks.tokenListener!({ uid: "op-1", isAnonymous: false }));
      expect(mocks.queryClear).toHaveBeenCalledTimes(2); // a token refresh for the same user clears nothing
    });
  });
});

