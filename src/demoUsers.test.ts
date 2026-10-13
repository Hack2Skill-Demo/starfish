import { describe, expect, it } from "vitest";
import { applyDemoUsers, checkDemoEmails, generatePassword, removeDemoUsers } from "./demoUsers.js";

function fakes(existing: Record<string, string> = {}) {
  const accounts = new Map(Object.entries(existing));
  const calls: string[] = [];
  const docs: Record<string, unknown> = {};
  const auth = {
    getUserByEmail: (email: string) => {
      const uid = accounts.get(email);
      return uid !== undefined
        ? Promise.resolve({ uid })
        : Promise.reject(Object.assign(new Error("nope"), { code: "auth/user-not-found" }));
    },
    createUser: (p: { email?: string; password?: string; emailVerified?: boolean }) => {
      calls.push(`create ${p.email} verified=${p.emailVerified} pw=${p.password?.length}`);
      accounts.set(p.email ?? "", `uid-${accounts.size + 1}`);
      return Promise.resolve({ uid: accounts.get(p.email ?? "") as string });
    },
    updateUser: (uid: string, p: { password?: string }) => {
      calls.push(`update ${uid} pw=${p.password?.length}`);
      return Promise.resolve({ uid });
    },
    revokeRefreshTokens: (uid: string) => {
      calls.push(`revoke ${uid}`);
      return Promise.resolve();
    },
    deleteUser: (uid: string) => {
      calls.push(`delete ${uid}`);
      return Promise.resolve();
    },
  };
  const db = {
    collection: (name: string) => ({
      limit: () => ({ get: () => Promise.resolve({}) }),
      doc: (id: string) => ({
        set: (d: unknown) => {
          docs[`${name}/${id}`] = d;
          return Promise.resolve();
        },
        delete: () => {
          calls.push(`delete-doc ${name}/${id}`);
          return Promise.resolve();
        },
      }),
    }),
  };
  return { auth: auth as never, db: db as never, calls, docs };
}

describe("generatePassword", () => {
  it("is 16 unambiguous characters and differs each time", () => {
    const a = generatePassword();
    expect(a).toMatch(/^[a-hj-km-np-zA-HJ-NP-Z2-9]{16}$/);
    expect(generatePassword()).not.toBe(a);
  });
});

describe("checkDemoEmails", () => {
  it("lowercases, dedupes and refuses a bad address or an empty list", () => {
    expect(checkDemoEmails(["A@x.example", "a@x.example"])).toEqual(["a@x.example"]);
    expect(() => checkDemoEmails(["nope"])).toThrow(/not an email/);
    expect(() => checkDemoEmails([])).toThrow(/no demo user/);
  });
});

describe("applyDemoUsers", () => {
  it("creates verified accounts with a password and the operator role only", async () => {
    const f = fakes();
    const r = await applyDemoUsers({ auth: f.auth, db: f.db, usersCollection: "starfish_users" }, ["j1@x.example", "j2@x.example"]);
    expect(r.map((x) => x.status)).toEqual(["created", "created"]);
    expect(r[0]?.password).toHaveLength(16);
    expect(r[0]?.password).not.toBe(r[1]?.password);
    expect(f.docs[`starfish_users/${r[0]?.uid}`]).toEqual({ roles: ["operator"] });
    expect(f.calls[0]).toBe("create j1@x.example verified=true pw=16");
  });

  it("leaves an existing account alone without --reset-passwords", async () => {
    const f = fakes({ "j1@x.example": "uid-9" });
    const r = await applyDemoUsers({ auth: f.auth, db: f.db, usersCollection: "u" }, ["j1@x.example"]);
    expect(r).toEqual([{ email: "j1@x.example", uid: "uid-9", status: "left-alone" }]);
    expect(f.calls).toEqual([]);
    expect(f.docs).toEqual({});
  });

  it("with --reset-passwords replaces the password, signs the account out and re-sets the role", async () => {
    const f = fakes({ "j1@x.example": "uid-9" });
    const r = await applyDemoUsers({ auth: f.auth, db: f.db, usersCollection: "u" }, ["j1@x.example"], { resetPasswords: true });
    expect(r[0]?.status).toBe("password-reset");
    expect(f.calls).toEqual(["update uid-9 pw=16", "revoke uid-9"]);
    expect(f.docs["u/uid-9"]).toEqual({ roles: ["operator"] });
  });

  it("creates nothing when the operator store cannot be read", async () => {
    const f = fakes();
    const db = { collection: () => ({ limit: () => ({ get: () => Promise.reject(new Error("NOT_FOUND")) }) }) };
    await expect(applyDemoUsers({ auth: f.auth, db: db as never, usersCollection: "u" }, ["j1@x.example"])).rejects.toThrow(/no account was created/);
    expect(f.calls).toEqual([]);
  });
});

describe("removeDemoUsers", () => {
  it("deletes the record then the account, and skips an email with no account", async () => {
    const f = fakes({ "j1@x.example": "uid-9" });
    const n = await removeDemoUsers({ auth: f.auth, db: f.db, usersCollection: "u" }, ["j1@x.example", "gone@x.example"]);
    expect(n).toBe(1);
    expect(f.calls).toEqual(["delete-doc u/uid-9", "delete uid-9"]);
  });
});
