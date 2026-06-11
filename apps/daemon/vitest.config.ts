import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for Rondel.
 *
 * The suite is split by filename suffix:
 *   *.unit.test.ts        — pure functions, no I/O
 *   *.integration.test.ts — real fs inside os.tmpdir()
 *   *.contract.test.ts    — reserved for Tier 2+ (adapter contract battery)
 *   *.e2e.test.ts         — Tier 3: real-daemon smoke (spawns dist/index.js
 *                           against a scratch RONDEL_HOME; never spawns a
 *                           Claude CLI). Included in the default run via
 *                           `npm test`, which builds first so the e2e never
 *                           exercises a stale dist.
 *
 * Separate npm scripts run each suffix independently — see package.json.
 */
export default defineConfig({
  test: {
    include: [
      "src/**/*.unit.test.ts",
      "src/**/*.integration.test.ts",
      "tests/**/*.unit.test.ts",
      "tests/**/*.integration.test.ts",
      "../../tests/e2e/*.e2e.test.ts",
    ],
    exclude: ["node_modules", "dist"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
  },
});
