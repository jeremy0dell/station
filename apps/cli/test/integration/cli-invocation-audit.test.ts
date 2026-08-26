import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, resolveObserverPaths } from "@station/config";
import type { CommandReceipt, LogRecord, StationCommand } from "@station/contracts";
import { readBoundedComponentLogs } from "@station/observability";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import type { CliRunOptions } from "../../src/cliTypes.js";
import {
  CLI_INVOCATION_MUTATION_BLOCKED_WARNING,
  CLI_INVOCATION_OUTCOME_UNCERTAIN_WARNING,
} from "../../src/invocationAudit.js";
import { runCli, runCliMain } from "../../src/main.js";

const now = new Date("2026-08-25T12:00:00.000Z");
const buildInfo = {
  version: "0.7.0",
  compiled: false,
  buildIdentity: "a".repeat(64),
} as const;

describe("CLI invocation audit", () => {
  it("durably records help without starting Observer", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const spawnObserver = vi.fn();
    const capture = processCapture();

    await runCliMain(["--config", configPath, "--help"], {
      observerDeps: { spawnObserver },
      updateDeps: { currentBuildInfo: buildInfo },
      invocationAuditDeps: capture.deps("11111111-1111-4111-8111-111111111111"),
    });

    const read = await readBoundedComponentLogs({
      stateDir: fixture.stateDir,
      component: "cli",
    });
    expect(read.records.map((record) => record.cliInvocation?.kind)).toEqual(["start", "outcome"]);
    expect(read.records[0]?.cliInvocation).toMatchObject({ intentPath: ["help"] });
    expect(read.records[1]?.cliInvocation).toMatchObject({
      status: "help",
      exitCode: 0,
      resolvedPath: ["help"],
    });
    expect(capture.exitCode()).toBe(0);
    expect(capture.stdout()).toContain("Usage:");
    expect(spawnObserver).not.toHaveBeenCalled();

    const discovered = await runCli([
      "--config",
      configPath,
      "debug",
      "logs",
      "11111111-1111-4111-8111-111111111111",
      "--component",
      "cli",
      "--json",
    ]);
    expect(discovered).toMatchObject({
      code: 0,
      output: {
        matched: 2,
        evidence: {
          invalidLines: 0,
          unreadableFiles: 0,
          truncatedFiles: 0,
        },
        records: [
          { cliInvocation: { kind: "start" } },
          { cliInvocation: { kind: "outcome", status: "help" } },
        ],
      },
    });
  });

  it("records version, malformed input, and unknown commands with distinct statuses", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const cases = [
      { argv: ["--config", configPath, "--version"], status: "version", code: 0 },
      { argv: ["--config"], status: "parse_failure", code: 1 },
      { argv: ["--config", configPath, "unknown"], status: "unknown_command", code: 1 },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const records: LogRecord[] = [];
      const capture = processCapture();
      await runCliMain(testCase.argv, {
        updateDeps: { currentBuildInfo: buildInfo },
        invocationAuditDeps: {
          ...capture.deps(`11111111-1111-4111-8111-${String(index + 2).padStart(12, "0")}`),
          resolveObserverPaths: () => resolveObserverPaths(fixture.config, fixture.root),
          appendRecord: async (options) => {
            records.push(options.record);
            return { record: options.record, rotated: false, cleanupFailures: 0 };
          },
        },
      });

      expect(records.map((record) => record.cliInvocation?.kind)).toEqual(["start", "outcome"]);
      expect(records[1]?.cliInvocation).toMatchObject({
        status: testCase.status,
        exitCode: testCase.code,
      });
      expect(capture.exitCode()).toBe(testCase.code);
    }
  });

  it("fails closed before dispatch when the mutation start is not durable", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const dispatch = vi.fn(async () => receipt("cmd_blocked"));
    const capture = processCapture();

    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(reconcileCommand("blocked")),
      observerDeps: runningObserverDeps(fixture.socketPath, dispatch),
      updateDeps: { currentBuildInfo: buildInfo },
      invocationAuditDeps: {
        ...capture.deps("11111111-1111-4111-8111-111111111115"),
        appendRecord: async () => {
          throw new Error("audit unavailable");
        },
      },
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(capture.exitCode()).toBe(1);
    expect(capture.stderr()).toContain(CLI_INVOCATION_MUTATION_BLOCKED_WARNING.trim());
  });

  it("preserves command correlation and raises a successful mutation when outcome durability fails", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const dispatch = vi.fn(async () => receipt("cmd_completed"));
    const records: LogRecord[] = [];
    let appendCount = 0;
    const capture = processCapture();

    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(reconcileCommand("completed")),
      observerDeps: runningObserverDeps(fixture.socketPath, dispatch),
      updateDeps: { currentBuildInfo: buildInfo },
      invocationAuditDeps: {
        ...capture.deps("11111111-1111-4111-8111-111111111116"),
        appendRecord: async (options) => {
          appendCount += 1;
          if (appendCount === 2) throw new Error("outcome unavailable");
          records.push(options.record);
          return { record: options.record, rotated: false, cleanupFailures: 0 };
        },
      },
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.cliInvocation).toMatchObject({ kind: "start", effect: "mutation" });
    expect(capture.exitCode()).toBe(1);
    expect(capture.stderr()).toContain(CLI_INVOCATION_OUTCOME_UNCERTAIN_WARNING.trim());
  });

  it("records typed rejection and correlated completion timeout statuses", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);

    const rejectedRecords: LogRecord[] = [];
    const rejectedCapture = processCapture();
    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(reconcileCommand("rejected")),
      observerDeps: runningObserverDeps(fixture.socketPath, async () => ({
        commandId: "cmd_rejected",
        traceId: "trc_audit",
        spanId: "spn_audit",
        accepted: false,
        status: "rejected",
        error: {
          tag: "CommandRejectedError",
          code: "REJECTED_FOR_AUDIT_TEST",
          message: "sensitive rejection detail",
        },
      })),
      updateDeps: { currentBuildInfo: buildInfo },
      invocationAuditDeps: {
        ...rejectedCapture.deps("11111111-1111-4111-8111-111111111122"),
        appendRecord: collectingAppender(rejectedRecords),
      },
    });
    expect(rejectedRecords[1]?.cliInvocation).toMatchObject({
      status: "rejected",
      audit: {
        command: { commandId: "cmd_rejected", traceId: "trc_audit" },
        error: { tag: "CommandRejectedError", code: "REJECTED_FOR_AUDIT_TEST" },
      },
    });
    expect(JSON.stringify(rejectedRecords)).not.toContain("sensitive rejection detail");

    const timeoutRecords: LogRecord[] = [];
    const timeoutCapture = processCapture();
    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin", "--wait"], {
      stdin: JSON.stringify(reconcileCommand("timeout")),
      observerDeps: runningObserverDeps(
        fixture.socketPath,
        async () => receipt("cmd_timeout"),
        async () => {
          throw {
            tag: "TimeoutError",
            code: "PROTOCOL_WAIT_TIMEOUT",
            message: "wait timed out",
          };
        },
      ),
      updateDeps: { currentBuildInfo: buildInfo },
      invocationAuditDeps: {
        ...timeoutCapture.deps("11111111-1111-4111-8111-111111111123"),
        appendRecord: collectingAppender(timeoutRecords),
      },
    });
    expect(timeoutRecords[1]).toMatchObject({
      commandId: "cmd_timeout",
      traceId: "trc_audit",
      cliInvocation: {
        status: "timed_out",
        audit: {
          error: {
            tag: "TimeoutError",
            code: "COMMAND_WAIT_TIMEOUT",
            commandId: "cmd_timeout",
            traceId: "trc_audit",
          },
        },
      },
    });
  });

  it("continues reads with warnings and uses the bootstrap sink for config failure", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const readCapture = processCapture();

    await runCliMain(["--config", configPath, "project", "list"], {
      updateDeps: { currentBuildInfo: buildInfo },
      invocationAuditDeps: {
        ...readCapture.deps("11111111-1111-4111-8111-111111111117"),
        appendRecord: async () => {
          throw new Error("audit unavailable");
        },
      },
    });
    expect(readCapture.exitCode()).toBe(0);
    expect(readCapture.stderr()).toContain("not fully audited");

    const recoveryArgs = ["--config", configPath, "debug", "logs", "absent"];
    const expectedRecovery = await runCli(recoveryArgs);
    const recoveryCapture = processCapture();
    await runCliMain(recoveryArgs, {
      updateDeps: { currentBuildInfo: buildInfo },
      invocationAuditDeps: {
        ...recoveryCapture.deps("11111111-1111-4111-8111-111111111120"),
        appendRecord: async () => {
          throw new Error("audit unavailable");
        },
      },
    });
    expect(recoveryCapture.exitCode()).toBe(expectedRecovery.code);
    expect(recoveryCapture.stderr()).toContain("not fully audited");

    const records: LogRecord[] = [];
    const failureCapture = processCapture();
    await runCliMain(["--config", join(fixture.root, "missing.toml"), "project", "list"], {
      updateDeps: { currentBuildInfo: buildInfo },
      invocationAuditDeps: {
        ...failureCapture.deps("11111111-1111-4111-8111-111111111118"),
        resolveObserverPaths: () => resolveObserverPaths(undefined, fixture.root),
        appendRecord: async (options) => {
          records.push(options.record);
          return { record: options.record, rotated: false, cleanupFailures: 0 };
        },
      },
    });

    expect(records[0]?.cliInvocation).toMatchObject({
      kind: "start",
      sink: {
        source: "bootstrap_default",
        configResolution: "explicit",
        fallbackReason: "config_load_failed",
      },
    });
    expect(records[1]?.cliInvocation).toMatchObject({ status: "config_failure" });
    expect(failureCapture.exitCode()).toBe(1);
  });

  it("records output failures as process exceptions", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const records: LogRecord[] = [];
    const capture = processCapture();

    await runCliMain(["--config", configPath, "project", "list"], {
      updateDeps: { currentBuildInfo: buildInfo },
      invocationAuditDeps: {
        ...capture.deps("11111111-1111-4111-8111-111111111121"),
        stdoutWrite: () => {
          throw new Error("stdout unavailable");
        },
        appendRecord: async (options) => {
          records.push(options.record);
          return { record: options.record, rotated: false, cleanupFailures: 0 };
        },
      },
    });

    expect(capture.exitCode()).toBe(1);
    expect(capture.stderr()).toContain("stdout unavailable");
    expect(records[1]?.cliInvocation).toMatchObject({
      kind: "outcome",
      status: "process_exception",
      exitCode: 1,
    });
  });

  it("never retains argv, stdin, config-path, or environment secrets", async () => {
    const fixture = await createTempState();
    const originalConfigPath = await writeConfigToml(fixture.root, fixture.config);
    const sentinel = "TOKEN=cli-invocation-super-secret";
    const secretDir = join(fixture.root, sentinel);
    const configPath = join(secretDir, "config.toml");
    await mkdir(secretDir);
    await copyFile(originalConfigPath, configPath);
    const records: LogRecord[] = [];
    const capture = processCapture();

    await runCliMain(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify({
        type: "session.create",
        payload: {
          projectId: "web",
          branch: "audit-redaction",
          harness: { provider: "codex" },
          terminal: { provider: "tmux" },
          placement: { intent: "detached" },
          initialPrompt: sentinel,
        },
      }),
      env: {
        TMUX: sentinel,
        TMUX_PANE: sentinel,
        STATION_PRIVATE_VALUE: sentinel,
      },
      observerDeps: runningObserverDeps(fixture.socketPath, async () => receipt("cmd_safe")),
      updateDeps: { currentBuildInfo: buildInfo },
      invocationAuditDeps: {
        ...capture.deps("11111111-1111-4111-8111-111111111119"),
        appendRecord: async (options) => {
          records.push(options.record);
          return { record: options.record, rotated: false, cleanupFailures: 0 };
        },
      },
    });

    expect(JSON.stringify(records)).not.toContain(sentinel);
    expect(records[0]?.cliInvocation).toMatchObject({
      callerClaims: { tmux: true, tmuxPane: true },
      arguments: { recognizedOptions: ["--stdin"] },
    });
    expect(records[1]).toMatchObject({
      commandId: "cmd_safe",
      traceId: "trc_audit",
    });
  });
});

