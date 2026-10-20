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

// The engine tests that start real processes (git, tar, `pnpm exec tsx <cli>`) hit the same wall in a
// loaded parallel run (#464: verifyGate, grantOperatorCli and verifyRunner each timed out once and
// passed alone). They are named here and given the same room; a new test file that spawns a process
// belongs in this list. Every other engine test keeps the 5 s default.
const PROCESS_TESTS = [
  "src/agent/assemble.test.ts",
  "src/agent/patchNormalize.test.ts",
  "src/agent/verifyGate.test.ts",
  "src/agent/verifyRemote.test.ts",
  "src/agent/verifyRunner.test.ts",
  "src/grantOperatorCli.test.ts",
  "src/indexheal/indexFilePatch.test.ts",
  "src/integrations/githubMerge.test.ts",
  "src/integrations/githubPr.test.ts",
  "src/scoreboardCli.test.ts",
];

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: { name: "engine", include: ["src/**/*.test.ts"], exclude: ["src/**/*.emulator.test.ts", ...PROCESS_TESTS] },
      },
      {
        extends: true,
        test: { name: "engine-processes", include: PROCESS_TESTS, testTimeout: SCRIPT_TEST_TIMEOUT_MS },
      },
      {
        extends: true,
        test: { name: "scripts", include: ["scripts/**/*.test.mjs"], testTimeout: SCRIPT_TEST_TIMEOUT_MS },
      },
    ],
  },
});
