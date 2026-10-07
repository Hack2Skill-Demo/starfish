import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadChildProcessBasics, loadConfig, loadGithubToken, loadReplayConfig, loadSlackAlertsWebhook, loadSlackOnCallWebhook, loadTwilioCredentials, loadVerifyCommandBasics, loadVerifyRunnerRequest, usingFirestoreEmulator } from "./config.js";

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

  it("a blank region, model, environment or collection name means unset, not an empty string (#189)", () => {
    for (const k of [
      "GOOGLE_CLOUD_LOCATION",
      "STARFISH_MODEL",
      "STARFISH_ENV",
      "STARFISH_SETTINGS_COLLECTION",
      "STARFISH_INCIDENT_COLLECTION",
      "STARFISH_INCIDENT_KEY_COLLECTION",
      "STARFISH_VERIFY_JOB_REGION",
    ]) {
      vi.stubEnv(k, "  ");
    }
    expect(loadConfig()).toMatchObject({
      location: "us-central1",
      model: "gemini-3.1-pro-preview",
      environment: "dev",
      settingsCollection: "starfish_settings",
      incidentCollection: "incidents",
      incidentKeyCollection: "incident_keys",
      verifyJobRegion: "us-central1",
    });
    vi.stubEnv("STARFISH_ENV", " demo ");
    expect(loadConfig().environment).toBe("demo");
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

  it("reads the lookback, 24 hours by default", () => {
    vi.stubEnv("STARFISH_LOOKBACK_HOURS", "");
    expect(loadConfig().defaultLookbackHours).toBe(24);
    vi.stubEnv("STARFISH_LOOKBACK_HOURS", "48");
    expect(loadConfig().defaultLookbackHours).toBe(48);
  });

  it.each(["0", "-1", "24h", "abc", "Infinity"])("refuses a lookback of %s, which would leave every run idle (#129)", (bad) => {
    vi.stubEnv("STARFISH_LOOKBACK_HOURS", bad);
    expect(() => loadConfig()).toThrow("STARFISH_LOOKBACK_HOURS");
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
    expect(loadConfig()).toMatchObject({ cycleCollection: "starfish_cycles", leaseSeconds: 300, cycleDeadlineMinutes: 360, maxCycleAttempts: 3 });
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
  const KEYS = ["STARFISH_DRY_RUN", "STARFISH_REVIEW_REQUIRED", "STARFISH_MODEL_CALL_BUDGET", "STARFISH_AUTOMATION_ENABLED"];
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

  it("leaves automation on by default, reads the kill switch, and refuses a value it cannot read", () => {
    expect(loadConfig().automationEnabled).toBe(true);
    vi.stubEnv("STARFISH_AUTOMATION_ENABLED", "false");
    expect(loadConfig().automationEnabled).toBe(false);
    vi.stubEnv("STARFISH_AUTOMATION_ENABLED", "maybe");
    expect(() => loadConfig()).toThrow("STARFISH_AUTOMATION_ENABLED");
  });

  it("reads the review switch and the budget, and refuses a budget that would stop every cycle", () => {
    vi.stubEnv("STARFISH_REVIEW_REQUIRED", "false");
    vi.stubEnv("STARFISH_MODEL_CALL_BUDGET", "10");
    expect(loadConfig()).toMatchObject({ reviewRequired: false, modelCallBudget: 10 });
    vi.stubEnv("STARFISH_MODEL_CALL_BUDGET", "0");
    expect(() => loadConfig()).toThrow("STARFISH_MODEL_CALL_BUDGET");
  });
});

describe("loadConfig: the pull-request target", () => {
  const KEYS = [
    "STARFISH_GITHUB_REPO",
    "STARFISH_GITHUB_BASE_BRANCH",
    "STARFISH_GITHUB_API_URL",
    "STARFISH_GITHUB_REMOTE_URL",
    "STARFISH_GITHUB_COMMIT_NAME",
    "STARFISH_GITHUB_COMMIT_EMAIL",
    "STARFISH_GITHUB_TOKEN",
  ];
  beforeEach(() => {
    for (const k of KEYS) vi.stubEnv(k, "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("names no repository by default, so nothing can be opened, and targets main on GitHub", () => {
    expect(loadConfig()).toMatchObject({
      githubRepo: "",
      githubBaseBranch: "main",
      githubApiUrl: "https://api.github.com",
      githubRemoteUrl: "",
      githubCommitName: "Starfish",
      githubCommitEmail: "starfish@users.noreply.github.com",
    });
  });

  it("reads each setting from its variable", () => {
    vi.stubEnv("STARFISH_GITHUB_REPO", " acme/shop ");
    vi.stubEnv("STARFISH_GITHUB_BASE_BRANCH", "develop");
    vi.stubEnv("STARFISH_GITHUB_API_URL", "https://ghe.example/api/v3");
    vi.stubEnv("STARFISH_GITHUB_REMOTE_URL", "https://ghe.example/acme/shop.git");
    vi.stubEnv("STARFISH_GITHUB_COMMIT_NAME", "Bot");
    vi.stubEnv("STARFISH_GITHUB_COMMIT_EMAIL", "bot@example.test");
    expect(loadConfig()).toMatchObject({
      githubRepo: "acme/shop",
      githubBaseBranch: "develop",
      githubApiUrl: "https://ghe.example/api/v3",
      githubRemoteUrl: "https://ghe.example/acme/shop.git",
      githubCommitName: "Bot",
      githubCommitEmail: "bot@example.test",
    });
  });

  it("keeps the token out of the config object: it is read on its own, and only when asked", () => {
    vi.stubEnv("STARFISH_GITHUB_TOKEN", " sekret ");
    expect(JSON.stringify(loadConfig())).not.toContain("sekret");
    expect(loadGithubToken()).toBe("sekret");
    vi.stubEnv("STARFISH_GITHUB_TOKEN", "  ");
    expect(loadGithubToken()).toBeUndefined();
  });

  it("hands a child process only PATH and HOME", () => {
    vi.stubEnv("PATH", "/bin");
    vi.stubEnv("HOME", "/home/x");
    vi.stubEnv("STARFISH_GITHUB_TOKEN", "sekret");
    expect(loadChildProcessBasics()).toEqual({ PATH: "/bin", HOME: "/home/x" });
  });

  it("hands the verify command only PATH and LANG, with a default locale", () => {
    vi.stubEnv("PATH", "/bin");
    vi.stubEnv("LANG", "de_DE.UTF-8");
    vi.stubEnv("STARFISH_GITHUB_TOKEN", "sekret");
    expect(loadVerifyCommandBasics()).toEqual({ PATH: "/bin", LANG: "de_DE.UTF-8" });
    vi.stubEnv("LANG", undefined);
    expect(loadVerifyCommandBasics().LANG).toBe("C.UTF-8");
  });

  it("knows when the Firestore emulator is in use", () => {
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "localhost:8080");
    expect(usingFirestoreEmulator()).toBe(true);
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
    expect(usingFirestoreEmulator()).toBe(false);
  });
});

describe("loadConfig: the agent entrypoint's guards", () => {
  beforeEach(() => {
    vi.stubEnv("STARFISH_VERIFY_ISOLATION", "");
    vi.stubEnv("STARFISH_MAX_CYCLES_PER_PASS", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to no verify isolation, which keeps the agent from starting, and three cycles a pass", () => {
    expect(loadConfig()).toMatchObject({ verifyIsolation: "none", maxCyclesPerPass: 3 });
  });
  it("reads in-process, refuses any other value, and refuses a cap of zero", () => {
    vi.stubEnv("STARFISH_VERIFY_ISOLATION", " In-Process ");
    expect(loadConfig().verifyIsolation).toBe("in-process");
    vi.stubEnv("STARFISH_VERIFY_ISOLATION", "sandbox");
    expect(() => loadConfig()).toThrow("STARFISH_VERIFY_ISOLATION");
    vi.stubEnv("STARFISH_VERIFY_ISOLATION", "");
    vi.stubEnv("STARFISH_MAX_CYCLES_PER_PASS", "0");
    expect(() => loadConfig()).toThrow("STARFISH_MAX_CYCLES_PER_PASS");
  });
  it("reads ten pull requests a pass by default, and refuses a cap of zero", () => {
    vi.stubEnv("STARFISH_MAX_PR_CHECKS_PER_PASS", "");
    expect(loadConfig().maxPrChecksPerPass).toBe(10);
    vi.stubEnv("STARFISH_MAX_PR_CHECKS_PER_PASS", "4");
    expect(loadConfig().maxPrChecksPerPass).toBe(4);
    vi.stubEnv("STARFISH_MAX_PR_CHECKS_PER_PASS", "0");
    expect(() => loadConfig()).toThrow("STARFISH_MAX_PR_CHECKS_PER_PASS");
  });
});

describe("loadConfig: the isolated verify job", () => {
  beforeEach(() => {
    for (const k of ["STARFISH_VERIFY_ISOLATION", "STARFISH_VERIFY_JOB", "STARFISH_VERIFY_BUCKET", "STARFISH_VERIFY_JOB_REGION", "GOOGLE_CLOUD_LOCATION"]) vi.stubEnv(k, "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("names no job and no bucket by default, in the Vertex region", () => {
    expect(loadConfig()).toMatchObject({ verifyJobName: "", verifyBucket: "", verifyJobRegion: "us-central1" });
  });
  it("reads cloud-run-job and its job, bucket and region, which falls back to the project's location", () => {
    vi.stubEnv("STARFISH_VERIFY_ISOLATION", "Cloud-Run-Job");
    vi.stubEnv("STARFISH_VERIFY_JOB", " starfish-verify ");
    vi.stubEnv("STARFISH_VERIFY_BUCKET", "star-verify");
    expect(loadConfig()).toMatchObject({ verifyIsolation: "cloud-run-job", verifyJobName: "starfish-verify", verifyBucket: "star-verify", verifyJobRegion: "us-central1" });
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "europe-west1");
    expect(loadConfig().verifyJobRegion).toBe("europe-west1");
    vi.stubEnv("STARFISH_VERIFY_JOB_REGION", "asia-southeast1");
    expect(loadConfig().verifyJobRegion).toBe("asia-southeast1");
  });
});

describe("loadConfig: the CI-backed verify step", () => {
  beforeEach(() => {
    for (const k of ["STARFISH_VERIFY_ISOLATION", "STARFISH_VERIFY_CHECKS", "STARFISH_VERIFY_CHECK_APP"]) vi.stubEnv(k, "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("names no judge by default, and reads github-actions with the checks that must pass", () => {
    expect(loadConfig().verifyChecks).toEqual([]);
    vi.stubEnv("STARFISH_VERIFY_ISOLATION", " GitHub-Actions ");
    vi.stubEnv("STARFISH_VERIFY_CHECKS", " verify , lint ,, ");
    expect(loadConfig()).toMatchObject({ verifyIsolation: "github-actions", verifyChecks: ["verify", "lint"] });
  });
  it("counts the named checks only from GitHub Actions unless another app is configured (#205)", () => {
    expect(loadConfig().verifyCheckApp).toBe("github-actions");
    vi.stubEnv("STARFISH_VERIFY_CHECK_APP", " our-ci ");
    expect(loadConfig().verifyCheckApp).toBe("our-ci");
  });
  it("refuses a list of checks that is absurd rather than quietly dropping part of it", () => {
    vi.stubEnv("STARFISH_VERIFY_CHECKS", Array.from({ length: 21 }, (_, i) => `c${i}`).join(","));
    expect(() => loadConfig()).toThrow("STARFISH_VERIFY_CHECKS");
  });
});

describe("loadVerifyRunnerRequest", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is the one place the runner's request is read from the environment, and empty is absent", () => {
    vi.stubEnv("STARFISH_VERIFY_REQUEST", "");
    expect(loadVerifyRunnerRequest()).toBeUndefined();
    vi.stubEnv("STARFISH_VERIFY_REQUEST", '{"v":1}');
    expect(loadVerifyRunnerRequest()).toBe('{"v":1}');
  });
});

describe("loadReplayConfig", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("defaults to the committed corpus and results directories, and refuses a timeout that is not above zero", () => {
    vi.stubEnv("STARFISH_REPLAY_CORPUS", "");
    vi.stubEnv("STARFISH_REPLAY_RESULTS_DIR", "");
    vi.stubEnv("STARFISH_REPLAY_CASE_TIMEOUT_SECONDS", "");
    expect(loadReplayConfig()).toEqual({ corpusDir: "scoreboard/corpus", resultsDir: "scoreboard/results", caseTimeoutSeconds: 1800 });
    vi.stubEnv("STARFISH_REPLAY_CORPUS", "/c");
    vi.stubEnv("STARFISH_REPLAY_RESULTS_DIR", "/r");
    vi.stubEnv("STARFISH_REPLAY_CASE_TIMEOUT_SECONDS", "60");
    expect(loadReplayConfig()).toEqual({ corpusDir: "/c", resultsDir: "/r", caseTimeoutSeconds: 60 });
    vi.stubEnv("STARFISH_REPLAY_CASE_TIMEOUT_SECONDS", "0");
    expect(() => loadReplayConfig()).toThrow(/STARFISH_REPLAY_CASE_TIMEOUT_SECONDS/);
  });
});

