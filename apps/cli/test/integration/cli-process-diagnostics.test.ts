import { join } from "node:path";
import { ConfigError, loadConfig, resolveObserverPaths, type StationConfig } from "@station/config";
import type { CommandReceipt, CommandRecord, LogRecord, StationCommand } from "@station/contracts";
import { LogRecordSchema } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import type { CliProcessDeps } from "../../src/cliProcessTypes.js";
import type { CliRunOptions } from "../../src/cliTypes.js";
import { runCli, runCliMain } from "../../src/main.js";

const now = new Date("2026-08-27T12:00:00.000Z");
const invocationId = "11111111-1111-4111-8111-111111111111";
const buildInfo = {
  version: "0.7.0",
  compiled: false,
  buildIdentity: "a".repeat(64),
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI process diagnostics", () => {
  it("keeps help, version, and direct runCli config- and diagnostics-free by default", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const load = vi.fn(async () => {
      throw new Error("help and version must not load config");
    });
    const createLogger = vi.fn(() => memoryLogger([]));
    const spawnObserver = vi.fn();

    for (const argv of [["--config", configPath, "--help"], ["--version"]]) {
      const capture = processCapture();
      await runCliMain(argv, {
        observerDeps: { spawnObserver },
        updateDeps: { currentBuildInfo: buildInfo },
        cliProcessDeps: { ...capture.deps, loadConfig: load, createLogger },
      });
      expect(capture.code()).toBe(0);
    }

    await runCli(["--config", configPath, "project", "list"], {
      cliProcessDeps: { createLogger },
    });

    expect(load).not.toHaveBeenCalled();
    expect(spawnObserver).not.toHaveBeenCalled();
    expect(createLogger).not.toHaveBeenCalled();
  });

  it("traces help and version only under the exact opt-in without loading config", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const load = vi.fn(async () => {
      throw new Error("trace-only help and version must not load config");
    });
    const spawnObserver = vi.fn();

    for (const testCase of [
      { argv: ["--config", configPath, "--help"], route: ["help"] },
      { argv: ["--version"], route: ["version"] },
    ]) {
      const records: LogRecord[] = [];
      const capture = processCapture();
      await runCliMain(testCase.argv, {
        env: { STATION_CLI_TRACE: "1" },
        observerDeps: { spawnObserver },
        updateDeps: { currentBuildInfo: buildInfo },
        cliProcessDeps: {
          ...capture.deps,
          loadConfig: load,
          resolveObserverPaths: (config) => resolveObserverPaths(config, fixture.root),
          createLogger: () => memoryLogger(records),
        },
      });

      expect(records.map((record) => record.message)).toEqual([
        "cli.process.trace.start",
        "cli.process.trace.outcome",
      ]);
      expect(records[0]?.attributes).toMatchObject({ route: testCase.route });
      expect(capture.code()).toBe(0);
    }

    expect(load).not.toHaveBeenCalled();
    expect(spawnObserver).not.toHaveBeenCalled();
  });

  it("does not duplicate successful reads or accepted Observer mutations by default", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const records: LogRecord[] = [];
    const createLogger = vi.fn(() => memoryLogger(records));

    const readCapture = processCapture();
    await runCliMain(["--config", configPath, "project", "list"], {
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: { ...readCapture.deps, createLogger },
    });

    const dispatch = vi.fn(async () => acceptedReceipt("cmd_accepted"));
    const mutationCapture = processCapture();
    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(reconcileCommand("accepted")),
      env: { STATION_CLI_TRACE: "true" },
      observerDeps: runningObserverDeps(fixture.socketPath, dispatch),
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: { ...mutationCapture.deps, createLogger },
    });

    expect(readCapture.code()).toBe(0);
    expect(mutationCapture.code()).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const completedCapture = processCapture();
    const completedCommand = reconcileCommand("completed");
    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin", "--wait"], {
      stdin: JSON.stringify(completedCommand),
      observerDeps: runningObserverDeps(
        fixture.socketPath,
        async () => acceptedReceipt("cmd_completed"),
        async () => terminalRecord("cmd_completed", completedCommand, "succeeded"),
      ),
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: { ...completedCapture.deps, createLogger },
    });

    expect(completedCapture.code()).toBe(0);
    expect(createLogger).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it("emits exact opt-in start and outcome around command side effects", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const records: LogRecord[] = [];
    const order: string[] = [];
    const capture = processCapture();
    const dispatch = vi.fn(async () => {
      order.push("dispatch");
      return acceptedReceipt("cmd_traced");
    });

    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(reconcileCommand("trace")),
      env: {
        STATION_CLI_TRACE: "1",
        TMUX: "tmux-secret-value",
        TMUX_PANE: "pane-secret-value",
      },
      observerDeps: runningObserverDeps(fixture.socketPath, dispatch),
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: {
        ...capture.deps,
        createLogger: () =>
          memoryLogger(records, (record) => {
            order.push(record.message);
          }),
      },
    });

    expect(order).toEqual(["cli.process.trace.start", "dispatch", "cli.process.trace.outcome"]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      level: "debug",
      message: "cli.process.trace.start",
      attributes: {
        invocationId,
        route: ["command", "dispatch"],
        argumentCount: 3,
        hasStdin: true,
        tmux: true,
        tmuxPane: true,
      },
    });
    expect(records[1]).toMatchObject({
      level: "debug",
      message: "cli.process.trace.outcome",
      commandId: "cmd_traced",
      traceId: "trc_process",
      attributes: { invocationId, durationMs: 0, exitCode: 0 },
    });
    expect(capture.code()).toBe(0);
    expect(capture.stderr()).toBe("");
  });

  it("records parse, config, routing, and output failures without raw messages", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const cases: Array<{
      argv: string[];
      configure?: (capture: ReturnType<typeof processCapture>) => CliRunOptions;
      expectedCode: string;
    }> = [
      {
        argv: ["--config"],
        expectedCode: "CLI_OPTION_VALUE_REQUIRED",
      },
      {
        argv: ["secret-unknown-command"],
        expectedCode: "CLI_PROCESS_FAILURE",
      },
      {
        argv: ["--config", join(fixture.root, "missing.toml"), "project", "list"],
        configure: () => ({
          cliProcessDeps: {
            loadConfig: async () => {
              throw new ConfigError({
                code: "CONFIG_FILE_NOT_FOUND",
                message: "config contains CONFIG_SECRET_VALUE",
                configPath: join(fixture.root, "CONFIG_SECRET_VALUE.toml"),
              });
            },
          },
        }),
        expectedCode: "CONFIG_FILE_NOT_FOUND",
      },
      {
        argv: ["--config", configPath, "project", "list"],
        configure: () => ({
          cliProcessDeps: {
            stdoutWrite: () => {
              throw new Error("stdout contains OUTPUT_SECRET_VALUE");
            },
          },
        }),
        expectedCode: "CLI_PROCESS_FAILURE",
      },
    ];

    for (const testCase of cases) {
      const records: LogRecord[] = [];
      const capture = processCapture();
      const configured = testCase.configure?.(capture) ?? {};
      await runCliMain(testCase.argv, {
        ...configured,
        updateDeps: { currentBuildInfo: buildInfo },
        cliProcessDeps: {
          ...capture.deps,
          ...configured.cliProcessDeps,
          resolveObserverPaths: (config) => resolveObserverPaths(config, fixture.root),
          createLogger: () => memoryLogger(records),
        },
      });

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        level: "error",
        message: "cli.process.failure",
        attributes: {
          error: {
            code: testCase.expectedCode,
            message: "CLI process failed.",
          },
          exitCode: 1,
        },
      });
      expect(JSON.stringify(records)).not.toMatch(/SECRET_VALUE|secret-unknown-command/);
      expect(capture.code()).toBe(1);
    }
  });

  it("records rejected receipts but not terminal command failures", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const rejectedRecords: LogRecord[] = [];
    const rejectedCapture = processCapture();

    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(reconcileCommand("rejected")),
      observerDeps: runningObserverDeps(fixture.socketPath, async () => rejectedReceipt()),
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: {
        ...rejectedCapture.deps,
        createLogger: () => memoryLogger(rejectedRecords),
      },
    });

    expect(rejectedRecords).toHaveLength(1);
    expect(rejectedRecords[0]).toMatchObject({
      level: "error",
      message: "cli.command.rejected",
      commandId: "cmd_rejected",
      traceId: "trc_process",
      attributes: {
        error: {
          tag: "CommandRejectedError",
          code: "COMMAND_REJECTED",
          message: "Observer rejected the CLI command.",
        },
      },
    });

    const outputFailureRecords: LogRecord[] = [];
    const outputFailureCapture = processCapture();
    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(reconcileCommand("rejected-output-failure")),
      observerDeps: runningObserverDeps(fixture.socketPath, async () => rejectedReceipt()),
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: {
        ...outputFailureCapture.deps,
        stdoutWrite: () => {
          throw new Error("rejected output failed");
        },
        createLogger: () => memoryLogger(outputFailureRecords),
      },
    });

    expect(outputFailureRecords).toHaveLength(1);
    expect(outputFailureRecords[0]).toMatchObject({
      message: "cli.process.failure",
      commandId: "cmd_rejected",
      traceId: "trc_process",
      attributes: {
        error: {
          tag: "CliProcessError",
          code: "CLI_PROCESS_FAILURE",
          message: "CLI process failed.",
        },
      },
    });

    const failedRecords: LogRecord[] = [];
    const failedCapture = processCapture();
    const command = reconcileCommand("failed");
    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin", "--wait"], {
      stdin: JSON.stringify(command),
      observerDeps: runningObserverDeps(
        fixture.socketPath,
        async () => acceptedReceipt("cmd_failed"),
        async () => terminalRecord("cmd_failed", command, "failed"),
      ),
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: {
        ...failedCapture.deps,
        createLogger: () => memoryLogger(failedRecords),
      },
    });

    expect(rejectedCapture.code()).toBe(1);
    expect(failedCapture.code()).toBe(1);
    expect(failedRecords).toEqual([]);
  });

  it("retains accepted command correlation for completion timeouts", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const records: LogRecord[] = [];
    const capture = processCapture();

    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin", "--wait"], {
      stdin: JSON.stringify(reconcileCommand("timeout")),
      observerDeps: runningObserverDeps(
        fixture.socketPath,
        async () => acceptedReceipt("cmd_timeout"),
        async () => {
          throw {
            tag: "TimeoutError",
            code: "PROTOCOL_COMMAND_WAIT_TIMEOUT",
            message: "timeout contains TIMEOUT_SECRET_VALUE",
          };
        },
      ),
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: {
        ...capture.deps,
        createLogger: () => memoryLogger(records),
      },
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      message: "cli.process.failure",
      commandId: "cmd_timeout",
      traceId: "trc_process",
      attributes: {
        error: {
          tag: "TimeoutError",
          code: "COMMAND_WAIT_TIMEOUT",
          message: "CLI process failed.",
        },
      },
    });
    expect(JSON.stringify(records)).not.toContain("TIMEOUT_SECRET_VALUE");
    expect(capture.code()).toBe(1);
  });

  it("preserves dispatch, output, and exit status when the configured logger fails", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const capture = processCapture();
    const dispatch = vi.fn(async () => acceptedReceipt("cmd_logger_failed"));
    const sinkPaths: string[] = [];

    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(reconcileCommand("logger-failure")),
      env: { STATION_CLI_TRACE: "1" },
      observerDeps: runningObserverDeps(fixture.socketPath, dispatch),
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: {
        ...capture.deps,
        createLogger: (options) => {
          sinkPaths.push(options.path);
          return rejectingLogger(options.path);
        },
      },
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(capture.code()).toBe(0);
    expect(capture.stdout()).toContain("cmd_logger_failed");
    expect(capture.stderr()).toBe("");
    expect(sinkPaths).toEqual([join(fixture.stateDir, "logs", "cli.jsonl")]);
  });

  it("uses the default sink for bootstrap failures and never falls back from a configured sink", async () => {
    const fixture = await createTempState();
    const configuredPath = await writeConfigToml(fixture.root, fixture.config);
    const bootstrapPaths: string[] = [];
    const bootstrapCapture = processCapture();

    await runCliMain(["--config", join(fixture.root, "missing.toml"), "project", "list"], {
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: {
        ...bootstrapCapture.deps,
        loadConfig: async () => {
          throw new ConfigError({
            code: "CONFIG_FILE_NOT_FOUND",
            message: "Missing config.",
            configPath: join(fixture.root, "missing.toml"),
          });
        },
        resolveObserverPaths: (config) => resolveObserverPaths(config, fixture.root),
        createLogger: (options) => {
          bootstrapPaths.push(options.path);
          return memoryLogger([]);
        },
      },
    });

    expect(bootstrapPaths).toEqual([
      join(fixture.root, ".local", "state", "station", "logs", "cli.jsonl"),
    ]);

    const configuredPaths: string[] = [];
    const configuredCapture = processCapture();
    await runCliMain(["--config", configuredPath, "project", "list"], {
      env: { STATION_CLI_TRACE: "1" },
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: {
        ...configuredCapture.deps,
        createLogger: (options) => {
          configuredPaths.push(options.path);
          throw new Error("configured sink unavailable");
        },
      },
    });

    expect(configuredPaths).toEqual([join(fixture.stateDir, "logs", "cli.jsonl")]);
    expect(configuredCapture.code()).toBe(0);
    expect(configuredCapture.stderr()).toBe("");
  });

  it("never retains argv, stdin, config-path, environment, error, or output secrets", async () => {
    const fixture = await createTempState();
    const sentinel = "CLI_PROCESS_SECRET_VALUE";
    const secretConfigPath = join(fixture.root, sentinel, "config.toml");
    const records: LogRecord[] = [];
    const capture = processCapture();
    const loaded = await loadConfig(await writeConfigToml(fixture.root, fixture.config));

    await runCliMain(["--config", secretConfigPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(reconcileCommand(sentinel)),
      env: {
        STATION_CLI_TRACE: "1",
        TMUX: sentinel,
        TMUX_PANE: sentinel,
        STATION_PRIVATE_VALUE: sentinel,
      },
      observerDeps: runningObserverDeps(fixture.socketPath, async () =>
        acceptedReceipt("cmd_secret_safe"),
      ),
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: {
        ...capture.deps,
        loadConfig: async () => loaded,
        createLogger: () => memoryLogger(records),
      },
    });

    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(records[0]).toMatchObject({
      attributes: {
        argumentCount: 3,
        hasStdin: true,
        tmux: true,
        tmuxPane: true,
      },
    });

    const outputRecords: LogRecord[] = [];
    const outputCapture = processCapture();
    const config = secretOutputConfig(fixture.config, sentinel);
    await runCliMain(["--config", secretConfigPath, "project", "list"], {
      env: { STATION_CLI_TRACE: "1" },
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: {
        ...outputCapture.deps,
        loadConfig: async () => ({ ...loaded, config, projects: config.projects }),
        createLogger: () => memoryLogger(outputRecords),
      },
    });

    expect(outputCapture.stdout()).toContain(sentinel);
    expect(JSON.stringify(outputRecords)).not.toContain(sentinel);
  });

  it("reuses Observer startup lifecycle evidence without a duplicate process failure", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const lifecycleRecords: LogRecord[] = [];
    const processRecords: LogRecord[] = [];
    const capture = processCapture();

    await runCliMain(
      ["--config", configPath, "command", "dispatch", "--stdin", "--timeout-ms", "1"],
      {
        stdin: JSON.stringify(reconcileCommand("startup-failure")),
        updateDeps: { currentBuildInfo: buildInfo },
        observerDeps: {
          buildVersion: "0.0.0",
          logger: memoryLogger(lifecycleRecords),
          spawnObserver: async () => ({ pid: 1234, unref: () => undefined }),
          clientFactory: () =>
            ({
              health: async () => {
                throw new Error("still down");
              },
            }) as never,
          sleep: async () => undefined,
        },
        cliProcessDeps: {
          ...capture.deps,
          createLogger: () => memoryLogger(processRecords),
        },
      },
    );

    expect(lifecycleRecords).toHaveLength(1);
    expect(lifecycleRecords[0]).toMatchObject({
      level: "error",
      message: "Observer lifecycle failed.",
    });
    expect(processRecords).toEqual([]);
    expect(capture.code()).toBe(1);
  });

  it("finds an opt-in invocation through debug logs without contacting Observer", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const capture = processCapture();

    await runCliMain(["--config", configPath, "project", "list"], {
      env: { STATION_CLI_TRACE: "1" },
      updateDeps: { currentBuildInfo: buildInfo },
      cliProcessDeps: capture.deps,
    });

    const clientFactory = vi.fn(() => {
      throw new Error("debug logs must not contact Observer");
    });
    const result = await runCli(
      ["--config", configPath, "debug", "logs", invocationId, "--component", "cli", "--json"],
      { observerDeps: { clientFactory } },
    );

    expect(result).toMatchObject({
      code: 0,
      output: {
        query: invocationId,
        components: ["cli"],
        matched: 2,
        records: [
          { level: "debug", message: "cli.process.trace.start" },
          { level: "debug", message: "cli.process.trace.outcome" },
        ],
      },
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });
});

