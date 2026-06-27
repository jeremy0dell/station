import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { addProjectToConfig, removeProjectFromConfig } from "@station/config";
import type { CommandReceipt, CommandRecord, StationCommand } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const now = "2026-05-20T12:00:00.000Z";

describe("CLI project commands", () => {
  it("lists configured projects", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);

    const result = await runCli(["--config", configPath, "project", "list"]);

    expect(result).toEqual({
      code: 0,
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
    expect(result).toMatchObject({
      code: 0,
      output: {
        action: "add",
        status: "succeeded",
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
    expect(result).toMatchObject({
      code: 0,
      output: {
        action: "remove",
        status: "succeeded",
        projects: [],
      },
    });
  });
});

async function makeRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(join(repo, ".git"), { recursive: true });
  return repo;
}

function runningObserverDeps(options: {
  socketPath: string;
  dispatch: (command: StationCommand) => Promise<CommandReceipt>;
  waitForCommand: (commandId: string) => Promise<CommandRecord>;
}) {
  return {
    clientFactory: (socketPath: string) =>
      ({
        health: async () => ({
          schemaVersion: "0.6.0",
          status: "healthy",
          pid: 1234,
          startedAt: now,
          version: "0.0.0",
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
  return record;
}
