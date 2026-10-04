/**
 * A complete StarfishConfig for tests, so a new setting is added in one place instead of in every
 * test file that builds one. Only tests import this.
 */
import { DEFAULT_IGNORED_MESSAGES, DEFAULT_LOG_RESOURCE_TYPES, type StarfishConfig } from "./config.js";

export function testConfig(over: Partial<StarfishConfig> = {}): StarfishConfig {
  return {
    projectId: "p",
    watchedProjectId: "p",
    vertexProjectId: "p",
    location: "us-central1",
    model: "m",
    environment: "prod",
    settingsCollection: "starfish_settings",
    incidentCollection: "incidents",
    incidentKeyCollection: "incident_keys",
    runCollection: "starfish_runs",
    excludedServices: [],
    cycleCollection: "starfish_cycles",
    usersCollection: "starfish_users",
    auditCollection: "starfish_audit",
    databaseId: "starfish",
    servicePatterns: {},
    defaultLookbackHours: 24,
    verifyCommand: "",
    verifyTimeoutSeconds: 600,
    patchExcludedPaths: [],
    ingestLagMinutes: 5,
    ingestMaxWindowHours: 6,
    dryRun: true,
    reviewRequired: true,
    modelCallBudget: 6,
    leaseSeconds: 300,
    cycleDeadlineMinutes: 60,
    maxCycleAttempts: 3,
    logResourceTypes: [...DEFAULT_LOG_RESOURCE_TYPES],
    ignoredMessages: [...DEFAULT_IGNORED_MESSAGES],
    ...over,
  };
}
