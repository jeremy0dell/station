import { defineConfig } from "vitest/config";
import { commonResolveConfig, commonTestConfig } from "./vitest.config.shared";

export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...commonTestConfig,
    include: ["tests/e2e/real/**/*.test.ts"],
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    passWithNoTests: true,
    testTimeout: 300_000,
  },
});
