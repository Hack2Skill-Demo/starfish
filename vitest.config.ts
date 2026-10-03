import { defineConfig } from "vitest/config";

// Engine tests only. web/ has its own config (jsdom), and the emulator suites
// (rules/, src/**/*.emulator.test.ts) need the Firestore emulator
// (`pnpm test:emulator`).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["src/**/*.emulator.test.ts"], environment: "node" },
});