describe("loadConfig: where a missing index may be created", () => {
  beforeEach(() => {
    vi.stubEnv("STARFISH_INDEX_ALLOWED_TARGETS", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("allows nothing by default", () => {
    expect(loadConfig().indexAllowedTargets).toEqual([]);
  });

  it("reads the admin API's browser origins, exact and https only", () => {
    expect(loadConfig().adminApiOrigins).toEqual([]);
    vi.stubEnv("STARFISH_ADMIN_API_ORIGINS", "https://site.web.app/, http://localhost:5177");
    expect(loadConfig().adminApiOrigins).toEqual(["https://site.web.app", "http://localhost:5177"]);
    for (const bad of ["site.web.app", "http://site.web.app", "https://site.web.app/app", "https://u:p@site.web.app", "*"]) {
      vi.stubEnv("STARFISH_ADMIN_API_ORIGINS", bad);
      expect(() => loadConfig(), bad).toThrow(/STARFISH_ADMIN_API_ORIGINS/);
    }
  });

  it("requires App Check on the admin API only when asked (#12), and refuses a value that is not a boolean", () => {
    expect(loadConfig().adminApiRequireAppCheck).toBe(false);
    vi.stubEnv("STARFISH_ADMIN_API_APPCHECK", "true");
    expect(loadConfig().adminApiRequireAppCheck).toBe(true);
    vi.stubEnv("STARFISH_ADMIN_API_APPCHECK", "enforce");
    expect(() => loadConfig()).toThrow(/STARFISH_ADMIN_API_APPCHECK/);
  });

  it("reads the UI origin for Slack links: exact, https, empty by default", () => {
    expect(loadConfig().uiBaseUrl).toBe("");
    vi.stubEnv("STARFISH_UI_URL", "https://site.web.app/");
    expect(loadConfig().uiBaseUrl).toBe("https://site.web.app");
    for (const bad of ["site.web.app", "http://site.web.app", "https://site.web.app/app"]) {
      vi.stubEnv("STARFISH_UI_URL", bad);
      expect(() => loadConfig(), bad).toThrow(/STARFISH_UI_URL/);
    }
  });

  it("reads the Slack webhook as a secret: only a Slack URL, and a bad one is refused without being echoed", () => {
    expect(loadSlackOnCallWebhook()).toBeUndefined();
    const good = "https://hooks.slack.com/services/T000AAAA/B000BBBB/" + "x".repeat(24);
    vi.stubEnv("STARFISH_SLACK_WEBHOOK_ONCALL", `  ${good}  `);
    expect(loadSlackOnCallWebhook()).toBe(good);
    vi.stubEnv("STARFISH_SLACK_WEBHOOK_ONCALL", "http://127.0.0.1:9999/services/T000/B000/xxxx");
    expect(loadSlackOnCallWebhook()).toContain("127.0.0.1");
    for (const bad of ["https://evil.example/services/T000AAAA/B000BBBB/xxxxxxxx", "https://hooks.slack.com.evil.example/services/T000AAAA/B000BBBB/x", "http://example.com/services/T/B/x", "not a url"]) {
      vi.stubEnv("STARFISH_SLACK_WEBHOOK_ONCALL", bad);
      try {
        loadSlackOnCallWebhook();
        expect.unreachable(bad);
      } catch (err) {
        expect((err as Error).message).toMatch(/STARFISH_SLACK_WEBHOOK_ONCALL/);
        expect((err as Error).message).not.toContain(bad);
      }
    }
  });

  it("reads the #ops-alerts webhook under its own name, by the same rules, and independently of the on-call one", () => {
    vi.stubEnv("STARFISH_SLACK_WEBHOOK_ONCALL", "");
    vi.stubEnv("STARFISH_SLACK_WEBHOOK_ALERTS", "");
    expect(loadSlackAlertsWebhook()).toBeUndefined();
    const good = "https://hooks.slack.com/services/T000AAAA/B000CCCC/" + "y".repeat(24);
    vi.stubEnv("STARFISH_SLACK_WEBHOOK_ALERTS", good);
    expect(loadSlackAlertsWebhook()).toBe(good);
    expect(loadSlackOnCallWebhook()).toBeUndefined();
    const bad = "https://evil.example/services/T000AAAA/B000BBBB/secretvalue";
    vi.stubEnv("STARFISH_SLACK_WEBHOOK_ALERTS", bad);
    try {
      loadSlackAlertsWebhook();
      expect.unreachable(bad);
    } catch (err) {
      expect((err as Error).message).toMatch(/STARFISH_SLACK_WEBHOOK_ALERTS/);
      expect((err as Error).message).not.toContain("secretvalue");
    }
  });

  it("does not put the Slack webhook in the config object", () => {
    vi.stubEnv("STARFISH_SLACK_WEBHOOK_ONCALL", "https://hooks.slack.com/services/T000AAAA/B000BBBB/" + "x".repeat(24));
    vi.stubEnv("STARFISH_SLACK_WEBHOOK_ALERTS", "https://hooks.slack.com/services/T000AAAA/B000CCCC/" + "y".repeat(24));
    expect(JSON.stringify(loadConfig())).not.toContain("hooks.slack.com");
  });

  it("listens on PORT when Cloud Run sets it, and refuses nonsense", () => {
    expect(loadConfig().adminApiPort).toBe(8080);
    vi.stubEnv("PORT", "9090");
    expect(loadConfig().adminApiPort).toBe(9090);
    vi.stubEnv("PORT", "0");
    expect(() => loadConfig()).toThrow(/PORT/);
  });

  it("reads project/database pairs", () => {
    vi.stubEnv("STARFISH_INDEX_ALLOWED_TARGETS", "demo-app-1/(default), demo-app-1/shop-db");
    expect(loadConfig().indexAllowedTargets).toEqual(["demo-app-1/(default)", "demo-app-1/shop-db"]);
  });

  it.each(["demo-app-1", "demo-app-1/", "Demo/(default)", "a/b/c"])("refuses the entry %s at startup instead of widening the list", (bad) => {
    vi.stubEnv("STARFISH_INDEX_ALLOWED_TARGETS", bad);
    expect(() => loadConfig()).toThrow("STARFISH_INDEX_ALLOWED_TARGETS");
  });

  it("creates no index and caps three a day by default", () => {
    vi.stubEnv("STARFISH_INDEX_AUTO_APPLY", "");
    vi.stubEnv("STARFISH_INDEX_DAILY_CAP", "");
    expect(loadConfig()).toMatchObject({ indexAutoApply: false, indexDailyCap: 3 });
  });

  it("refuses a create at 100 existing indexes by default, and reads the limit", () => {
    vi.stubEnv("STARFISH_INDEX_MAX_PER_DATABASE", "");
    expect(loadConfig()).toMatchObject({ indexMaxPerDatabase: 100 });
    vi.stubEnv("STARFISH_INDEX_MAX_PER_DATABASE", "150");
    expect(loadConfig()).toMatchObject({ indexMaxPerDatabase: 150 });
    vi.stubEnv("STARFISH_INDEX_MAX_PER_DATABASE", "0");
    expect(() => loadConfig()).toThrow("STARFISH_INDEX_MAX_PER_DATABASE");
  });

  it("reads the switch and the cap, and refuses a typo at startup", () => {
    vi.stubEnv("STARFISH_INDEX_AUTO_APPLY", "true");
    vi.stubEnv("STARFISH_INDEX_DAILY_CAP", "5");
    expect(loadConfig()).toMatchObject({ indexAutoApply: true, indexDailyCap: 5 });
    vi.stubEnv("STARFISH_INDEX_AUTO_APPLY", "maybe");
    expect(() => loadConfig()).toThrow("STARFISH_INDEX_AUTO_APPLY");
    vi.stubEnv("STARFISH_INDEX_AUTO_APPLY", "true");
    vi.stubEnv("STARFISH_INDEX_DAILY_CAP", "0");
    expect(() => loadConfig()).toThrow("STARFISH_INDEX_DAILY_CAP");
  });

  it("has no probe, the root index file, a 10-minute wait and a 60-minute watch by default", () => {
    for (const k of ["STARFISH_INDEX_PROBES", "STARFISH_INDEX_FILE", "STARFISH_INDEX_WAIT_MINUTES", "STARFISH_INDEX_OBSERVE_MINUTES"]) vi.stubEnv(k, "");
    expect(loadConfig()).toMatchObject({ indexProbes: [], indexFilePath: "firestore.indexes.json", indexWaitMinutes: 10, indexObserveMinutes: 60 });
  });

  it("reads the probes and the index file, and refuses either malformed at startup", () => {
    vi.stubEnv("STARFISH_INDEX_PROBES", JSON.stringify([{ target: "demo-app-1/(default)", collection: "orders", where: [["status", "==", "open"]] }]));
    vi.stubEnv("STARFISH_INDEX_FILE", "firebase/firestore.indexes.json");
    expect(loadConfig()).toMatchObject({ indexProbes: [{ project: "demo-app-1", collection: "orders" }], indexFilePath: "firebase/firestore.indexes.json" });
    vi.stubEnv("STARFISH_INDEX_FILE", "../elsewhere.json");
    expect(() => loadConfig()).toThrow("STARFISH_INDEX_FILE");
    vi.stubEnv("STARFISH_INDEX_FILE", "");
    vi.stubEnv("STARFISH_INDEX_PROBES", "[{");
    expect(() => loadConfig()).toThrow("STARFISH_INDEX_PROBES");
  });
});

describe("loadConfig: auto-merge and fast-revert (#9)", () => {
  const VARS = [
    "STARFISH_AUTO_MERGE",
    "STARFISH_MERGE_FREEZE",
    "STARFISH_AUTO_MERGE_TARGETS",
    "STARFISH_AUTO_MERGE_EXCLUDED_PATHS",
    "STARFISH_MAX_MERGES_PER_DAY",
    "STARFISH_MERGE_CHECK_WAIT_MINUTES",
    "STARFISH_FAST_REVERT_MINUTES",
    "STARFISH_FAST_REVERT_GRACE_MINUTES",
  ];
  beforeEach(() => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
    for (const v of VARS) vi.stubEnv(v, undefined as unknown as string);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("merges nothing by default: the switch off, no target allowed", () => {
    expect(loadConfig()).toMatchObject({
      autoMerge: false,
      mergeFreeze: false,
      autoMergeTargets: [],
      autoMergeExcludedPaths: [],
      maxMergesPerDay: 3,
      mergeCheckWaitMinutes: 120,
      fastRevertMinutes: 60,
      fastRevertGraceMinutes: 10,
    });
  });

  it("reads every value", () => {
    vi.stubEnv("STARFISH_AUTO_MERGE", "true");
    vi.stubEnv("STARFISH_MERGE_FREEZE", "yes");
    vi.stubEnv("STARFISH_AUTO_MERGE_TARGETS", "acme/demo-shop, acme/other");
    vi.stubEnv("STARFISH_AUTO_MERGE_EXCLUDED_PATHS", "functions/src/legacy/");
    vi.stubEnv("STARFISH_MAX_MERGES_PER_DAY", "1");
    vi.stubEnv("STARFISH_MERGE_CHECK_WAIT_MINUTES", "30");
    vi.stubEnv("STARFISH_FAST_REVERT_MINUTES", "45");
    vi.stubEnv("STARFISH_FAST_REVERT_GRACE_MINUTES", "5");
    expect(loadConfig()).toMatchObject({
      autoMerge: true,
      mergeFreeze: true,
      autoMergeTargets: ["acme/demo-shop", "acme/other"],
      autoMergeExcludedPaths: ["functions/src/legacy/"],
      maxMergesPerDay: 1,
      mergeCheckWaitMinutes: 30,
      fastRevertMinutes: 45,
      fastRevertGraceMinutes: 5,
    });
  });

  it.each([["STARFISH_AUTO_MERGE", "maybe"], ["STARFISH_AUTO_MERGE_TARGETS", "demo-shop"], ["STARFISH_AUTO_MERGE_TARGETS", "a/b/c"], ["STARFISH_MAX_MERGES_PER_DAY", "0"], ["STARFISH_FAST_REVERT_MINUTES", "-1"]])(
    "refuses %s=%s at startup",
    (name, value) => {
      vi.stubEnv(name, value);
      expect(() => loadConfig()).toThrow(name);
    }
  );
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

describe("loadConfig: self-exclusion (#32)", () => {
  beforeEach(() => {
    vi.stubEnv("STARFISH_EXCLUDED_SERVICES", "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("excludes Starfish's own service by default", () => {
    // An empty stub is how these tests say "unset": the loader treats an empty value as unset for most settings.
    vi.unstubAllEnvs();
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
    delete process.env.STARFISH_EXCLUDED_SERVICES;
    expect(loadConfig().excludedServices).toEqual(["starfish"]);
  });

  it("reads a comma-separated list, trimmed", () => {
    vi.stubEnv("STARFISH_EXCLUDED_SERVICES", " starfish-ingest , Starfish_Agent ,");
    expect(loadConfig().excludedServices).toEqual(["starfish-ingest", "Starfish_Agent"]);
  });

  it("set to empty excludes nothing, on purpose", () => {
    vi.stubEnv("STARFISH_EXCLUDED_SERVICES", "");
    expect(loadConfig().excludedServices).toEqual([]);
  });
});


describe("loadConfig: the Cloud Monitoring signal (#19)", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
    delete process.env.STARFISH_MONITORING_ENABLED;
    delete process.env.STARFISH_MONITORING_RESOURCE_TYPES;
    delete process.env.STARFISH_MONITORING_MAX_SERIES;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is off by default, with both built-in signals and a 500-series cap", () => {
    const c = loadConfig();
    expect(c.monitoringEnabled).toBe(false);
    expect(c.monitoringSignals.map((s) => s.resourceType)).toEqual(["cloud_run_revision", "cloud_function"]);
    expect(c.monitoringMaxSeries).toBe(500);
  });

  it("reads the switch, the resource types and the cap", () => {
    vi.stubEnv("STARFISH_MONITORING_ENABLED", "true");
    vi.stubEnv("STARFISH_MONITORING_RESOURCE_TYPES", "cloud_run_revision");
    vi.stubEnv("STARFISH_MONITORING_MAX_SERIES", "50");
    const c = loadConfig();
    expect(c.monitoringEnabled).toBe(true);
    expect(c.monitoringSignals.map((s) => s.metricType)).toEqual(["run.googleapis.com/request_count"]);
    expect(c.monitoringMaxSeries).toBe(50);
  });

  it("refuses an unknown resource type, and on with no signal at all", () => {
    vi.stubEnv("STARFISH_MONITORING_RESOURCE_TYPES", "gae_app");
    expect(() => loadConfig()).toThrow("STARFISH_MONITORING_RESOURCE_TYPES");
    vi.stubEnv("STARFISH_MONITORING_RESOURCE_TYPES", "");
    expect(loadConfig().monitoringSignals).toEqual([]);
    vi.stubEnv("STARFISH_MONITORING_ENABLED", "true");
    expect(() => loadConfig()).toThrow("lists none");
  });
});

describe("phone escalation settings (#37)", () => {
  const TWILIO = ["STARFISH_TWILIO_ACCOUNT_SID", "STARFISH_TWILIO_AUTH_TOKEN", "STARFISH_TWILIO_FROM_NUMBER"];
  beforeEach(() => {
    for (const k of [...KEYS, ...TWILIO, "STARFISH_PHONE_ESCALATION", "STARFISH_ONCALL_AUDIO_URL", "STARFISH_TWILIO_WEBHOOK_URL", "STARFISH_TWILIO_API_URL"]) vi.stubEnv(k, "");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "home-project");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is off by default, with no audio file and nowhere for Twilio to call back", () => {
    const c = loadConfig();
    expect(c.phoneEscalation).toBe(false);
    expect(c.onCallAudioUrl).toBe("");
    expect(c.twilioWebhookUrl).toBe("");
    expect(c.twilioApiUrl).toBe("https://api.twilio.com");
    expect(c.onCallPeopleCollection).toBe("starfish_oncall_people");
  });

  it("takes an https audio file and an exact https origin for the webhooks, and refuses anything else", () => {
    vi.stubEnv("STARFISH_PHONE_ESCALATION", "true");
    vi.stubEnv("STARFISH_ONCALL_AUDIO_URL", "https://storage.googleapis.com/my-bucket/oncall.mp3");
    vi.stubEnv("STARFISH_TWILIO_WEBHOOK_URL", "https://admin.example.test");
    const c = loadConfig();
    expect(c.phoneEscalation).toBe(true);
    expect(c.onCallAudioUrl).toBe("https://storage.googleapis.com/my-bucket/oncall.mp3");
    expect(c.twilioWebhookUrl).toBe("https://admin.example.test");
    vi.stubEnv("STARFISH_ONCALL_AUDIO_URL", "http://storage.example/a.mp3");
    expect(() => loadConfig()).toThrow(/STARFISH_ONCALL_AUDIO_URL/);
    vi.stubEnv("STARFISH_ONCALL_AUDIO_URL", "");
    vi.stubEnv("STARFISH_TWILIO_WEBHOOK_URL", "https://admin.example.test/twilio");
    expect(() => loadConfig()).toThrow(/STARFISH_TWILIO_WEBHOOK_URL/);
  });

  it("reads Twilio's credentials as secrets: all three or none, each of its shape, refused by name without echoing", () => {
    expect(loadTwilioCredentials()).toBeUndefined();
    const sid = `AC${"0".repeat(32)}`;
    const token = "a".repeat(32);
    vi.stubEnv("STARFISH_TWILIO_ACCOUNT_SID", sid);
    expect(() => loadTwilioCredentials()).toThrow(/must be set together/);
    vi.stubEnv("STARFISH_TWILIO_AUTH_TOKEN", token);
    vi.stubEnv("STARFISH_TWILIO_FROM_NUMBER", "+15550001111");
    expect(loadTwilioCredentials()).toEqual({ accountSid: sid, authToken: token, fromNumber: "+15550001111" });
    vi.stubEnv("STARFISH_TWILIO_AUTH_TOKEN", "not-a-token-zzzz");
    try {
      loadTwilioCredentials();
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/STARFISH_TWILIO_AUTH_TOKEN/);
      expect((err as Error).message).not.toContain("not-a-token-zzzz");
    }
  });
});