function processCapture() {
  let code: number | undefined;
  let stdout = "";
  let stderr = "";
  return {
    deps: (invocationId: string) => ({
      randomUUID: () => invocationId,
      clock: { now: () => now },
      loadConfig: async (configPath?: string) =>
        configPath === undefined ? loadConfig() : loadConfig(configPath),
      stdoutWrite: (value: string) => {
        stdout += value;
      },
      stderrWrite: (value: string) => {
        stderr += value;
      },
      exit: (exitCode: number) => {
        code = exitCode;
      },
      setExitCode: (exitCode: number) => {
        code = exitCode;
      },
    }),
    exitCode: () => code,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function runningObserverDeps(
  socketPath: string,
  dispatch: (command: StationCommand) => Promise<CommandReceipt>,
  waitForCommand?: () => Promise<never>,
): NonNullable<CliRunOptions["observerDeps"]> {
  return {
    buildVersion: "0.0.0",
    clientFactory: (_requestedSocketPath: string) =>
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

function collectingAppender(records: LogRecord[]) {
  return async (options: { record: LogRecord }) => {
    records.push(options.record);
    return { record: options.record, rotated: false, cleanupFailures: 0 };
  };
}

function receipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_audit",
    spanId: "spn_audit",
    accepted: true,
    status: "accepted",
  };
}

function reconcileCommand(reason: string): StationCommand {
  return { type: "observer.reconcile", payload: { reason } };
}
