import { defineConfig } from "vitest/config";
import { commonResolveConfig, commonTestConfig } from "./vitest.config.shared";

export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...commonTestConfig,
    testTimeout: 30_000,
    include: [
      "apps/*/src/**/*.integration.test.ts",
      "apps/*/src/**/*.integration.test.tsx",
      "apps/*/test/integration/**/*.test.ts",
      "apps/*/test/integration/**/*.test.tsx",
      "packages/*/test/integration/**/*.test.ts",
      "integrations/*/*/test/integration/**/*.test.ts",
    ],
  },
});
