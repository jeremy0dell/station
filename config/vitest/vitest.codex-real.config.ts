import { defineConfig } from "vitest/config";
import { commonResolveConfig, commonTestConfig } from "./vitest.config.shared";

export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...commonTestConfig,
    include: ["tests/agent/real/codex/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 180_000,
  },
});
