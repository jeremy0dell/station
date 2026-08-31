import { defineConfig } from "vitest/config";
import { commonResolveConfig, machineIsolatedTestConfig } from "./vitest.config.shared";

export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...machineIsolatedTestConfig,
    testTimeout: 30_000,
    include: [
      "apps/*/src/**/*.integration.test.ts",
      "apps/*/src/**/*.integration.test.tsx",
      "apps/*/test/integration/**/*.test.ts",
      "apps/*/test/integration/**/*.test.tsx",
      "packages/*/test/integration/**/*.test.ts",
      "integrations/*/*/test/integration/**/*.test.ts",
    ],
    exclude: [
      "integrations/terminal/tmux/test/integration/placement-real.test.ts",
      "integrations/terminal/tmux/test/integration/popup-real.test.ts",
    ],
  },
});
