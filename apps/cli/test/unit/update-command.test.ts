import { type StationConfig, stationHostSocketPath } from "@station/config";
import { HOST_PROTOCOL_VERSION } from "@station/host";
import { listenUnixSocket } from "@station/protocol";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../tests/support/temp-projects";
import { runUpdateCommand } from "../../src/commands/update.js";
import { selectUpdateChannel, type UpdateChannelProbe } from "../../src/update/channelDetection.js";
import type {
  UpdateApplyReportBase,
  UpdateChannelId,
  UpdatePlanBase,
} from "../../src/update/updateChannel.js";

const config = {} as StationConfig;
const testBuildInfo = () => ({
  compiled: false,
  version: "1.0.0",
  buildIdentity: "a".repeat(64),
});

describe("stn update command", () => {
  it("prints a JSON dry-run plan without applying or crossing runtime boundaries", async () => {
    const fixture = probeFixture("installer-binary");
    const commandRunner = vi.fn();
    const result = await runUpdateCommand(["--dry-run", "--json"], commandOptions(), {
      probes: [fixture.probe],
      commandRunner,
      buildInfo: testBuildInfo,
    });

    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({
      schemaVersion: 1,
      channel: "installer-binary",
      status: "planned",
      current: { version: "1.0.0" },
      target: { version: "1.1.0" },
      steps: [
        { id: "detect", status: "completed" },
        { id: "plan", status: "completed" },
        { id: "apply", status: "planned" },
        { id: "observer-restart", status: "planned" },
        { id: "host-handoff", status: "skipped" },
      ],
    });
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("defers package-manager mutation by default", async () => {
    const fixture = probeFixture("npm-global", {
      managerCommand: ["/opt/npm", "install", "--global", "station@1.1.0"],
      applyReport: {
        channel: "npm-global",
        status: "deferred",
        previousVersion: "1.0.0",
        installedVersion: "1.0.0",
        warnings: [],
      },
    });
    const commandRunner = vi.fn();
    const result = await runUpdateCommand([], commandOptions(), {
      probes: [fixture.probe],
      commandRunner,
      buildInfo: testBuildInfo,
    });

    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    expect(result.output).toContain("status: deferred");
    expect(result.output).toContain("/opt/npm install --global station@1.1.0");
    expect(fixture.apply).toHaveBeenCalledWith({ drivePackageManager: false });
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("drives a manager and restarts the Observer through the successor launcher", async () => {
    const fixture = probeFixture("mise", {
      managerCommand: ["/opt/mise", "upgrade", "station"],
      applyReport: {
        channel: "mise",
        status: "updated",
        previousVersion: "1.0.0",
        installedVersion: "1.1.0",
        successorCli: ["/opt/mise", "exec", "--", "stn"],
        warnings: [],
      },
    });
    const commands: ExternalCommandInput[] = [];
    const result = await runUpdateCommand(["--drive-package-manager", "--json"], commandOptions(), {
      probes: [fixture.probe],
      buildInfo: testBuildInfo,
      commandRunner: async (input) => {
        commands.push(input);
        return commandResult(input);
      },
    });

    expect(result.output).toMatchObject({ status: "updated" });
    expect(fixture.apply).toHaveBeenCalledWith({ drivePackageManager: true });
    expect(commands).toEqual([
      expect.objectContaining({
        command: "/opt/mise",
        args: ["exec", "--", "stn", "--config", "/tmp/config.toml", "observer", "restart"],
      }),
    ]);
  });

  it("retains a recovery command when Observer crossover fails after install", async () => {
    const fixture = probeFixture("installer-binary");
    const result = await runUpdateCommand(["--json"], commandOptions(), {
      probes: [fixture.probe],
      buildInfo: testBuildInfo,
      commandRunner: async () => {
        throw new Error("observer failed");
      },
    });

    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({
      status: "failed",
      error: { code: "UPDATE_RUNTIME_CROSSOVER_FAILED" },
      recoveryCommands: [["/opt/stn", "--config", "/tmp/config.toml", "observer", "restart"]],
    });
  });

  it("restarts the Observer before an opted-in live Host handoff", async () => {
    const state = await createTempState();
    const socketPath = stationHostSocketPath(state.config);
    const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
    const fixture = probeFixture("installer-binary");
    const commands: ExternalCommandInput[] = [];
    try {
      const result = await runUpdateCommand(
        ["--handoff=screen", "--json"],
        {
          config: state.config,
          configPath: "/tmp/config.toml",
          cliEntryPath: "/repo/apps/cli/dist/main.js",
        },
        {
          probes: [fixture.probe],
          buildInfo: testBuildInfo,
          hostDeps: {
            clientFactory: () =>
              ({
                health: async () => ({
                  ok: true,
                  protocolVersion: HOST_PROTOCOL_VERSION,
                  buildVersion: "1.0.0",
                }),
                list: async () => [{ ptyId: "pty-1", pid: 42, alive: true }],
                dispose: () => undefined,
              }) as never,
          },
          commandRunner: async (input) => {
            commands.push(input);
            return commandResult(input);
          },
        },
      );

      expect(result.output).toMatchObject({ status: "updated" });
      expect(commands.map(({ args }) => args)).toEqual([
        ["--config", "/tmp/config.toml", "observer", "restart"],
        ["--config", "/tmp/config.toml", "host", "handoff", "--fidelity", "screen"],
      ]);
    } finally {
      await server.close();
    }
  });

  it("rejects manager driving for non-manager channels", async () => {
    const fixture = probeFixture("installer-binary");
    await expect(
      runUpdateCommand(["--drive-package-manager"], commandOptions(), {
        probes: [fixture.probe],
        buildInfo: testBuildInfo,
      }),
    ).rejects.toMatchObject({ code: "UPDATE_FLAG_INVALID" });
  });

  it("rejects unknown and duplicate flags before detection", async () => {
    await expect(runUpdateCommand(["--channel", "other"], commandOptions())).rejects.toThrow(
      "Usage: stn update",
    );
    await expect(runUpdateCommand(["--handoff", "--handoff"], commandOptions())).rejects.toThrow(
      "--handoff may be provided only once",
    );
  });
});

describe("update channel selection", () => {
  it("requires one unambiguous owner and honors explicit selection", async () => {
    const installer = probeFixture("installer-binary").probe;
    const npm = probeFixture("npm-global").probe;
    await expect(selectUpdateChannel({ probes: [installer, npm] })).rejects.toMatchObject({
      code: "UPDATE_CHANNEL_AMBIGUOUS",
    });
    await expect(
      selectUpdateChannel({ probes: [installer, npm], requested: "npm-global" }),
    ).resolves.toMatchObject({ channel: "npm-global" });
    await expect(
      selectUpdateChannel({ probes: [missingProbe("mise")], requested: "mise" }),
    ).rejects.toMatchObject({ code: "UPDATE_CHANNEL_NOT_DETECTED" });
  });
});

function commandOptions() {
  return {
    config,
    configPath: "/tmp/config.toml",
    cliEntryPath: "/repo/apps/cli/dist/main.js",
  };
}

function probeFixture(
  channel: UpdateChannelId,
  overrides: {
    managerCommand?: readonly [string, ...string[]];
    applyReport?: UpdateApplyReportBase;
  } = {},
) {
  const plan: UpdatePlanBase = {
    channel,
    status: "update-available",
    currentVersion: "1.0.0",
    targetVersion: "1.1.0",
    currentCli: ["/opt/stn"],
    ...(overrides.managerCommand === undefined ? {} : { managerCommand: overrides.managerCommand }),
  };
  const apply = vi.fn(
    async () =>
      (overrides.applyReport ?? {
        channel,
        status: "installed",
        previousVersion: "1.0.0",
        installedVersion: "1.1.0",
        successorCli: ["/opt/stn"],
        warnings: [],
      }) satisfies UpdateApplyReportBase,
  );
  const probe: UpdateChannelProbe = {
    channel,
    detectAndPlan: async () => ({ channel, plan, apply }),
  };
  return { probe, apply };
}

function missingProbe(channel: UpdateChannelId): UpdateChannelProbe {
  return { channel, detectAndPlan: async () => undefined };
}

function commandResult(input: ExternalCommandInput): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout: "",
    stderr: "",
    exitCode: 0,
  };
}
