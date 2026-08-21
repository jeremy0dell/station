import { runCli } from "@station/cli";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import type { UpdateChannelProbe } from "../../src/update/channelDetection.js";

describe("registered stn update command", () => {
  it("routes a machine-readable dry-run through the CLI registry", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const apply = vi.fn(async () => ({
      channel: "installer-binary" as const,
      status: "installed" as const,
      previousVersion: "1.0.0",
      installedVersion: "1.1.0",
      successorCli: ["/opt/stn"] as const,
      warnings: [],
    }));
    const probe: UpdateChannelProbe = {
      channel: "installer-binary",
      detectAndPlan: async () => ({
        channel: "installer-binary",
        plan: {
          channel: "installer-binary",
          status: "update-available",
          currentVersion: "1.0.0",
          targetVersion: "1.1.0",
          currentCli: ["/opt/stn"],
        },
        apply,
      }),
    };

    const result = await runCli(["--config", configPath, "update", "--dry-run", "--json"], {
      updateDeps: {
        probes: [probe],
        buildInfo: () => ({
          compiled: false,
          version: "1.0.0",
          buildIdentity: "a".repeat(64),
        }),
      },
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        schemaVersion: 2,
        channel: "installer-binary",
        status: "planned",
      },
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("renders update help without loading config", async () => {
    const result = await runCli(["--config", "/missing/config.toml", "update", "--help"]);
    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    expect(result.output).toContain("--drive-package-manager");
    expect(result.output).toContain("--reap");
    expect(result.output).toContain("--handoff[=processes|screen]");
    expect(result.output).toContain("--no-handoff");
  });
});
