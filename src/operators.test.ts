import { describe, expect, it } from "vitest";
import { grantOperator, parseRoles } from "./operators.js";

describe("parseRoles", () => {
  it("reads one or more roles, once each", () => {
    expect(parseRoles("admin")).toEqual(["admin"]);
    expect(parseRoles(" admin , operator,admin ")).toEqual(["admin", "operator"]);
  });

  it("refuses an unknown or empty role instead of granting nothing quietly", () => {
    expect(() => parseRoles("owner")).toThrow(/unknown role "owner"/);
    expect(() => parseRoles("admin,viewer")).toThrow(/unknown role "viewer"/);
    expect(() => parseRoles("")).toThrow(/no role/);
    expect(() => parseRoles(" , ")).toThrow(/no role/);
  });
});

function fakes(existing: Record<string, string> = {}) {
  const written: Record<string, unknown> = {};
  const createdEmails: string[] = [];
  const auth = {
    getUserByEmail: (email: string) => {
      const uid = existing[email];
      return uid !== undefined
        ? Promise.resolve({ uid })
        : Promise.reject(Object.assign(new Error("nope"), { code: "auth/user-not-found" }));
    },
    createUser: (props: { email?: string }) => {
      createdEmails.push(props.email ?? "");
      return Promise.resolve({ uid: "new-uid" });
    },
    generatePasswordResetLink: (email: string) => Promise.resolve(`https://reset.example/${email}`),
  };
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        set: (data: unknown) => {
          written[`${name}/${id}`] = data;
          return Promise.resolve();
        },
      }),
    }),
  };
  return { auth, db, written, createdEmails };
}

describe("grantOperator", () => {
  it("writes the roles on an existing account's operator record", async () => {
    const f = fakes({ "a@example.com": "uid-1" });
    const r = await grantOperator(
      { auth: f.auth as never, db: f.db as never, usersCollection: "starfish_users" },
      { email: "a@example.com", roles: ["admin"], createAccount: false }
    );
    expect(r).toEqual({ uid: "uid-1", created: false });
    expect(f.written).toEqual({ "starfish_users/uid-1": { roles: ["admin"] } });
    expect(f.createdEmails).toEqual([]);
  });

  it("does not create an account unless asked", async () => {
    const f = fakes();
    await expect(
      grantOperator(
        { auth: f.auth as never, db: f.db as never, usersCollection: "starfish_users" },
        { email: "new@example.com", roles: ["operator"], createAccount: false }
      )
    ).rejects.toThrow(/--create/);
    expect(f.written).toEqual({});
  });

  it("creates a missing account with no password and hands back a reset link", async () => {
    const f = fakes();
    const r = await grantOperator(
      { auth: f.auth as never, db: f.db as never, usersCollection: "ops" },
      { email: "new@example.com", roles: ["operator"], createAccount: true }
    );
    expect(r).toEqual({ uid: "new-uid", created: true, passwordResetLink: "https://reset.example/new@example.com" });
    expect(f.written).toEqual({ "ops/new-uid": { roles: ["operator"] } });
  });

  it("does not hide an Auth failure that is not 'no such user'", async () => {
    const f = fakes();
    f.auth.getUserByEmail = () => Promise.reject(Object.assign(new Error("quota"), { code: "auth/quota-exceeded" }));
    await expect(
      grantOperator(
        { auth: f.auth as never, db: f.db as never, usersCollection: "starfish_users" },
        { email: "a@example.com", roles: ["admin"], createAccount: true }
      )
    ).rejects.toThrow("quota");
    expect(f.createdEmails).toEqual([]);
  });

  it("refuses something that is not an email, before touching Auth", async () => {
    const f = fakes();
    await expect(
      grantOperator(
        { auth: f.auth as never, db: f.db as never, usersCollection: "starfish_users" },
        { email: "not-an-email", roles: ["admin"], createAccount: true }
      )
    ).rejects.toThrow(/email/);
  });
});
