import { defineConfig } from "vitest/config";
import { commonResolveConfig, commonTestConfig } from "./vitest.config.shared";

export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...commonTestConfig,
    include: ["tests/agent/scripted/**/*.test.ts", "tests/agent/scenarios/**/*.test.ts"],
  },
});
