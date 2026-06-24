import { defineConfig } from "vitest/config";
import { commonResolveConfig, commonTestConfig } from "./vitest.config.shared";

export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...commonTestConfig,
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
