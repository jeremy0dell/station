import { defineConfig } from "vitest/config";
import { commonResolveConfig, commonTestConfig } from "../config/vitest/vitest.config.shared";

export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...commonTestConfig,
    include: [
      "benchmark/real-incident-debugging/harness.unit.test.ts",
      "benchmark/real-incident-debugging/benchmark.real.test.ts",
    ],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
