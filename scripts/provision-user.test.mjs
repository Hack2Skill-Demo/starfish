import { describe, it, expect, vi } from "vitest";
import { provisionUser } from "./provision-user.mjs";

function services() {
  const create = vi.fn().mockResolvedValue(undefined);
  const doc = vi.fn(() => ({ create }));
  return { auth: { createUser: vi.fn().mockResolvedValue({ uid: "new-user" }), deleteUser: vi.fn().mockResolvedValue(undefined) },
    db: { collection: vi.fn(() => ({ doc })) }, create };
}

describe("trusted account provisioning", () => {
  it("creates a viewer with an unprinted random password and only viewer privileges", async () => {
    const { auth, db, create } = services();
    expect(await provisionUser(auth, db, { email: " judge@example.test ", role: "viewer" })).toBe("new-user");
    expect(auth.createUser).toHaveBeenCalledWith({ email: "judge@example.test", password: expect.any(String) });
    expect(auth.createUser.mock.calls[0][0].password.length).toBeGreaterThan(32);
    expect(create).toHaveBeenCalledWith({ roles: ["viewer"] });
  });
  it("does not grant access when an email already exists", async () => {
    const { auth, db, create } = services();
    auth.createUser.mockRejectedValue(new Error("email already exists"));
    await expect(provisionUser(auth, db, { email: "existing@example.test", role: "admin" })).rejects.toThrow("email already exists");
    expect(create).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });
  it("removes only the newly created identity if the role write fails", async () => {
    const { auth, db, create } = services();
    create.mockRejectedValue(new Error("write failed"));
    await expect(provisionUser(auth, db, { email: "new@example.test", role: "operator" })).rejects.toThrow("write failed");
    expect(auth.deleteUser).toHaveBeenCalledWith("new-user");
  });
  it("reports failed cleanup so the admin can recover", async () => {
    const { auth, db, create } = services();
    create.mockRejectedValue(new Error("write failed"));
    auth.deleteUser.mockRejectedValue(new Error("offline"));
    await expect(provisionUser(auth, db, { email: "new@example.test", role: "viewer" })).rejects.toThrow("new-user");
  });
  it("rejects unknown roles before creating an identity", async () => {
    const { auth, db } = services();
    await expect(provisionUser(auth, db, { email: "x@example.test", role: "root" })).rejects.toThrow("Role must");
    expect(auth.createUser).not.toHaveBeenCalled();
  });
});
