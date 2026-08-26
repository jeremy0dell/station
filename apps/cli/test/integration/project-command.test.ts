import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runCli } from "@station/cli";
import { addProjectToConfig, removeProjectFromConfig } from "@station/config";
import type { CommandReceipt, CommandRecord, StationCommand } from "@station/contracts";
import { StationCommandSchema } from "@station/contracts";
import { environmentWithoutGitLocals } from "@station/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";
const execFileAsync = promisify(execFile);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI project commands", () => {
  it("lists configured projects", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);

    const result = await runCli(["--config", configPath, "project", "list"]);

    expect(result).toEqual({
      code: 0,
      audit: {
        collection: { resource: "projects", count: 0, identifiersOmitted: true },
      },
      output: {
        action: "list",
        projects: [],
      },
    });
  });

  it("dispatches project.add and reloads updated config", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const repo = await makeRepo(fixture.root, "web");
    const dispatched: StationCommand[] = [];
    const parseCommand = vi.spyOn(StationCommandSchema, "safeParse");

    const result = await runCli(["--config", configPath, "project", "add", repo], {
      observerDeps: runningObserverDeps({
        socketPath: fixture.socketPath,
        dispatch: async (command) => {
          dispatched.push(command);
          await addProjectToConfig({ path: repo, configPath, homeDir: fixture.root });
          return receipt("cmd_project_add");
        },
        waitForCommand: async (_commandId) =>
          commandRecord("cmd_project_add", dispatched[0] ?? projectAddCommand(repo), "succeeded"),
      }),
    });

    expect(dispatched).toEqual([projectAddCommand(repo)]);
    expect(parseCommand).not.toHaveBeenCalled();
    expect(result).toEqual({
      code: 0,
      audit: {
        commandStatus: "succeeded",
        command: { commandId: "cmd_project_add", traceId: "trc_project" },
        resources: { projectId: "web" },
      },
      output: {
        action: "add",
        status: "succeeded",
        receipt: receipt("cmd_project_add"),
        command: commandRecord("cmd_project_add", projectAddCommand(repo), "succeeded"),
        projects: [{ id: "web", label: "web", root: repo }],
      },
    });
  });

  it("dispatches project.remove and reloads updated config", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const repo = await makeRepo(fixture.root, "web");
    await addProjectToConfig({ path: repo, configPath, homeDir: fixture.root });
    const dispatched: StationCommand[] = [];
    const parseCommand = vi.spyOn(StationCommandSchema, "safeParse");

    const result = await runCli(["--config", configPath, "project", "remove", "web"], {
      observerDeps: runningObserverDeps({
        socketPath: fixture.socketPath,
        dispatch: async (command) => {
          dispatched.push(command);
          await removeProjectFromConfig({ projectId: "web", configPath, homeDir: fixture.root });
          return receipt("cmd_project_remove");
        },
        waitForCommand: async (_commandId) =>
          commandRecord(
            "cmd_project_remove",
            dispatched[0] ?? projectRemoveCommand("web"),
            "succeeded",
          ),
      }),
    });

    expect(dispatched).toEqual([projectRemoveCommand("web")]);
    expect(parseCommand).not.toHaveBeenCalled();
    expect(result).toEqual({
      code: 0,
      audit: {
        commandStatus: "succeeded",
        command: { commandId: "cmd_project_remove", traceId: "trc_project" },
        resources: { projectId: "web" },
      },
      output: {
        action: "remove",
        status: "succeeded",
        receipt: receipt("cmd_project_remove"),
        command: commandRecord("cmd_project_remove", projectRemoveCommand("web"), "succeeded"),
        projects: [],
      },
    });
  });

  it("returns the original project rejection as structured nonzero output", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const repo = await makeRepo(fixture.root, "web");
    const rejected = rejectedReceipt("cmd_project_rejected");
    const parseCommand = vi.spyOn(StationCommandSchema, "safeParse");

    const result = await runCli(["--config", configPath, "project", "add", repo], {
      observerDeps: runningObserverDeps({
        socketPath: fixture.socketPath,
        dispatch: async () => rejected,
        waitForCommand: async () => {
          throw new Error("rejected project commands must not wait for completion");
        },
      }),
    });

    expect(parseCommand).not.toHaveBeenCalled();
    expect(result).toEqual({
      code: 1,
      audit: {
        commandStatus: "rejected",
        command: { commandId: "cmd_project_rejected", traceId: "trc_project" },
        error: { tag: "CommandRejectedError", code: "PROJECT_ALREADY_CONFIGURED" },
      },
      output: {
        action: "add",
        status: "rejected",
        receipt: rejected,
        projects: [],
      },
    });
  });

  it("returns a failed project record as structured nonzero output", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const repo = await makeRepo(fixture.root, "web");
    const command = projectAddCommand(repo);
    const failed = commandRecord("cmd_project_failed", command, "failed");

    const result = await runCli(["--config", configPath, "project", "add", repo], {
      observerDeps: runningObserverDeps({
        socketPath: fixture.socketPath,
        dispatch: async () => receipt("cmd_project_failed"),
        waitForCommand: async () => failed,
      }),
    });

    expect(result).toEqual({
      code: 1,
      audit: {
        commandStatus: "failed",
        command: { commandId: "cmd_project_failed", traceId: "trc_project" },
      },
      output: {
        action: "add",
        status: "failed",
        receipt: receipt("cmd_project_failed"),
        command: failed,
        projects: [],
      },
    });
  });

  it("reports a configured bare checkout with safe manual repair guidance", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const repo = await makeGitRepo(fixture.root, "bare-project");
    await addProjectToConfig({ path: repo, configPath, homeDir: fixture.root });
    await git(repo, ["config", "--local", "core.bare", "true"]);

    const result = await runCli(["--config", configPath, "project", "doctor", "bare-project"]);

    expect(result).toMatchObject({
      code: 1,
      output: {
        action: "doctor",
        status: "warn",
        project: { id: "bare-project", root: repo },
        messages: [
          "Project checkout is configured as a bare repository.",
          expect.stringContaining("config --local core.bare false"),
        ],
      },
    });
  });
});

async function makeRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(join(repo, ".git"), { recursive: true });
  return repo;
}

async function makeGitRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--quiet"]);
  return repo;
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root, env: environmentWithoutGitLocals() });
}

function runningObserverDeps(options: {
  socketPath: string;
  dispatch: (command: StationCommand) => Promise<CommandReceipt>;
  waitForCommand: (commandId: string) => Promise<CommandRecord>;
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
        dispatch: options.dispatch,
        waitForCommand: options.waitForCommand,
      }) as never,
    sleep: async () => undefined,
  };
}

function projectAddCommand(path: string): StationCommand {
  return {
    type: "project.add",
    payload: { path },
  };
}

function projectRemoveCommand(projectId: string): StationCommand {
  return {
    type: "project.remove",
    payload: { projectId },
  };
}

function receipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_project",
    spanId: "spn_project",
    accepted: true,
    status: "accepted",
  };
}

function rejectedReceipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_project",
    spanId: "spn_project",
    accepted: false,
    status: "rejected",
    error: {
      tag: "CommandRejectedError",
      code: "PROJECT_ALREADY_CONFIGURED",
      message: "The project is already configured.",
      hint: "Use `stn project list` to inspect configured projects.",
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
    traceId: "trc_project",
    spanId: "spn_project",
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
      code: "PROJECT_CONFIG_WRITE_FAILED",
      message: "The project configuration could not be updated.",
    };
  }
  return record;
}
