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
  UpdateCommandArgv,
  UpdatePlanBase,
} from "../../src/update/updateChannel.js";

const config = {
  observer: { socketPath: `/tmp/station-update-command-${process.pid}/observer.sock` },
} as StationConfig;
const testBuildInfo = () => ({
  compiled: false,
  version: "1.0.0",
  buildIdentity: "a".repeat(64),
});

describe("stn update command", () => {
  it("reports an already-current installation without applying or preflighting handoff", async () => {
    const fixture = probeFixture("installer-binary", { planStatus: "current" });
    const liveHost = await createLiveHostFixture();
    const commandRunner = vi.fn();
    try {
      const result = await runUpdateCommand(
        ["--handoff", "--json"],
        {
          config: liveHost.state.config,
          configPath: "/tmp/config.toml",
          cliEntryPath: "/repo/apps/cli/dist/main.js",
        },
        {
          probes: [fixture.probe],
          commandRunner,
          buildInfo: testBuildInfo,
          hostDeps: liveHost.hostDeps,
        },
      );

      expect(result).toEqual({
        code: 0,
        output: {
          schemaVersion: 1,
          channel: "installer-binary",
          status: "current",
          current: { version: "1.0.0" },
          target: { version: "1.0.0" },
          steps: [
            { id: "detect", status: "completed", detail: "Detected installer-binary ownership." },
            {
              id: "plan",
              status: "completed",
              detail: "Resolved the current and target Station builds.",
            },
            {
              id: "apply",
              status: "skipped",
              detail: "The selected installation already matches its target.",
            },
            { id: "observer-restart", status: "skipped", detail: "No build changed." },
            { id: "host-handoff", status: "skipped", detail: "No build changed." },
          ],
          warnings: [],
          recoveryCommands: [],
        },
      });
      expect(fixture.apply).not.toHaveBeenCalled();
      expect(commandRunner).not.toHaveBeenCalled();
      expect(liveHost.clientFactory).not.toHaveBeenCalled();
    } finally {
      await liveHost.close();
    }
  });

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

  it("describes package-manager deferral in previews without default Host preflight", async () => {
    const fixture = probeFixture("npm-global", {
      managerCommand: ["/opt/npm", "install", "--global", "station@1.1.0"],
    });
    const liveHost = await createLiveHostFixture();
    try {
      const result = await runUpdateCommand(
        ["--dry-run", "--json"],
        {
          config: liveHost.state.config,
          configPath: "/tmp/config.toml",
          cliEntryPath: "/repo/apps/cli/dist/main.js",
        },
        {
          probes: [fixture.probe],
          hostDeps: liveHost.hostDeps,
          buildInfo: testBuildInfo,
        },
      );

      expect(result.output).toMatchObject({
        status: "planned",
        steps: [
          { id: "detect", status: "completed" },
          { id: "plan", status: "completed" },
          {
            id: "apply",
            status: "deferred",
            command: ["/opt/npm", "install", "--global", "station@1.1.0"],
          },
          { id: "observer-restart", status: "skipped" },
          {
            id: "host-handoff",
            status: "skipped",
            detail: "No live Host handoff is needed.",
          },
        ],
      });
      expect(fixture.apply).not.toHaveBeenCalled();
      expect(liveHost.clientFactory).not.toHaveBeenCalled();
    } finally {
      await liveHost.close();
    }
  });

  it("describes driven package-manager mutation in previews", async () => {
    const fixture = probeFixture("mise", {
      managerCommand: ["/opt/mise", "upgrade", "station"],
    });
    const result = await runUpdateCommand(
      ["--dry-run", "--drive-package-manager", "--json"],
      commandOptions(),
      { probes: [fixture.probe], buildInfo: testBuildInfo },
    );

    expect(result.output).toMatchObject({
      status: "planned",
      steps: [
        { id: "detect", status: "completed" },
        { id: "plan", status: "completed" },
        {
          id: "apply",
          status: "planned",
          command: ["/opt/mise", "upgrade", "station"],
        },
        { id: "observer-restart", status: "planned" },
        { id: "host-handoff", status: "skipped" },
      ],
    });
    expect(fixture.apply).not.toHaveBeenCalled();
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
        args: [
          "exec",
          "--",
          "stn",
          "--config",
          "/tmp/config.toml",
          "observer",
          "restart",
          "--timeout-ms",
          "20000",
        ],
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
      recoveryCommands: [
        [
          "/opt/stn",
          "--config",
          "/tmp/config.toml",
          "observer",
          "restart",
          "--timeout-ms",
          "20000",
        ],
      ],
    });
  });

  it("retains the generic retry command when another channel apply fails", async () => {
    const fixture = probeFixture("installer-binary");
    fixture.apply.mockRejectedValueOnce(new Error("apply failed"));
    const result = await runUpdateCommand(
      ["--channel", "installer-binary", "--handoff=screen", "--json"],
      commandOptions(),
      {
        probes: [fixture.probe],
        buildInfo: testBuildInfo,
      },
    );

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        recoveryCommands: [
          [
            "/opt/stn",
            "--config",
            "/tmp/config.toml",
            "update",
            "--channel",
            "installer-binary",
            "--handoff=screen",
          ],
        ],
        steps: [
          { id: "detect", status: "completed" },
          { id: "plan", status: "completed" },
          { id: "apply", status: "failed" },
          { id: "observer-restart", status: "skipped" },
          { id: "host-handoff", status: "skipped" },
        ],
      },
    });
  });

  it("renders every dev-checkout preparation recovery command in JSON and text", async () => {
    const recoveryCommands: UpdateCommandArgv[] = [
      ["/opt/pnpm", "--dir", "/repo", "install", "--frozen-lockfile"],
      ["/opt/bun", "--cwd", "/repo/station", "install", "--frozen-lockfile"],
      ["/opt/pnpm", "--dir", "/repo", "build"],
      ["/opt/bun", "run", "--cwd", "/repo/station", "link:station"],
      ["/opt/bun", "run", "--cwd", "/repo/station", "repair:node-pty"],
      ["/opt/pnpm", "--dir", "/repo", "station:link"],
    ];
    const preparationFailure = {
      tag: "UpdateError",
      code: "UPDATE_DEV_CHECKOUT_PREPARE_FAILED",
      message: "The development checkout could not be prepared.",
    };
    const fixture = probeFixture("dev-checkout", {
      applyRecoveryCommands: () => recoveryCommands,
    });
    fixture.apply.mockRejectedValue(preparationFailure);

    const json = await runUpdateCommand(["--channel", "dev-checkout", "--json"], commandOptions(), {
      probes: [fixture.probe],
      buildInfo: testBuildInfo,
    });
    const text = await runUpdateCommand(["--channel", "dev-checkout"], commandOptions(), {
      probes: [fixture.probe],
      buildInfo: testBuildInfo,
    });

    expect(json).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_DEV_CHECKOUT_PREPARE_FAILED" },
        recoveryCommands,
      },
    });
    expect(text).toMatchObject({ code: 1, outputFormat: "text" });
    for (const command of [
      "/opt/pnpm --dir /repo install --frozen-lockfile",
      "/opt/bun --cwd /repo/station install --frozen-lockfile",
      "/opt/pnpm --dir /repo build",
      "/opt/bun run --cwd /repo/station link:station",
      "/opt/bun run --cwd /repo/station repair:node-pty",
      "/opt/pnpm --dir /repo station:link",
    ]) {
      expect(text.output).toContain(command);
    }
  });

  it("restarts the Observer before the default processes Host handoff", async () => {
    const liveHost = await createLiveHostFixture();
    const fixture = probeFixture("installer-binary");
    const commands: ExternalCommandInput[] = [];
    try {
      const result = await runUpdateCommand(
        ["--json"],
        liveHostCommandOptions(liveHost.state.config),
        {
          probes: [fixture.probe],
          buildInfo: testBuildInfo,
          hostDeps: liveHost.hostDeps,
          commandRunner: async (input) => {
            commands.push(input);
            return commandResult(input);
          },
        },
      );

      expect(result.output).toMatchObject({ status: "updated" });
      expect(commands.map(({ args }) => args)).toEqual([
        ["--config", "/tmp/config.toml", "observer", "restart", "--timeout-ms", "20000"],
        ["--config", "/tmp/config.toml", "host", "handoff", "--fidelity", "processes"],
      ]);
    } finally {
      await liveHost.close();
    }
  });

  it("fails closed by default while --no-handoff skips Host preflight with a warning", async () => {
    const liveHost = await createLiveHostFixture({
      listError: new Error("inventory unavailable"),
    });
    const fixture = probeFixture("installer-binary");
    try {
      await expect(
        runUpdateCommand(["--json"], liveHostCommandOptions(liveHost.state.config), {
          probes: [fixture.probe],
          buildInfo: testBuildInfo,
          hostDeps: liveHost.hostDeps,
        }),
      ).rejects.toMatchObject({ code: "UPDATE_HOST_HANDOFF_PREFLIGHT_FAILED" });
      expect(fixture.apply).not.toHaveBeenCalled();
      liveHost.clientFactory.mockClear();

      const result = await runUpdateCommand(
        ["--no-handoff"],
        liveHostCommandOptions(liveHost.state.config),
        {
          probes: [fixture.probe],
          buildInfo: testBuildInfo,
          hostDeps: liveHost.hostDeps,
          commandRunner: async (input) => commandResult(input),
        },
      );
      expect(result.output).toContain(
        "warning: Host handoff was disabled; the next TUI may refuse the incumbent Host.",
      );
      expect(liveHost.clientFactory).not.toHaveBeenCalled();
    } finally {
      await liveHost.close();
    }
  });

  it("retains a recovery command when Host handoff fails after Observer crossover", async () => {
    const liveHost = await createLiveHostFixture();
    const fixture = probeFixture("installer-binary");
    let commandCount = 0;
    try {
      const result = await runUpdateCommand(
        ["--handoff=screen", "--json"],
        {
          config: liveHost.state.config,
          configPath: "/tmp/config.toml",
          cliEntryPath: "/repo/apps/cli/dist/main.js",
        },
        {
          probes: [fixture.probe],
          buildInfo: testBuildInfo,
          hostDeps: liveHost.hostDeps,
          commandRunner: async (input) => {
            commandCount += 1;
            if (commandCount === 2) throw new Error("handoff failed");
            return commandResult(input);
          },
        },
      );

      expect(result).toMatchObject({
        code: 1,
        output: {
          status: "failed",
          recoveryCommands: [
            ["/opt/stn", "--config", "/tmp/config.toml", "host", "handoff", "--fidelity", "screen"],
          ],
          steps: [
            { id: "detect", status: "completed" },
            { id: "plan", status: "completed" },
            { id: "apply", status: "completed" },
            { id: "observer-restart", status: "completed" },
            { id: "host-handoff", status: "failed" },
          ],
        },
      });
    } finally {
      await liveHost.close();
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
    for (const args of [
      ["--handoff", "--handoff"],
      ["--no-handoff", "--no-handoff"],
      ["--handoff", "--no-handoff"],
    ]) {
      await expect(runUpdateCommand(args, commandOptions())).rejects.toThrow(
        "Host handoff may be configured only once",
      );
    }
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

function liveHostCommandOptions(config: StationConfig) {
  return { config, configPath: "/tmp/config.toml", cliEntryPath: "/repo/apps/cli/dist/main.js" };
}

function probeFixture(
  channel: UpdateChannelId,
  overrides: {
    planStatus?: UpdatePlanBase["status"];
    managerCommand?: readonly [string, ...string[]];
    applyReport?: UpdateApplyReportBase;
    applyRecoveryCommands?: (error: unknown) => readonly UpdateCommandArgv[] | undefined;
  } = {},
) {
  const plan: UpdatePlanBase = {
    channel,
    status: overrides.planStatus ?? "update-available",
    currentVersion: "1.0.0",
    targetVersion: overrides.planStatus === "current" ? "1.0.0" : "1.1.0",
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
    detectAndPlan: async () => ({
      channel,
      plan,
      apply,
      ...(overrides.applyRecoveryCommands === undefined
        ? {}
        : { applyRecoveryCommands: overrides.applyRecoveryCommands }),
    }),
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

async function createLiveHostFixture(options: { listError?: Error } = {}) {
  const state = await createTempState();
  const socketPath = stationHostSocketPath(state.config);
  const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
  const clientFactory = vi.fn(
    () =>
      ({
        health: async () => ({
          ok: true,
          protocolVersion: HOST_PROTOCOL_VERSION,
          buildVersion: "1.0.0",
        }),
        list: async () => {
          if (options.listError !== undefined) throw options.listError;
          return [{ ptyId: "pty-1", pid: 42, alive: true }];
        },
        dispose: () => undefined,
      }) as never,
  );
  return {
    state,
    clientFactory,
    hostDeps: { clientFactory },
    close: () => server.close(),
  };
}
