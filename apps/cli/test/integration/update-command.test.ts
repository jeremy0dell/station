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
      inspectInstalled: async () => ({ version: "1.1.0" }),
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
        inspectInstalled: async () => ({ version: "1.1.0" }),
      }),
    };
    const build = {
      compiled: false,
      version: "1.0.0",
      buildIdentity: "a".repeat(64),
    };
    const buildInfo = vi.fn(() => build);
    const recoveryPreflight = vi.fn(emptyPreflight);

    const result = await runCli(["--config", configPath, "update", "--dry-run", "--json"], {
      updateDeps: {
        probes: [probe],
        buildInfo,
        recoveryPreflight,
      },
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        schemaVersion: 6,
        kind: "preview",
        channel: "installer-binary",
        plan: { outcome: "actionable" },
      },
    });
    expect(apply).not.toHaveBeenCalled();

    const reapResult = await runCli(
      ["--config", configPath, "update", "--dry-run", "--reap", "--no-handoff", "--json"],
      {
        updateDeps: {
          probes: [probe],
          buildInfo,
          recoveryPreflight,
        },
      },
    );
    expect(reapResult).toMatchObject({
      code: 0,
      output: {
        schemaVersion: 6,
        kind: "preview",
        initial: {
          boundary: {
            authorization: "none",
            actions: "not-included",
            digest: "not-included",
          },
          observer: { status: "absent" },
          host: { status: "absent" },
          evidenceComplete: false,
        },
      },
    });
    expect(buildInfo).toHaveBeenCalledTimes(2);
    expect(recoveryPreflight).toHaveBeenCalledTimes(2);
    for (const [input] of recoveryPreflight.mock.calls) {
      expect(input.currentBuildInfo).toBe(build);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps mutation-capable Host dependencies outside dry-run preflight", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const ensureHost = vi.fn();
    const resolveHostCommand = vi.fn();
    const clientFactory = vi.fn();
    const probe: UpdateChannelProbe = {
      channel: "installer-binary",
      inspectInstalled: async () => ({ version: "1.0.0" }),
      detectAndPlan: async () => ({
        channel: "installer-binary",
        plan: {
          channel: "installer-binary",
          status: "current",
          currentVersion: "1.0.0",
          targetVersion: "1.0.0",
          currentCli: ["/opt/stn"],
        },
        apply: vi.fn(),
        inspectInstalled: async () => ({ version: "1.0.0" }),
      }),
    };

    const result = await runCli(["--config", configPath, "update", "--dry-run", "--json"], {
      hostDeps: { ensureHost, resolveHostCommand, clientFactory },
      updateDeps: { probes: [probe], buildInfo: () => build },
    });

    expect(result).toMatchObject({ code: expect.any(Number), output: { kind: "preview" } });
    expect(ensureHost).not.toHaveBeenCalled();
    expect(resolveHostCommand).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("renders update help without loading config", async () => {
    const result = await runCli(["--config", "/missing/config.toml", "update", "--help"]);
    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    expect(result.output).toContain("--drive-package-manager");
    expect(result.output).toContain("--reap");
    expect(result.output).toContain("--handoff[=processes|screen]");
    expect(result.output).toContain("--no-handoff");
  });

  it("rejects direct invocation of the private successor transport", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);

    await expect(
      runCli(["--config", configPath, "update", "--successor"], { stdin: "{}" }),
    ).rejects.toThrow("private transport command");
  });
});

const build = {
  compiled: false,
  version: "1.0.0",
  buildIdentity: "a".repeat(64),
};

async function emptyPreflight({
  installed,
  target,
}: {
  installed: { version: string; revision?: string };
  target: { version: string; revision?: string };
}) {
  return {
    schemaVersion: 1 as const,
    boundary: {
      authorization: "none" as const,
      actions: "not-included" as const,
      digest: "not-included" as const,
    },
    installed,
    target,
    observer: { status: "absent" as const },
    host: { status: "absent" as const },
    parkedBridges: {
      status: "assessed" as const,
      totalParkedCount: 0,
      unownedParkedCount: 0,
      adoptionRequiredCount: 0,
    },
    hookProviderIds: [],
    hooks: [],
    terminalDispositions: [],
    evidenceComplete: false,
  };
}
