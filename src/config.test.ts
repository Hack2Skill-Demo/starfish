import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

// Env vars that loadConfig reads; cleared first so the developer's own .env/shell can't leak in.
const KEYS = [
  "GOOGLE_CLOUD_PROJECT",
  "STARFISH_WATCHED_PROJECT_ID",
  "STARFISH_VERTEX_PROJECT_ID",
  "GOOGLE_CLOUD_LOCATION",
  "STARFISH_ENV",
];

describe("loadConfig: the projects", () => {
  beforeEach(() => {
    for (const k of KEYS) vi.stubEnv(k, "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("one project id is enough: logs and Gemini both default to the project Starfish runs in", () => {
    const c = loadConfig();
    expect(c.projectId).toBe("home-project");
    expect(c.watchedProjectId).toBe("home-project");
    expect(c.vertexProjectId).toBe("home-project");
  });

  it("the watched project and the Vertex project can each be set apart from the store's", () => {
    vi.stubEnv("STARFISH_WATCHED_PROJECT_ID", "customer-app");
    vi.stubEnv("STARFISH_VERTEX_PROJECT_ID", "billing-ai");
    const c = loadConfig();
    expect(c).toMatchObject({ projectId: "home-project", watchedProjectId: "customer-app", vertexProjectId: "billing-ai" });
  });

  it("each can be set without the other", () => {
    vi.stubEnv("STARFISH_VERTEX_PROJECT_ID", "billing-ai");
    expect(loadConfig()).toMatchObject({ watchedProjectId: "home-project", vertexProjectId: "billing-ai" });
  });

  it("an empty value means unset, not an empty project id", () => {
    vi.stubEnv("STARFISH_WATCHED_PROJECT_ID", "");
    vi.stubEnv("STARFISH_VERTEX_PROJECT_ID", "");
    expect(loadConfig()).toMatchObject({ watchedProjectId: "home-project", vertexProjectId: "home-project" });
  });

  it("refuses to start without a project, with a message that says what to do", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    expect(() => loadConfig()).toThrow("GOOGLE_CLOUD_PROJECT is not set");
  });
});

