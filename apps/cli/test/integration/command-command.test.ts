import { runCli } from "@station/cli";
import { runCommandCommand } from "@station/cli/internal";
import type { CommandReceipt, CommandRecord, StationCommand } from "@station/contracts";
import type { TerminalCommandRecord } from "@station/protocol";
import { describe, expect, it } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const now = "2026-05-22T12:00:00.000Z";

describe("CLI command dispatch/get", () => {
  it("dispatches typed command JSON from stdin through the observer protocol", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const command = reconcileCommand("cli-command-dispatch");
    const dispatched: StationCommand[] = [];

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

    expect(result).toEqual({
      code: 0,
      output: {
        status: "accepted",
        receipt: receipt("cmd_1"),
      },
    });
    expect(dispatched).toEqual([command]);
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
    const command = reconcileCommand("cli-command-wait");
    const result = await runCommandCommand(
      ["dispatch", "--stdin", "--wait", "--timeout-ms", "1000"],
      { config: fixture.config, stdin: JSON.stringify(command) },
      runningObserverDeps({
        socketPath: fixture.socketPath,
        dispatch: async () => receipt("cmd_wait"),
        waitForCommand: async () =>
          commandRecord("cmd_wait", command, "succeeded") as TerminalCommandRecord,
      }),
    );

    expect(result).toEqual({
      status: "succeeded",
      receipt: receipt("cmd_wait"),
      command: commandRecord("cmd_wait", command, "succeeded"),
    });
  });

  it("returns a command record by id", async () => {
    const fixture = await createTempState();
    const record = commandRecord("cmd_get", reconcileCommand("cli-command-get"), "failed");
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
    ).rejects.toThrow("Observer did not become healthy before the startup timeout.");
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
          schemaVersion: "0.7.0",
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
        focus: false,
      },
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
