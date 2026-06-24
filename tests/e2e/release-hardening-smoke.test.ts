import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("release smoke", () => {
  it("runs the deterministic release smoke against the built CLI", () => {
    const root = process.cwd();
    const cliEntry = join(root, "apps", "cli", "dist", "main.js");
    if (!existsSync(cliEntry)) {
      const build = spawnSync("pnpm", ["build"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(build.status, build.stderr || build.stdout).toBe(0);
    }

    const result = spawnSync("pnpm", ["smoke:release", "--", "--skip-build", "--skip-scripted"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        STATION_RELEASE_SMOKE_TIMEOUT_MS: "60000",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("release smoke passed");
    expect(result.stdout).toContain("debugBundle");
  }, 120_000);
});
