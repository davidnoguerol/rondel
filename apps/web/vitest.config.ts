import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // `@/` alias mirrors the tsconfig `paths` entry so tests can import
  // app code the same way pages do. Without this, a test that
  // transitively pulls in a source file using `@/lib/bridge` fails
  // with "Cannot find package '@/lib/bridge'".
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
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
