import { describe, expect, it } from "vitest";
import { describeAccount, grantOperator, parseRoles } from "./operators.js";

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

const VERIFIED = { emailVerified: true, creationTime: "Mon, 05 Oct 2026 09:00:00 GMT", providers: ["password"] };

function fakes(existing: Record<string, string> = {}, unverified: Record<string, true> = {}) {
  const written: Record<string, unknown> = {};
  const createdEmails: string[] = [];
  const auth = {
    getUserByEmail: (email: string) => {
      const uid = existing[email];
      return uid !== undefined
        ? Promise.resolve({
            uid,
            emailVerified: unverified[email] !== true,
            metadata: { creationTime: "Mon, 05 Oct 2026 09:00:00 GMT" },
            providerData: [{ providerId: "password" }],
          })
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
      limit: () => ({ get: () => Promise.resolve({}) }),
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
    expect(r).toEqual({ uid: "uid-1", created: false, account: VERIFIED });
    expect(f.written).toEqual({ "starfish_users/uid-1": { roles: ["admin"] } });
    expect(f.createdEmails).toEqual([]);
  });

  it("hands back a password link for an existing account only when asked", async () => {
    const f = fakes({ "a@example.com": "uid-1" });
    const deps = { auth: f.auth as never, db: f.db as never, usersCollection: "starfish_users" };
    const asked = await grantOperator(deps, { email: "a@example.com", roles: ["admin"], createAccount: false, resetLink: true });
    expect(asked).toEqual({ uid: "uid-1", created: false, account: VERIFIED, passwordResetLink: "https://reset.example/a@example.com" });
    const plain = await grantOperator(deps, { email: "a@example.com", roles: ["admin"], createAccount: false });
    expect(plain.passwordResetLink).toBeUndefined();
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
    expect(r).toEqual({
      uid: "new-uid",
      created: true,
      account: { emailVerified: false, creationTime: null, providers: [] },
      passwordResetLink: "https://reset.example/new@example.com",
    });
    expect(f.written).toEqual({ "ops/new-uid": { roles: ["operator"] } });
  });

  // #139: with self sign-up on, a stranger can register the owner's address first; the grant must not go to them.
  it("refuses an existing account whose email is not verified, and says when it was made and how", async () => {
    const f = fakes({ "ops@example.com": "attacker-uid" }, { "ops@example.com": true });
    const deps = { auth: f.auth as never, db: f.db as never, usersCollection: "starfish_users" };
    for (const createAccount of [false, true]) {
      await expect(grantOperator(deps, { email: "ops@example.com", roles: ["admin"], createAccount })).rejects.toThrow(
        /not verified \(created Mon, 05 Oct 2026 09:00:00 GMT, providers password, email NOT verified\).*--trust-existing.*Nothing was written/
      );
    }
    expect(f.written).toEqual({});
    expect(f.createdEmails).toEqual([]);
  });

  it("grants to an unverified existing account only when the person running it vouches for it", async () => {
    const f = fakes({ "ops@example.com": "uid-9" }, { "ops@example.com": true });
    const r = await grantOperator(
      { auth: f.auth as never, db: f.db as never, usersCollection: "starfish_users" },
      { email: "ops@example.com", roles: ["admin"], createAccount: false, trustExisting: true }
    );
    expect(r.account.emailVerified).toBe(false);
    expect(f.written).toEqual({ "starfish_users/uid-9": { roles: ["admin"] } });
  });

  it("describes an account in one line", () => {
    expect(describeAccount(VERIFIED)).toBe("created Mon, 05 Oct 2026 09:00:00 GMT, providers password, email verified");
    expect(describeAccount({ emailVerified: false, creationTime: null, providers: [] })).toBe(
      "created (unknown), providers (none), email NOT verified"
    );
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

  it("creates no account when the operator store cannot be read (a wrong project, or nothing deployed there)", async () => {
    const f = fakes();
    const unreadable = {
      collection: () => ({ limit: () => ({ get: () => Promise.reject(Object.assign(new Error("5 NOT_FOUND: "), { code: 5 })) }) }),
    };
    await expect(
      grantOperator(
        { auth: f.auth as never, db: unreadable as never, usersCollection: "starfish_users" },
        { email: "new@example.com", roles: ["admin"], createAccount: true }
      )
    ).rejects.toThrow(/cannot read the operator store \(starfish_users\); no account was created: 5 NOT_FOUND/);
    expect(f.createdEmails).toEqual([]);
    expect(f.written).toEqual({});
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
