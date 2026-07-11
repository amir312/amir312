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
      // json-summary emits coverage/coverage-summary.json — vitest's text table
      // hides files that carry their own threshold group, so the number for
      // transitions.ts is verified from the JSON.
      reporter: ["text", "json-summary"],
      thresholds: {
        // Acceptance criterion, phase 0: full line coverage on the state machine.
        // Enforced: setting this to 101 makes `pnpm test` exit non-zero.
        "**/lib/workflow/transitions.ts": { lines: 100 },
      },
    },
  },
});