describe("loadConfig: ingest windows", () => {
  const WINDOW_KEYS = ["STARFISH_INGEST_LAG_MINUTES", "STARFISH_INGEST_MAX_WINDOW_HOURS", "STARFISH_RUN_COLLECTION"];
  beforeEach(() => {
    for (const k of WINDOW_KEYS) vi.stubEnv(k, "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("has defaults: a 5-minute lag, 6-hour windows, starfish_runs", () => {
    expect(loadConfig()).toMatchObject({ ingestLagMinutes: 5, ingestMaxWindowHours: 6, runCollection: "starfish_runs" });
  });

  it("reads each from the environment", () => {
    vi.stubEnv("STARFISH_INGEST_LAG_MINUTES", "10");
    vi.stubEnv("STARFISH_INGEST_MAX_WINDOW_HOURS", "1.5");
    vi.stubEnv("STARFISH_RUN_COLLECTION", "my_runs");
    expect(loadConfig()).toMatchObject({ ingestLagMinutes: 10, ingestMaxWindowHours: 1.5, runCollection: "my_runs" });
  });

  it.each(["0", "-3", "abc", "NaN", "Infinity"])("refuses %s, which would stall or break the window", (bad) => {
    vi.stubEnv("STARFISH_INGEST_MAX_WINDOW_HOURS", bad);
    expect(() => loadConfig()).toThrow("STARFISH_INGEST_MAX_WINDOW_HOURS");
  });
});

describe("loadConfig: the verify gate", () => {
  const KEYS = ["STARFISH_VERIFY_COMMAND", "STARFISH_VERIFY_TIMEOUT_SECONDS", "STARFISH_PATCH_EXCLUDED_PATHS"];
  beforeEach(() => {
    for (const k of KEYS) vi.stubEnv(k, "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("has no command by default: with none configured no patch is ever accepted", () => {
    expect(loadConfig()).toMatchObject({ verifyCommand: "", verifyTimeoutSeconds: 600 });
  });

  it("reads the command (trimmed) and the timeout", () => {
    vi.stubEnv("STARFISH_VERIFY_COMMAND", "  pnpm run verify  ");
    vi.stubEnv("STARFISH_VERIFY_TIMEOUT_SECONDS", "90");
    expect(loadConfig()).toMatchObject({ verifyCommand: "pnpm run verify", verifyTimeoutSeconds: 90 });
  });

  it.each(["0", "-1", "soon"])("refuses a timeout of %s", (bad) => {
    vi.stubEnv("STARFISH_VERIFY_TIMEOUT_SECONDS", bad);
    expect(() => loadConfig()).toThrow("STARFISH_VERIFY_TIMEOUT_SECONDS");
  });

  it("adds the deployment's excluded paths to the built-in ones, never replacing them", () => {
    vi.stubEnv("STARFISH_PATCH_EXCLUDED_PATHS", "package.json, jest.config.js ,");
    const { patchExcludedPaths } = loadConfig();
    expect(patchExcludedPaths).toEqual(expect.arrayContaining([".github/", ".env", "*.pem", "package.json", "jest.config.js"]));
    expect(patchExcludedPaths).not.toContain("");
  });

  it("keeps the built-in excluded paths when none are added", () => {
    expect(loadConfig().patchExcludedPaths).toEqual(expect.arrayContaining([".git/", ".github/", ".claude/", ".env"]));
  });
});

describe("loadConfig: agent cycles", () => {
  const KEYS = ["STARFISH_CYCLE_COLLECTION", "STARFISH_LEASE_SECONDS", "STARFISH_CYCLE_DEADLINE_MINUTES", "STARFISH_MAX_CYCLE_ATTEMPTS"];
  beforeEach(() => {
    for (const k of KEYS) vi.stubEnv(k, "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("defaults: starfish_cycles, a 5-minute lease, a 60-minute deadline, 3 starts", () => {
    expect(loadConfig()).toMatchObject({ cycleCollection: "starfish_cycles", leaseSeconds: 300, cycleDeadlineMinutes: 60, maxCycleAttempts: 3 });
  });

  it("reads each from the environment", () => {
    vi.stubEnv("STARFISH_CYCLE_COLLECTION", "my_cycles");
    vi.stubEnv("STARFISH_LEASE_SECONDS", "45");
    vi.stubEnv("STARFISH_CYCLE_DEADLINE_MINUTES", "15");
    vi.stubEnv("STARFISH_MAX_CYCLE_ATTEMPTS", "5");
    expect(loadConfig()).toMatchObject({ cycleCollection: "my_cycles", leaseSeconds: 45, cycleDeadlineMinutes: 15, maxCycleAttempts: 5 });
  });

  it.each([
    ["STARFISH_LEASE_SECONDS", "0"],
    ["STARFISH_CYCLE_DEADLINE_MINUTES", "-1"],
    ["STARFISH_MAX_CYCLE_ATTEMPTS", "many"],
  ])("refuses %s=%s, which would stall or loop the cycle", (name, bad) => {
    vi.stubEnv(name, bad);
    expect(() => loadConfig()).toThrow(name);
  });
});

describe("loadConfig: the loop's switches", () => {
  const KEYS = ["STARFISH_DRY_RUN", "STARFISH_REVIEW_REQUIRED", "STARFISH_MODEL_CALL_BUDGET"];
  beforeEach(() => {
    for (const k of KEYS) vi.stubEnv(k, "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to a dry run with review required and a budget of six model calls", () => {
    expect(loadConfig()).toMatchObject({ dryRun: true, reviewRequired: true, modelCallBudget: 6 });
  });

  it.each([["false", false], ["0", false], ["No", false], ["true", true], ["1", true], [" YES ", true]])(
    "reads STARFISH_DRY_RUN=%s as %s",
    (raw, expected) => {
      vi.stubEnv("STARFISH_DRY_RUN", raw);
      expect(loadConfig().dryRun).toBe(expected);
    }
  );

  it.each(["maybe", "off", "2"])("refuses STARFISH_DRY_RUN=%s rather than guessing which way it was meant", (bad) => {
    vi.stubEnv("STARFISH_DRY_RUN", bad);
    expect(() => loadConfig()).toThrow("STARFISH_DRY_RUN");
  });

  it("reads the review switch and the budget, and refuses a budget that would stop every cycle", () => {
    vi.stubEnv("STARFISH_REVIEW_REQUIRED", "false");
    vi.stubEnv("STARFISH_MODEL_CALL_BUDGET", "10");
    expect(loadConfig()).toMatchObject({ reviewRequired: false, modelCallBudget: 10 });
    vi.stubEnv("STARFISH_MODEL_CALL_BUDGET", "0");
    expect(() => loadConfig()).toThrow("STARFISH_MODEL_CALL_BUDGET");
  });
});

describe("loadConfig: admin actions", () => {
  beforeEach(() => {
    vi.stubEnv("STARFISH_USERS_COLLECTION", "");
    vi.stubEnv("STARFISH_AUDIT_COLLECTION", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to starfish_users and starfish_audit", () => {
    expect(loadConfig()).toMatchObject({ usersCollection: "starfish_users", auditCollection: "starfish_audit" });
  });

  it("reads both from the environment", () => {
    vi.stubEnv("STARFISH_USERS_COLLECTION", "ops_people");
    vi.stubEnv("STARFISH_AUDIT_COLLECTION", "ops_audit");
    expect(loadConfig()).toMatchObject({ usersCollection: "ops_people", auditCollection: "ops_audit" });
  });
});

