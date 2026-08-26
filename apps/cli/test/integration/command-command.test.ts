import type { CommandReceipt, CommandRecord, StationCommand } from "@station/contracts";
import { StationCommandSchema } from "@station/contracts";
import type { TerminalCommandRecord } from "@station/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import { executeTypedObserverCommand, runCommandCommand } from "../../src/commands/command.js";

const now = "2026-05-22T12:00:00.000Z";
const incumbentBuildVersion = `1.2.3+station.${"a".repeat(64)}`;
const replacementBuildVersion = `1.2.3+station.${"b".repeat(64)}`;

type RunCli = typeof import("@station/cli").runCli;

async function runCli(...args: Parameters<RunCli>): ReturnType<RunCli> {
  const cli = await import("@station/cli");
  return cli.runCli(...args);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI command dispatch/get", () => {
  it("dispatches typed command JSON from stdin through the observer protocol", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const command = reconcileCommand("cli-command-dispatch");
    const dispatched: StationCommand[] = [];
    const parseCommand = vi.spyOn(StationCommandSchema, "safeParse");

    const result = await runCli(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(command),
      observerDeps: runningObserverDeps({
        socketPath: fixture.socketPath,
        dispatch: async (input) => {
          dispatched.push(input);
          return receipt("cmd_1");
        },
      }),
    });

    expect(parseCommand).toHaveBeenCalledTimes(1);
    const parsed = parseCommand.mock.results[0]?.value;
    expect(parsed?.success).toBe(true);
    if (parsed?.success !== true) throw new Error("Expected command input to parse.");
    expect(result).toEqual({
      code: 0,
      output: {
        status: "accepted",
        receipt: receipt("cmd_1"),
      },
    });
    expect(dispatched).toEqual([command]);
    expect(dispatched[0]).toBe(parsed.data);
  });

  it("dispatches an already-typed command without re-entering command parsing", async () => {
    const fixture = await createTempState();
    const command = reconcileCommand("typed-command-dispatch");
    const dispatched: StationCommand[] = [];
    const parseCommand = vi.spyOn(StationCommandSchema, "safeParse");

    const outcome = await executeTypedObserverCommand(
      command,
      { config: fixture.config, timeoutMs: 1000 },
      runningObserverDeps({
        socketPath: fixture.socketPath,
        dispatch: async (input) => {
          dispatched.push(input);
          return receipt("cmd_typed");
        },
      }),
    );

    expect(outcome).toEqual({ status: "accepted", receipt: receipt("cmd_typed") });
    expect(parseCommand).not.toHaveBeenCalled();
    expect(dispatched).toEqual([command]);
    expect(dispatched[0]).toBe(command);
  });

  it("preserves a rejected receipt and returns a nonzero raw CLI outcome", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const command = reconcileCommand("cli-command-rejected");
    const rejected = rejectedReceipt("cmd_rejected");

    const result = await runCli(
      ["--config", configPath, "command", "dispatch", "--stdin", "--wait"],
      {
        stdin: JSON.stringify(command),
        observerDeps: runningObserverDeps({
          socketPath: fixture.socketPath,
          dispatch: async () => rejected,
          waitForCommand: async () => {
            throw new Error("rejected commands must not wait for completion");
          },
        }),
      },
    );

    expect(result).toEqual({
      code: 1,
      output: {
        status: "rejected",
        receipt: rejected,
      },
    });
  });

  it("dispatches Cursor session.create JSON from stdin without rewriting the payload", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const command = cursorCreateCommand();
    const dispatched: StationCommand[] = [];

    const result = await runCli(["--config", configPath, "command", "dispatch", "--stdin"], {
      stdin: JSON.stringify(command),
      observerDeps: runningObserverDeps({
        socketPath: fixture.socketPath,
        dispatch: async (input) => {
          dispatched.push(input);
          return receipt("cmd_cursor");
        },
      }),
    });

    expect(result).toEqual({
      code: 0,
      output: {
        status: "accepted",
        receipt: receipt("cmd_cursor"),
      },
    });
    expect(dispatched).toEqual([command]);
  });

  it("waits for the final command record when --wait is provided", async () => {
    const fixture = await createTempState();
    const command: StationCommand = {
      type: "worktree.create",
      payload: { projectId: "web", branch: "cli-result" },
    };
    const completed = resultCommandRecord("cmd_wait", command);
    const result = await runCommandCommand(
      ["dispatch", "--stdin", "--wait", "--timeout-ms", "1000"],
      { config: fixture.config, stdin: JSON.stringify(command) },
      runningObserverDeps({
        socketPath: fixture.socketPath,
        dispatch: async () => receipt("cmd_wait"),
        waitForCommand: async () => completed as TerminalCommandRecord,
      }),
    );

    expect(result).toEqual({
      status: "succeeded",
      receipt: receipt("cmd_wait"),
      command: completed,
    });
  });

  it("preserves a failed terminal record and returns a nonzero raw CLI outcome", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const command = reconcileCommand("cli-command-failed");
    const failed = commandRecord("cmd_failed", command, "failed");

    const result = await runCli(
      ["--config", configPath, "command", "dispatch", "--stdin", "--wait"],
      {
        stdin: JSON.stringify(command),
        observerDeps: runningObserverDeps({
          socketPath: fixture.socketPath,
          dispatch: async () => receipt("cmd_failed"),
          waitForCommand: async () => failed as TerminalCommandRecord,
        }),
      },
    );

    expect(result).toEqual({
      code: 1,
      output: {
        status: "failed",
        receipt: receipt("cmd_failed"),
        command: failed,
      },
    });
  });

  it("returns a command record by id", async () => {
    const fixture = await createTempState();
    const getCommand: StationCommand = {
      type: "worktree.create",
      payload: { projectId: "web", branch: "cli-get-result" },
    };
    const record = resultCommandRecord("cmd_get", getCommand);
    record.diagnostics = [
      {
        type: "external_command",
        provider: "worktrunk",
        operation: "provider.worktrunk.switch",
        command: "wt switch --no-hooks --create feature --no-cd --format=json",
        cwd: "/tmp/station/web",
        exitCode: 2,
        stderrSnippet: "error: unexpected argument '--no-hooks' found",
        durationMs: 42,
      },
    ];

    await expect(
      runCommandCommand(
        ["get", "cmd_get"],
        { config: fixture.config },
        runningObserverDeps({
          socketPath: fixture.socketPath,
          getCommand: async () => record,
        }),
      ),
    ).resolves.toEqual({ command: record });
  });

  it("fails missing command records with a SafeError payload", async () => {
    const fixture = await createTempState();

    await expect(
      runCommandCommand(
        ["get", "cmd_missing"],
        { config: fixture.config },
        runningObserverDeps({
          socketPath: fixture.socketPath,
          getCommand: async () => undefined,
        }),
      ),
    ).rejects.toMatchObject({
      tag: "CommandCliError",
      code: "COMMAND_RECORD_NOT_FOUND",
      message: "No command record found for cmd_missing.",
      hint: expect.stringContaining("stn command dispatch --stdin --wait"),
      commandId: "cmd_missing",
    });
  });

  it("rejects invalid command ids before observer startup", async () => {
    const fixture = await createTempState();

    await expect(
      runCommandCommand(
        ["get", ""],
        { config: fixture.config },
        {
          spawnObserver: async () => {
            throw new Error("observer should not start for invalid command id input");
          },
        },
      ),
    ).rejects.toThrow("Invalid command id");
  });

  it("rejects invalid stdin JSON before dispatching", async () => {
    const fixture = await createTempState();

    await expect(
      runCommandCommand(
        ["dispatch", "--stdin"],
        { config: fixture.config, stdin: "{not-json" },
        runningObserverDeps({ socketPath: fixture.socketPath }),
      ),
    ).rejects.toThrow("Invalid command JSON");
  });

  it("times out while waiting for a terminal command record", async () => {
    const fixture = await createTempState();
    const command = reconcileCommand("cli-command-timeout");

    await expect(
      runCommandCommand(
        ["dispatch", "--stdin", "--wait", "--timeout-ms", "5"],
        { config: fixture.config, stdin: JSON.stringify(command) },
        runningObserverDeps({
          socketPath: fixture.socketPath,
          dispatch: async () => receipt("cmd_timeout"),
          waitForCommand: async () => {
            throw {
              tag: "TimeoutError",
              code: "PROTOCOL_COMMAND_WAIT_TIMEOUT",
              message: "Observer command did not finish before the timeout.",
            };
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "COMMAND_WAIT_TIMEOUT",
      commandId: "cmd_timeout",
      traceId: "trc_cli",
    });
  });

  it("renders accepted command and trace correlation for a post-dispatch wait failure", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const command = reconcileCommand("cli-command-rendered-timeout");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const cli = await import("../../src/main.js");
      await cli.runCliMain(
        ["--config", configPath, "command", "dispatch", "--stdin", "--wait", "--timeout-ms", "5"],
        {
          stdin: JSON.stringify(command),
          observerDeps: runningObserverDeps({
            socketPath: fixture.socketPath,
            dispatch: async () => receipt("cmd_rendered_timeout"),
            waitForCommand: async () => {
              throw {
                tag: "TimeoutError",
                code: "PROTOCOL_COMMAND_WAIT_TIMEOUT",
                message: "Observer command did not finish before the timeout.",
              };
            },
          }),
        },
      );

      expect(stderrWrite).toHaveBeenCalledWith(
        [
          "Command did not finish before the timeout. (COMMAND_WAIT_TIMEOUT)",
          "Command: cmd_rendered_timeout",
          "Trace: trc_cli",
          "",
        ].join("\n"),
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      stderrWrite.mockRestore();
    }
  });

  it("correlates non-timeout wait failures after acceptance", async () => {
    const fixture = await createTempState();
    const command = reconcileCommand("cli-command-wait-failure");

    await expect(
      executeTypedObserverCommand(
        command,
        { config: fixture.config, timeoutMs: 1000, waitForCompletion: true },
        runningObserverDeps({
          socketPath: fixture.socketPath,
          dispatch: async () => receipt("cmd_wait_failure"),
          waitForCommand: async () => {
            throw {
              tag: "ProtocolError",
              code: "PROTOCOL_COMMAND_WAIT_FAILED",
              message: "The accepted command record could not be reloaded.",
            };
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "PROTOCOL_COMMAND_WAIT_FAILED",
      commandId: "cmd_wait_failure",
      traceId: "trc_cli",
    });
  });

  it("preserves the dispatch timeout code before a receipt exists", async () => {
    const fixture = await createTempState();
    const command = reconcileCommand("cli-command-dispatch-timeout");

    await expect(
      executeTypedObserverCommand(
        command,
        { config: fixture.config, timeoutMs: 5 },
        runningObserverDeps({
          socketPath: fixture.socketPath,
          dispatch: async () => new Promise<CommandReceipt>(() => undefined),
        }),
      ),
    ).rejects.toMatchObject({
      code: "COMMAND_DISPATCH_TIMEOUT",
    });
  });

  it("rejects a terminal record that does not match the dispatched command", async () => {
    const fixture = await createTempState();
    const command = reconcileCommand("cli-command-mismatch");
    const mismatched = commandRecord(
      "cmd_other",
      reconcileCommand("different-command"),
      "succeeded",
    );

    await expect(
      executeTypedObserverCommand(
        command,
        { config: fixture.config, timeoutMs: 1000, waitForCompletion: true },
        runningObserverDeps({
          socketPath: fixture.socketPath,
          dispatch: async () => receipt("cmd_expected"),
          waitForCommand: async () => mismatched as TerminalCommandRecord,
        }),
      ),
    ).rejects.toMatchObject({
      tag: "CommandCliError",
      code: "COMMAND_COMPLETION_MISMATCH",
      commandId: "cmd_expected",
      traceId: "trc_cli",
    });
  });

  it("rejects a same-id terminal record for another command type", async () => {
    const fixture = await createTempState();
    const command = reconcileCommand("cli-command-type-mismatch");
    const mismatched = commandRecord(
      "cmd_expected",
      { type: "project.remove", payload: { projectId: "web" } },
      "succeeded",
    );

    await expect(
      executeTypedObserverCommand(
        command,
        { config: fixture.config, timeoutMs: 1000, waitForCompletion: true },
        runningObserverDeps({
          socketPath: fixture.socketPath,
          dispatch: async () => receipt("cmd_expected"),
          waitForCommand: async () => mismatched as TerminalCommandRecord,
        }),
      ),
    ).rejects.toMatchObject({
      tag: "CommandCliError",
      code: "COMMAND_COMPLETION_MISMATCH",
      commandId: "cmd_expected",
      traceId: "trc_cli",
    });
  });

  it("rejects a same-id and same-type terminal record for another payload", async () => {
    const fixture = await createTempState();
    const command = reconcileCommand("cli-command-payload-expected");
    const mismatched = commandRecord(
      "cmd_expected",
      reconcileCommand("cli-command-payload-other"),
      "succeeded",
    );

    await expect(
      executeTypedObserverCommand(
        command,
        { config: fixture.config, timeoutMs: 1000, waitForCompletion: true },
        runningObserverDeps({
          socketPath: fixture.socketPath,
          dispatch: async () => receipt("cmd_expected"),
          waitForCommand: async () => mismatched as TerminalCommandRecord,
        }),
      ),
    ).rejects.toMatchObject({
      tag: "CommandCliError",
      code: "COMMAND_COMPLETION_MISMATCH",
      commandId: "cmd_expected",
      traceId: "trc_cli",
    });
  });

  it("surfaces observer startup failures", async () => {
    const fixture = await createTempState();
    const command = reconcileCommand("cli-command-startup");

    await expect(
      runCommandCommand(
        ["dispatch", "--stdin", "--timeout-ms", "1"],
        { config: fixture.config, stdin: JSON.stringify(command) },
        {
          spawnObserver: async () => ({ pid: 1234, unref: () => undefined }),
          clientFactory: () =>
            ({
              health: async () => {
                throw new Error("still down");
              },
            }) as never,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ error: { code: "OBSERVER_START_FAILED" } });
  });

  it("never dispatches a mutation through a losing same-version Observer", async () => {
    const fixture = await createTempState();
    const command = reconcileCommand("same-version-build-handoff");
    let spawned = false;
    let dispatches = 0;

    await expect(
      runCommandCommand(
        ["dispatch", "--stdin"],
        { config: fixture.config, stdin: JSON.stringify(command) },
        {
          buildVersion: replacementBuildVersion,
          spawnObserver: async () => {
            spawned = true;
            return { pid: 5678, unref: () => undefined };
          },
          clientFactory: () =>
            ({
              health: async () =>
                spawned
                  ? { schemaVersion: "0.11.0", status: "healthy" }
                  : {
                      schemaVersion: "0.11.0",
                      status: "healthy",
                      pid: 1234,
                      startedAt: now,
                      version: incumbentBuildVersion,
                      socketPath: fixture.socketPath,
                    },
              dispatch: async () => {
                dispatches += 1;
                return receipt("cmd_must_not_dispatch");
              },
            }) as never,
        },
      ),
    ).rejects.toMatchObject({ error: { code: "OBSERVER_HANDOFF_REFUSED" } });

    expect(spawned).toBe(true);
    expect(dispatches).toBe(0);
  });
});

function runningObserverDeps(options: {
  socketPath: string;
  dispatch?: (command: StationCommand) => Promise<CommandReceipt>;
  getCommand?: (commandId: string) => Promise<CommandRecord | undefined>;
  waitForCommand?: (commandId: string) => Promise<TerminalCommandRecord>;
}) {
  return {
    buildVersion: "0.0.0",
    clientFactory: (socketPath: string) =>
      ({
        health: async () => ({
          schemaVersion: "0.11.0",
          status: "healthy",
          pid: 1234,
          startedAt: now,
          version: "0.7.0",
          socketPath,
        }),
        dispatch: options.dispatch ?? (async () => receipt("cmd_default")),
        getCommand: options.getCommand ?? (async () => undefined),
        waitForCommand:
          options.waitForCommand ??
          (async () =>
            commandRecord(
              "cmd_default",
              reconcileCommand("default"),
              "succeeded",
            ) as TerminalCommandRecord),
      }) as never,
    sleep: async () => undefined,
  };
}

function reconcileCommand(reason: string): StationCommand {
  return {
    type: "observer.reconcile",
    payload: { reason },
  };
}

function cursorCreateCommand(): StationCommand {
  return {
    type: "session.create",
    payload: {
      projectId: "web",
      branch: "cursor-cli",
      harness: {
        provider: "cursor",
        mode: "interactive",
      },
      terminal: {
        provider: "tmux",
        layout: "agent-build-shell",
      },
      placement: { intent: "detached" },
      initialPrompt: "Review the Cursor CLI dispatch path.",
    },
  };
}

function receipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_cli",
    spanId: "spn_cli",
    accepted: true,
    status: "accepted",
  };
}

function rejectedReceipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_cli",
    spanId: "spn_cli",
    accepted: false,
    status: "rejected",
    error: {
      tag: "CommandRejectedError",
      code: "COMMAND_REJECTED_FOR_TEST",
      message: "Observer rejected the command before execution.",
    },
  };
}

function commandRecord(
  id: string,
  command: StationCommand,
  status: CommandRecord["status"],
): CommandRecord {
  const record: CommandRecord = {
    id,
    type: command.type,
    command,
    status,
    createdAt: now,
    traceId: "trc_cli",
    spanId: "spn_cli",
  };
  if (status !== "accepted") {
    record.startedAt = now;
  }
  if (status === "succeeded" || status === "failed") {
    record.finishedAt = now;
  }
  if (status === "failed") {
    record.error = {
      tag: "CommandExecutionError",
      code: "COMMAND_EXECUTION_FAILED",
      message: "Observer command execution failed.",
    };
  }
  return record;
}

function resultCommandRecord(
  id: string,
  command: Extract<StationCommand, { type: "worktree.create" }>,
): CommandRecord {
  return {
    ...commandRecord(id, command, "succeeded"),
    result: {
      type: "worktree.create",
      projectId: command.payload.projectId,
      worktreeId: `wt_${command.payload.branch.replaceAll("-", "_")}`,
    },
  } as CommandRecord;
}
