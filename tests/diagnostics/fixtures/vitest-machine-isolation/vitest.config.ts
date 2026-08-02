import { defineConfig } from "vitest/config";
import {
  commonResolveConfig,
  machineIsolatedTestConfig,
} from "../../../../config/vitest/vitest.config.shared";

/**
 * The diagnostics regression loads this child Vitest config by file path.
 *
 * @knipignore
 */
export default defineConfig({
  ...commonResolveConfig,
  test: {
    ...machineIsolatedTestConfig,
    include: ["tests/diagnostics/fixtures/vitest-machine-isolation/*.fixture.ts"],
  },
});
