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
