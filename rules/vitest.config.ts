import { defineConfig } from "vitest/config";

// Rules tests need the Firestore emulator: run via `pnpm test:rules`, which
// starts it with firebase-tools and runs this suite inside.
export default defineConfig({
  test: { include: ["rules/**/*.test.ts"], environment: "node", testTimeout: 20000 },
});
