import { defineConfig } from "vitest/config";
import { commonResolveConfig, machineIsolatedTestConfig } from "./vitest.config.shared";

export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...machineIsolatedTestConfig,
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      "apps/*/test/unit/**/*.test.ts",
      "apps/*/test/unit/**/*.test.tsx",
      "packages/*/test/unit/**/*.test.ts",
      "integrations/*/*/test/unit/**/*.test.ts",
    ],
    exclude: ["apps/*/src/**/*.integration.test.ts", "apps/*/src/**/*.integration.test.tsx"],
  },
});
