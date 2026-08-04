import { defineConfig } from "vitest/config";
import { commonResolveConfig, machineIsolatedTestConfig } from "./vitest.config.shared";

export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...machineIsolatedTestConfig,
    include: ["tests/diagnostics/**/*.test.ts"],
  },
});