function processCapture() {
  let exitCode: number | undefined;
  let stdout = "";
  let stderr = "";
  const deps: CliProcessDeps = {
    randomUUID: () => invocationId,
    clock: { now: () => now },
    stdoutWrite: (value) => {
      stdout += value;
    },
    stderrWrite: (value) => {
      stderr += value;
    },
    exit: (code) => {
      exitCode = code;
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  };
  return {
    deps,
    code: () => exitCode,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function memoryLogger(records: LogRecord[], onLog?: (record: LogRecord) => void): JsonlLogger {
  const log: JsonlLogger["log"] = async (input) => {
    const record = LogRecordSchema.parse({
      ...input,
      timestamp: input.timestamp ?? now.toISOString(),
      component: "cli",
    });
    records.push(record);
    onLog?.(record);
    return record;
  };
  return { path: "/memory/cli.jsonl", log } as JsonlLogger;
}

function rejectingLogger(path: string): JsonlLogger {
  return {
    path,
    log: async () => {
      throw new Error("logger unavailable");
    },
  } as JsonlLogger;
}

function runningObserverDeps(
  socketPath: string,
  dispatch: (command: StationCommand) => Promise<CommandReceipt>,
  waitForCommand?: (commandId: string) => Promise<CommandRecord>,
): NonNullable<CliRunOptions["observerDeps"]> {
  return {
    buildVersion: "0.0.0",
    clientFactory: () =>
      ({
        health: async () => ({
          schemaVersion: "0.11.0",
          status: "healthy",
          pid: 1234,
          startedAt: now.toISOString(),
          version: "0.7.0",
          socketPath,
        }),
        dispatch,
        ...(waitForCommand === undefined ? {} : { waitForCommand }),
      }) as never,
    sleep: async () => undefined,
  };
}

function acceptedReceipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_process",
    spanId: "spn_process",
    accepted: true,
    status: "accepted",
  };
}

function rejectedReceipt(): CommandReceipt {
  return {
    commandId: "cmd_rejected",
    traceId: "trc_process",
    spanId: "spn_process",
    accepted: false,
    status: "rejected",
    error: {
      tag: "CommandRejectedError",
      code: "REJECTED_WITH_SECRET",
      message: "rejection contains REJECTION_SECRET_VALUE",
    },
  };
}

function reconcileCommand(reason: string): StationCommand {
  return { type: "observer.reconcile", payload: { reason } };
}

function terminalRecord(
  id: string,
  command: StationCommand,
  status: "succeeded" | "failed",
): CommandRecord {
  return {
    id,
    type: command.type,
    command,
    status,
    traceId: "trc_process",
    spanId: "spn_process",
    createdAt: now.toISOString(),
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    ...(status === "failed"
      ? {
          error: {
            tag: "CommandExecutionError",
            code: "COMMAND_FAILED_FOR_TEST",
            message: "Command failed.",
          },
        }
      : {}),
  };
}

function secretOutputConfig(config: StationConfig, sentinel: string): StationConfig {
  return {
    ...config,
    projects: [
      {
        id: "secret-output",
        label: sentinel,
        root: "/tmp/secret-output",
        defaults: {
          harness: config.defaults.harness,
          terminal: config.defaults.terminal,
          layout: config.defaults.layout,
        },
        worktrunk: { enabled: false },
      },
    ],
  };
}
