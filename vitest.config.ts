import { defineConfig } from "vitest/config";

// Engine and script tests only. web/ has its own config (jsdom), and the emulator suites
// (rules/, src/**/*.emulator.test.ts) need the Firestore emulator
// (`pnpm test:emulator`).
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"], exclude: ["src/**/*.emulator.test.ts"], environment: "node" },
});
