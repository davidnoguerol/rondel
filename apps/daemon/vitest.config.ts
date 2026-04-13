import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for Rondel.
 *
 * The suite is split by filename suffix:
 *   *.unit.test.ts        — pure functions, no I/O
 *   *.integration.test.ts — real fs inside os.tmpdir()
 *   *.contract.test.ts    — reserved for Tier 2+ (adapter contract battery)
 *   *.e2e.test.ts         — reserved for Tier 3 (mocked Claude CLI)
 *
 * Separate npm scripts run each suffix independently — see package.json.
 * `npm test` runs unit + integration together; contract/e2e stay opt-in.
 */
export default defineConfig({
  test: {
    include: [
      "src/**/*.unit.test.ts",
      "src/**/*.integration.test.ts",
      "tests/**/*.unit.test.ts",
      "tests/**/*.integration.test.ts",
    ],
    exclude: ["node_modules", "dist"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
  },
});
