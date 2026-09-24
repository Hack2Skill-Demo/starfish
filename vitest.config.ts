import { defineConfig } from "vitest/config";

// Engine tests only. web/ has its own config (jsdom), and rules/ needs the
// Firestore emulator (`pnpm test:rules`).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
