import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "e2e/**", ".next/**"],
    globalSetup: ["./db/test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["lib/workflow/**/*.ts"],
      exclude: ["lib/workflow/types.ts"],
      thresholds: {
        // Acceptance criterion, phase 0: full line coverage on the state machine.
        "**/lib/workflow/transitions.ts": { lines: 100 },
      },
    },
  },
});
