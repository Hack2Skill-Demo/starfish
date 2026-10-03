import { defineConfig } from "vitest/config";

// Suites that need the Firestore emulator: firestore.rules (rules/) and the
// store's concurrency tests (src/**/*.emulator.test.ts). Run via
// `pnpm test:emulator`, which starts the emulator with firebase-tools and runs
// these inside it. One file at a time: they share one emulator.
export default defineConfig({
  test: {
    include: ["rules/**/*.test.ts", "src/**/*.emulator.test.ts"],
    environment: "node",
    testTimeout: 20000,
    fileParallelism: false,
  },
});
