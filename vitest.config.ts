import { defineConfig } from "vitest/config";

// Engine and script tests only. web/ has its own config (jsdom), and the emulator suites
// (rules/, src/**/*.emulator.test.ts) need the Firestore emulator
// (`pnpm test:emulator`).
//
// The script tests (scripts/**/*.test.mjs) mostly run a real shell script against stubbed
// gcloud/gh/curl, several times a test: alone each takes well under a second to a few, but in a
// full parallel run one passed Vitest's 5 s default and timed out (#405). They get their own,
// longer timeout here, so every such file is covered without each one repeating it; the engine
// tests keep the default, where a slow test is a finding.
const SCRIPT_TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: { name: "engine", include: ["src/**/*.test.ts"], exclude: ["src/**/*.emulator.test.ts"] },
      },
      {
        extends: true,
        test: { name: "scripts", include: ["scripts/**/*.test.mjs"], testTimeout: SCRIPT_TEST_TIMEOUT_MS },
      },
    ],
  },
});
