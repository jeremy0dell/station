import { defineConfig } from "vitest/config";
import { commonResolveConfig, commonTestConfig } from "./vitest.config.shared";

export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...commonTestConfig,
    testTimeout: 30_000,
    include: [
      "integrations/terminal/tmux/test/integration/placement-real.test.ts",
      "integrations/terminal/tmux/test/integration/popup-real.test.ts",
    ],
  },
});
