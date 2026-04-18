import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "lib/**/*.test.ts",
      "app/**/*.test.ts",
      "components/**/*.test.ts",
      "components/**/*.test.tsx",
    ],
    environment: "node",
  },
});
