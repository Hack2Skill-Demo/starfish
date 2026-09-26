import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ signIn: vi.fn(), reset: vi.fn(), auth: {} }));
vi.mock("firebase/auth", () => ({ signInWithEmailAndPassword: mocks.signIn, sendPasswordResetEmail: mocks.reset }));
vi.mock("../lib/firebase", () => ({ firebaseAuth: () => mocks.auth }));
import { SignIn } from "./SignIn";
function show() {
  render(<MemoryRouter><Routes><Route path="/" element={<SignIn />} /><Route path="/incidents" element={<>Incident destination</>} /></Routes></MemoryRouter>);
}
async function reset() {
  await userEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
  await userEvent.type(screen.getByLabelText("Email"), "judge@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
}
describe("sign-in and recovery", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.signIn.mockResolvedValue({}); mocks.reset.mockResolvedValue(undefined); });
  it("signs in with email/password and navigates to incidents", async () => {
    show();
    await userEvent.type(screen.getByLabelText("Email"), "operator@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "example-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign In" }));
    expect(await screen.findByText("Incident destination")).toBeInTheDocument();
    expect(mocks.signIn).toHaveBeenCalledWith(mocks.auth, "operator@example.test", "example-password");
  });
  it.each([undefined, "auth/user-not-found", "auth/user-disabled"])("does not disclose account existence on reset (%s)", async (code) => {
    if (code) mocks.reset.mockRejectedValue({ code });
    show(); await reset();
    expect(await screen.findByRole("status")).toHaveTextContent("If an account exists");
    expect(mocks.reset).toHaveBeenCalledWith(mocks.auth, "judge@example.test");
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
  it("reports delivery failures without claiming an email was sent", async () => {
    mocks.reset.mockRejectedValue({ code: "auth/network-request-failed" });
    show(); await reset();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not send");
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("requires an email and allows returning to login", async () => {
    show(); await userEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Email is required");
    expect(mocks.reset).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    await waitFor(() => expect(screen.getByLabelText("Password")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
