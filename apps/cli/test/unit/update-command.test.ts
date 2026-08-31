import { type StationConfig, stationHostSocketPath } from "@station/config";
import { type ObserverLifecycleFailure, STATION_SCHEMA_VERSION } from "@station/contracts";
import { HOST_PROTOCOL_VERSION } from "@station/host";
import { listenUnixSocket } from "@station/protocol";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { createTempState } from "../../../../tests/support/temp-projects";
import { runUpdateCommand } from "../../src/commands/update.js";
import { selectUpdateChannel, type UpdateChannelProbe } from "../../src/update/channelDetection.js";
import {
  runUpdateRecoveryPreflight,
  type UpdateRecoveryPreflightPorts,
} from "../../src/update/recoveryPreflight.js";
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
const higherObserverBuildVersion = `2.0.0+station.${"b".repeat(64)}`;

describe("stn update command", () => {
  it("rejects non-dry-run --reap before update detection or mutation", async () => {
    const detectAndPlan = vi.fn();

    await expect(
      runUpdateCommand(["--reap"], commandOptions(), {
        probes: [{ channel: "installer-binary", detectAndPlan }],
      }),
    ).rejects.toThrow("Use --dry-run --reap");
    expect(detectAndPlan).not.toHaveBeenCalled();
  });

  it("emits one current convergence report without applying or crossing runtimes", async () => {
    const fixture = probeFixture("installer-binary");
    const recovery = recoveryPreflightFixture();
    const commandRunner = vi.fn();

    const result = await runUpdateCommand(["--dry-run", "--reap", "--json"], commandOptions(), {
      probes: [fixture.probe],
      commandRunner,
      buildInfo: testBuildInfo,
      recoveryPreflight: recovery.run,
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        schemaVersion: 4,
        kind: "preview",
        plan: { outcome: "reap-required" },
        initial: {
          boundary: {
            authorization: "none",
            actions: "not-included",
            digest: "not-included",
          },
          hooks: [{ provider: "codex", status: "needs-repair" }],
          terminalDispositions: [
            {
              terminalTargetId: "public-terminal-target-00000001",
              handoff: "non-preservable",
              reapRecovery: "non-resumable",
              reasons: ["session_non_resumable"],
            },
          ],
          evidenceComplete: true,
        },
      },
    });
    expect(recovery.inspectObserver).toHaveBeenCalledOnce();
    expect(recovery.inspectHost).toHaveBeenCalledOnce();
    expect(recovery.readHookHealth).toHaveBeenCalledOnce();
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(commandRunner).not.toHaveBeenCalled();
    const serialized = JSON.stringify(result.output);
    expect(serialized).not.toContain("selectedHandleId");
    expect(serialized).not.toContain("recoveryHandles");
  });

  it("keeps a current-build dry-run reap non-mutating and textually unmistakable", async () => {
    const fixture = probeFixture("installer-binary", { planStatus: "current" });
    const commandRunner = vi.fn();

    const result = await runUpdateCommand(
      ["--dry-run", "--reap", "--no-handoff"],
      commandOptions(),
      {
        probes: [fixture.probe],
        commandRunner,
        buildInfo: testBuildInfo,
        recoveryPreflight: previewPreflight("leave-in-place"),
      },
    );

    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    expect(result.output).toContain("No actions executed");
    expect(result.output).toContain("outcome: intentionally incomplete (--no-handoff)");
    expect(result.output).toContain("recovery: evidence=complete; authorization=none");
    expect(result.output).toContain("terminals: none");
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("reports blocked convergence without calling mutating capabilities", async () => {
    const fixture = probeFixture("installer-binary");
    const buildInfo = vi.fn(testBuildInfo);
    const commandRunner = vi.fn();
    const recoveryPreflight = previewPreflight("blocked");
    const result = await runUpdateCommand(["--dry-run", "--json"], commandOptions(), {
      probes: [fixture.probe],
      buildInfo,
      commandRunner,
      recoveryPreflight,
    });

    expect(result).toMatchObject({
      code: 1,
      output: { kind: "preview", plan: { outcome: "blocked" } },
    });
    expect(buildInfo).toHaveBeenCalledOnce();
    expect(recoveryPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ currentBuildInfo: testBuildInfo() }),
    );
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it("converges an already-current installation without misreporting a higher accepted Observer", async () => {
    const fixture = probeFixture("installer-binary", { planStatus: "current" });
    const liveHost = await createLiveHostFixture();
    const commandRunner = vi.fn(async (input: ExternalCommandInput) =>
      commandResult(input, higherObserverBuildVersion),
    );
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
          schemaVersion: 4,
          kind: "result",
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
            {
              id: "hook-reconciliation",
              status: "completed",
              detail: "Configured provider hooks are healthy.",
            },
            {
              id: "observer-restart",
              status: "completed",
              detail: "The accepted Observer singleton is running.",
            },
            {
              id: "host-handoff",
              status: "skipped",
              detail: "No live Host handoff is needed.",
            },
          ],
          warnings: [],
          recoveryCommands: [],
          hookReconciliation: {
            provider: "codex",
            status: "healthy",
            changed: false,
            verified: true,
          },
        },
      });
      expect(fixture.apply).not.toHaveBeenCalled();
      expect(commandRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "/opt/stn",
          args: ["--config", "/tmp/config.toml", "hooks", "reconcile", "codex"],
        }),
      );
      expect(commandRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "/opt/stn",
          args: ["--config", "/tmp/config.toml", "observer", "start", "--timeout-ms", "20000"],
        }),
      );
      expect(liveHost.clientFactory).toHaveBeenCalled();
    } finally {
      await liveHost.close();
    }
  });

  it("keeps an already-current dry-run free of hook, Observer, and Host effects", async () => {
    const fixture = probeFixture("installer-binary", { planStatus: "current" });
    const liveHost = await createLiveHostFixture({ listError: new Error("must not inspect Host") });
    const commandRunner = vi.fn();
    try {
      const result = await runUpdateCommand(
        ["--dry-run", "--json"],
        liveHostCommandOptions(liveHost.state.config),
        {
          probes: [fixture.probe],
          commandRunner,
          buildInfo: testBuildInfo,
          hostDeps: liveHost.hostDeps,
          recoveryPreflight: previewPreflight("converged"),
        },
      );

      expect(result).toMatchObject({
        code: 0,
        output: {
          schemaVersion: 4,
          kind: "preview",
          plan: { outcome: "converged" },
        },
      });
      expect(fixture.apply).not.toHaveBeenCalled();
      expect(commandRunner).not.toHaveBeenCalled();
      expect(liveHost.clientFactory).not.toHaveBeenCalled();
    } finally {
      await liveHost.close();
    }
  });

  it("finishes an interrupted current-build crossover through the current launcher", async () => {
    const fixture = probeFixture("installer-binary", { planStatus: "current" });
    const liveHost = await createLiveHostFixture({ hostBuildVersion: "0.9.0" });
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

      expect(result.output).toMatchObject({
        status: "current",
        steps: [
          { id: "detect", status: "completed" },
          { id: "plan", status: "completed" },
          { id: "apply", status: "skipped" },
          { id: "hook-reconciliation", status: "completed" },
          { id: "observer-restart", status: "completed" },
          { id: "host-handoff", status: "completed" },
        ],
      });
      expect(commands.map(({ args }) => args)).toEqual([
        ["--config", "/tmp/config.toml", "hooks", "reconcile", "codex"],
        ["--config", "/tmp/config.toml", "observer", "start", "--timeout-ms", "20000"],
        ["--config", "/tmp/config.toml", "host", "handoff", "--fidelity", "processes"],
      ]);
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
      recoveryPreflight: previewPreflight("absent"),
    });

    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({
      schemaVersion: 4,
      kind: "preview",
      channel: "installer-binary",
      current: { version: "1.0.0" },
      target: { version: "1.1.0" },
      plan: { outcome: "actionable", phases: { artifactApplication: { action: "apply" } } },
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
          recoveryPreflight: previewPreflight("absent"),
        },
      );

      expect(result.output).toMatchObject({
        kind: "preview",
        plan: {
          outcome: "deferred",
          phases: {
            artifactApplication: {
              action: "defer",
              command: {
                kind: "manager",
                argv: ["/opt/npm", "install", "--global", "station@1.1.0"],
              },
            },
          },
        },
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
      {
        probes: [fixture.probe],
        buildInfo: testBuildInfo,
        recoveryPreflight: previewPreflight("absent"),
      },
    );

    expect(result.output).toMatchObject({
      kind: "preview",
      plan: {
        outcome: "actionable",
        phases: {
          artifactApplication: {
            action: "apply",
            command: { kind: "manager", argv: ["/opt/mise", "upgrade", "station"] },
          },
        },
      },
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

    expect(result.output).toMatchObject({
      status: "updated",
      steps: expect.arrayContaining([
        {
          id: "observer-restart",
          status: "completed",
          detail: "The Observer is running from the selected build.",
        },
      ]),
    });
    expect(fixture.apply).toHaveBeenCalledWith({ drivePackageManager: true });
    expect(commands).toEqual([
      expect.objectContaining({
        command: "/opt/mise",
        args: ["exec", "--", "stn", "--config", "/tmp/config.toml", "hooks", "reconcile", "codex"],
      }),
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

  it("stops successor crossover when configured hook reconciliation fails", async () => {
    const fixture = probeFixture("installer-binary");
    const commands: ExternalCommandInput[] = [];
    const result = await runUpdateCommand(["--json"], commandOptions(), {
      probes: [fixture.probe],
      buildInfo: testBuildInfo,
      commandRunner: async (input) => {
        commands.push(input);
        return {
          command: input.command,
          args: input.args ?? [],
          stdout: JSON.stringify({
            provider: "codex",
            status: "post-write-doctor-failed",
            changed: true,
            verified: false,
            error: {
              tag: "CodexHookSetupError",
              code: "CODEX_HOOK_POST_WRITE_DOCTOR_FAILED",
              message: "Codex hook writes were not verified by provider doctor.",
              provider: "codex",
            },
            followUp: { action: "run-doctor" },
          }),
          stderr: "/resolved/provider/path and raw provider payload",
          exitCode: 1,
        };
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      args: ["--config", "/tmp/config.toml", "hooks", "reconcile", "codex"],
    });
    expect(result).toMatchObject({
      code: 1,
      output: {
        schemaVersion: 4,
        kind: "result",
        status: "failed",
        hookReconciliation: {
          status: "post-write-doctor-failed",
          changed: true,
          verified: false,
          followUp: { action: "run-doctor" },
        },
        error: { code: "CODEX_HOOK_POST_WRITE_DOCTOR_FAILED" },
        recoveryCommands: [
          ["/opt/stn", "--config", "/tmp/config.toml", "hooks", "doctor", "codex"],
          ["/opt/stn", "--config", "/tmp/config.toml", "hooks", "reconcile", "codex"],
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
        steps: [
          { id: "detect", status: "completed" },
          { id: "plan", status: "completed" },
          { id: "apply", status: "completed" },
          { id: "hook-reconciliation", status: "failed" },
          { id: "observer-restart", status: "skipped" },
          { id: "host-handoff", status: "skipped" },
        ],
      },
    });
    expect(JSON.stringify(result.output)).not.toContain("/resolved/provider/path");
  });

  it("reports but never executes explicit takeover while resuming a current build", async () => {
    const fixture = probeFixture("installer-binary", { planStatus: "current" });
    const commands: ExternalCommandInput[] = [];
    const result = await runUpdateCommand(["--no-handoff", "--json"], commandOptions(), {
      probes: [fixture.probe],
      buildInfo: testBuildInfo,
      commandRunner: async (input) => {
        commands.push(input);
        return {
          command: input.command,
          args: input.args ?? [],
          stdout: JSON.stringify({
            provider: "codex",
            status: "ownership-conflict",
            changed: false,
            verified: false,
            followUp: { action: "run-explicit-takeover" },
          }),
          stderr: "",
          exitCode: 1,
        };
      },
    });

    expect(commands.map(({ args }) => args)).toEqual([
      ["--config", "/tmp/config.toml", "hooks", "reconcile", "codex"],
    ]);
    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_HOOK_OWNERSHIP_CONFLICT" },
        recoveryCommands: [
          [
            "/opt/stn",
            "--config",
            "/tmp/config.toml",
            "hooks",
            "install",
            "codex",
            "--yes",
            "--takeover",
          ],
          ["/opt/stn", "--config", "/tmp/config.toml", "hooks", "reconcile", "codex"],
          [
            "/opt/stn",
            "--config",
            "/tmp/config.toml",
            "observer",
            "start",
            "--timeout-ms",
            "20000",
          ],
        ],
      },
    });
  });

  it("describes current-build Observer convergence failures without claiming an install", async () => {
    const fixture = probeFixture("installer-binary", { planStatus: "current" });
    const result = await runUpdateCommand(["--no-handoff", "--json"], commandOptions(), {
      probes: [fixture.probe],
      buildInfo: testBuildInfo,
      commandRunner: async (input) => {
        if (input.args?.includes("hooks") === true) return commandResult(input);
        throw new Error("observer failed");
      },
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: {
          code: "UPDATE_RUNTIME_CROSSOVER_FAILED",
          message: "Station could not complete runtime convergence for the current build.",
        },
        recoveryCommands: [
          [
            "/opt/stn",
            "--config",
            "/tmp/config.toml",
            "observer",
            "start",
            "--timeout-ms",
            "20000",
          ],
        ],
      },
    });
    expect(JSON.stringify(result.output)).not.toContain("installed the new build");
  });

  it("retains the Observer and pending Host recovery sequence after install", async () => {
    const fixture = probeFixture("installer-binary");
    const liveHost = await createLiveHostFixture({ hostBuildVersion: "0.9.0" });
    try {
      const result = await runUpdateCommand(
        ["--json"],
        liveHostCommandOptions(liveHost.state.config),
        {
          probes: [fixture.probe],
          buildInfo: testBuildInfo,
          hostDeps: liveHost.hostDeps,
          commandRunner: async (input) => {
            if (input.args?.includes("hooks") === true) return commandResult(input);
            throw new Error("observer failed");
          },
        },
      );

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
          [
            "/opt/stn",
            "--config",
            "/tmp/config.toml",
            "host",
            "handoff",
            "--fidelity",
            "processes",
          ],
        ],
      });
    } finally {
      await liveHost.close();
    }
  });

  it("strictly retains a successor Observer lifecycle cause and startup evidence", async () => {
    const fixture = probeFixture("installer-binary");
    const lifecycleFailure: ObserverLifecycleFailure = {
      error: {
        tag: "ObserverStartupError",
        code: "OBSERVER_HANDOFF_REFUSED",
        message: "Observer build handoff was refused.",
      },
      cause: {
        tag: "ObserverProcessIdentityError",
        code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
        message: "Observer executable arguments did not match.",
      },
      startupEvidence: {
        bootLogPath: "/tmp/station/logs/observer-boot.log",
        bootLogTail: "replacement refused",
      },
    };
    const result = await runUpdateCommand(["--json"], commandOptions(), {
      probes: [fixture.probe],
      buildInfo: testBuildInfo,
      commandRunner: async (input) => {
        if (input.args?.includes("hooks") === true) return commandResult(input);
        return {
          command: input.command,
          args: input.args ?? [],
          stdout: JSON.stringify({
            status: "unhealthy",
            paths: observerCommandPaths(),
            ...lifecycleFailure,
          }),
          stderr: "",
          exitCode: 1,
        };
      },
    });

    expect(result).toMatchObject({
      code: 1,
      output: {
        status: "failed",
        error: { code: "UPDATE_RUNTIME_CROSSOVER_FAILED" },
        cause: { code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH" },
        startupEvidence: lifecycleFailure.startupEvidence,
      },
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
          { id: "hook-reconciliation", status: "skipped" },
          { id: "observer-restart", status: "skipped" },
          { id: "host-handoff", status: "skipped" },
        ],
      },
    });
  });

  it("renders every dev-checkout preparation recovery command in JSON and text", async () => {
    const recoveryCommands: UpdateCommandArgv[] = [
      ["/opt/bun", "install", "--cwd", "/repo", "--frozen-lockfile"],
      ["/opt/bun", "run", "--cwd", "/repo", "build"],
      ["/opt/bun", "run", "--cwd", "/repo/station", "repair:node-pty"],
      ["/opt/bun", "run", "--cwd", "/repo", "station:link"],
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
      "/opt/bun install --cwd /repo --frozen-lockfile",
      "/opt/bun run --cwd /repo build",
      "/opt/bun run --cwd /repo/station repair:node-pty",
      "/opt/bun run --cwd /repo station:link",
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
        ["--config", "/tmp/config.toml", "hooks", "reconcile", "codex"],
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
            if (commandCount === 3) throw new Error("handoff failed");
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
            { id: "hook-reconciliation", status: "completed" },
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
    const recoveryPreflight = previewPreflight("absent");
    await expect(
      runUpdateCommand(["--dry-run", "--drive-package-manager"], commandOptions(), {
        probes: [fixture.probe],
        buildInfo: testBuildInfo,
        recoveryPreflight,
      }),
    ).rejects.toMatchObject({ code: "UPDATE_FLAG_INVALID" });
    expect(recoveryPreflight).not.toHaveBeenCalled();
    expect(fixture.apply).not.toHaveBeenCalled();
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

function previewPreflight(kind: "absent" | "converged" | "blocked" | "leave-in-place") {
  return vi.fn(
    async ({
      installed,
      target,
      currentBuildInfo,
    }: Parameters<NonNullable<Parameters<typeof runUpdateCommand>[2]["recoveryPreflight"]>>[0]) => {
      const hooks =
        kind === "blocked"
          ? [
              {
                provider: "codex" as const,
                status: "ownership-conflict" as const,
                ownership: "different-owner" as const,
                followUp: { action: "run-explicit-takeover" as const },
              },
            ]
          : [{ provider: "codex" as const, status: "healthy" as const }];
      if (kind === "absent" || kind === "blocked") {
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
          hookProviderIds: ["codex" as const],
          hooks,
          terminalDispositions: [],
          evidenceComplete: false,
        };
      }
      return {
        schemaVersion: 1 as const,
        boundary: {
          authorization: "none" as const,
          actions: "not-included" as const,
          digest: "not-included" as const,
        },
        installed,
        target,
        observer: {
          status: "exact" as const,
          buildVersion: `1.0.0+station.${currentBuildInfo.buildIdentity}`,
          relation: "matching-target" as const,
          health: "healthy" as const,
          recovery: {
            status: "assessed" as const,
            assessment: {
              schemaVersion: 1 as const,
              resumeEnabled: true,
              providerCapabilities: [],
              sessions: [],
            },
          },
        },
        host: {
          status: "inspected" as const,
          buildVersion: kind === "leave-in-place" ? "0.9.0" : target.version,
          buildIdentity:
            kind === "leave-in-place" ? "b".repeat(64) : currentBuildInfo.buildIdentity,
          protocolVersion: HOST_PROTOCOL_VERSION,
          relation:
            kind === "leave-in-place" ? ("different" as const) : ("matching-target" as const),
          compatibility: kind === "leave-in-place" ? ("replace" as const) : ("reuse" as const),
          terminals: [],
        },
        hookProviderIds: ["codex" as const],
        hooks,
        terminalDispositions: [],
        evidenceComplete: true,
      };
    },
  );
}

function recoveryPreflightFixture() {
  const inspectObserver = vi.fn(async () => ({
    status: "exact" as const,
    buildVersion: "1.0.0+station.observer",
    relation: "different" as const,
    health: "healthy" as const,
    recovery: {
      status: "assessed" as const,
      assessment: {
        schemaVersion: 1 as const,
        resumeEnabled: true,
        providerCapabilities: [{ provider: "codex", status: "enabled" as const }],
        sessions: [
          {
            sessionId: "session-a",
            projectId: "project-a",
            worktreeId: "worktree-a",
            lifecycle: "open" as const,
            harnessProvider: "codex",
            disposition: "non-resumable" as const,
            reasons: ["no_recovery_handles" as const],
            handleResolution: {
              kind: "none" as const,
              eligibleHandleCount: 0 as const,
              rejectedHandleCount: 0,
              reasons: ["no_recovery_handles" as const],
            },
          },
        ],
      },
    },
  }));
  const inspectHost = vi.fn(async () => ({
    status: "inspected" as const,
    buildVersion: "1.0.0+station.host",
    buildIdentity: "b".repeat(64),
    protocolVersion: HOST_PROTOCOL_VERSION,
    relation: "different" as const,
    compatibility: "replace" as const,
    terminals: [
      {
        kind: "agent" as const,
        terminalTargetId: "terminal-a",
        ptyId: "pty-a",
        ptyInstanceId: "pty-instance-a",
        projectId: "project-a",
        worktreeId: "worktree-a",
        sessionId: "session-a",
        harnessProvider: "codex",
        alive: true,
        handoffSupport: "non-releasable" as const,
      },
    ],
  }));
  const readHookHealth = vi.fn(async () => ({
    provider: "codex",
    status: "needs-repair" as const,
    reason: "owned-drift" as const,
  }));
  const ports: UpdateRecoveryPreflightPorts = {
    inspectObserver,
    inspectHost,
    readHookHealth,
    hookProviderIds: ["codex"],
  };
  const run = (input: Omit<Parameters<typeof runUpdateRecoveryPreflight>[0], "ports">) =>
    runUpdateRecoveryPreflight({ ...input, ports });
  return { run, inspectObserver, inspectHost, readHookHealth };
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

function commandResult(
  input: ExternalCommandInput,
  observerVersion?: string,
): ExternalCommandResult {
  const hookReconciliation =
    input.args?.includes("hooks") === true && input.args.includes("reconcile");
  const observerCrossover =
    input.args?.includes("observer") === true &&
    (input.args.includes("start") || input.args.includes("restart"));
  return {
    command: input.command,
    args: input.args ?? [],
    stdout: hookReconciliation
      ? JSON.stringify({
          provider: "codex",
          status: "healthy",
          changed: false,
          verified: true,
        })
      : observerCrossover
        ? JSON.stringify({
            status: "running",
            socketPath: config.observer.socketPath,
            health: {
              schemaVersion: STATION_SCHEMA_VERSION,
              status: "healthy",
              ...(observerVersion === undefined ? {} : { version: observerVersion }),
            },
          })
        : "",
    stderr: "",
    exitCode: 0,
  };
}

function observerCommandPaths() {
  const stateDir = "/tmp/station";
  return {
    stateDir,
    socketPath: `${stateDir}/run/observer.sock`,
    dbPath: `${stateDir}/observer.sqlite`,
    logDir: `${stateDir}/logs`,
    diagnosticsDir: `${stateDir}/diagnostics`,
    hookSpoolDir: `${stateDir}/spool/hooks`,
  };
}

async function createLiveHostFixture(
  options: { listError?: Error; hostBuildVersion?: string } = {},
) {
  const state = await createTempState();
  const socketPath = stationHostSocketPath(state.config);
  const server = await listenUnixSocket({ socketPath, onConnection: () => undefined });
  const clientFactory = vi.fn(async () => {
    if (options.listError !== undefined) {
      return {
        status: "unknown" as const,
        reason: "inventory-failed" as const,
        error: {
          tag: "TerminalProviderError",
          code: "HOST_REQUEST_FAILED",
          message: options.listError.message,
        },
      };
    }
    return {
      status: "exact" as const,
      evidence: {
        endpoint: { socketPath, ino: 1n, birthtimeNs: 1n },
        health: {
          ok: true as const,
          protocolVersion: HOST_PROTOCOL_VERSION,
          buildVersion: options.hostBuildVersion ?? "1.0.0",
        },
        buildIdentity: "a".repeat(64),
        terminals: [
          {
            kind: "agent" as const,
            terminalTargetId: "target-1",
            ptyId: "pty-1",
            ptyInstanceId: "instance-1",
            worktreeId: "worktree-1",
            projectId: "project-1",
            sessionId: "session-1",
            worktreePath: "/repo/one",
            harnessProvider: "codex",
            pid: 42,
            alive: true,
            cols: 80,
            rows: 24,
            handoffSupport: { kind: "bridge-releasable" as const },
          },
        ],
      },
    };
  });
  return {
    state,
    clientFactory,
    hostDeps: { inspectHost: clientFactory, expectedBuildIdentity: "a".repeat(64) },
    close: () => server.close(),
  };
}
