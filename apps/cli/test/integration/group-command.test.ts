import { runCli } from "@station/cli";
import type { ObserverProcessDeps } from "@station/cli/internal";
import type {
  CommandReceipt,
  CommandRecord,
  SessionGroupView,
  StationCommand,
  StationSnapshot,
} from "@station/contracts";
import { SessionGroupCreateCommandResultSchema, StationSnapshotSchema } from "@station/contracts";
import type { TerminalCommandRecord } from "@station/protocol";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import { runGroupCommand } from "../../src/commands/group/command.js";
import { renderGroupCommandText } from "../../src/commands/group/text.js";

const now = "2026-08-30T12:00:00.000Z";
const observerBuildVersion = `0.0.0-local+station.${"a".repeat(64)}`;

describe("group command", () => {
  it("requires an explicit subcommand and resolves nested help before startup", async () => {
    const spawnObserver = vi.fn();

    await expect(runGroupCommand([], {}, { spawnObserver })).rejects.toThrow(
      "Group command requires a subcommand. Use: stn group --help.",
    );

    const help = await runCli(["--config", "/missing/config.toml", "group", "--help"], {
      observerDeps: { spawnObserver },
    });
    const manual = await runCli(["group", "members", "add", "--man"], {
      observerDeps: { spawnObserver },
    });

    expect(help).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(help)).toContain("stn group members add");
    expect(textOutput(help)).toContain("--require-running");
    expect(manual).toMatchObject({ code: 0, outputFormat: "text" });
    expect(textOutput(manual)).toContain("atomically move");
    expect(spawnObserver).not.toHaveBeenCalled();
  });

  it("lists canonical project-local groups in snapshot order without flattening descendants", async () => {
    const fixture = await createTempState();
    const snapshot = groupSnapshot();

    try {
      const all = await runGroupCommand(
        ["list", "--json"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [snapshot]).deps,
      );
      const project = await runGroupCommand(
        ["list", "--project", "web"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [snapshot]).deps,
      );
      const missingProject = await runGroupCommand(
        ["list", "--project", "missing-project"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [snapshot]).deps,
      );

      expect(all).toEqual({
        action: "list",
        filters: {},
        groups: snapshot.sessionGroups,
      });
      expect(project).toEqual({
        action: "list",
        filters: { project: "web" },
        groups: snapshot.sessionGroups.filter((group) => group.projectId === "web"),
      });
      expect(missingProject).toEqual({
        action: "list",
        filters: { project: "missing-project" },
        groups: [],
      });
      expect(snapshot.sessionGroups[1]).toMatchObject({
        id: "grp_child",
        parentGroupId: "grp_parent",
        sessionIds: ["ses_child"],
      });
      expect(project).not.toMatchObject({ groups: [{ sessionIds: ["ses_parent", "ses_child"] }] });
    } finally {
      await fixture.cleanup();
    }
  });

  it("gets one exact Group id and escapes terminal text without changing JSON values", async () => {
    const fixture = await createTempState();
    const snapshot = withGroup(snapshotWithGroups(), "grp_parent", {
      name: "\u001bDanger",
    });

    try {
      const found = await runGroupCommand(
        ["get", "grp_parent"],
        { config: fixture.config },
        snapshotObserverDeps(fixture.socketPath, [snapshot]).deps,
      );
      const text = renderGroupCommandText(found);
      expect(found).toEqual({ action: "get", group: snapshot.sessionGroups[0] });
      expect(text).toContain("\\u001bDanger");
      expect(text).not.toContain("\u001b");

      await expect(
        runGroupCommand(
          ["get", "grp_par"],
          { config: fixture.config },
          snapshotObserverDeps(fixture.socketPath, [snapshot]).deps,
        ),
      ).rejects.toMatchObject({
        code: "GROUP_NOT_FOUND",
        message: expect.stringContaining("grp_par"),
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects malformed options before Observer startup", async () => {
    const fixture = await createTempState();
    const spawnObserver = vi.fn();

    try {
      await expect(
        runGroupCommand(
          ["reparent", "grp_parent", "--root", "--parent", "grp_child"],
          {
            config: fixture.config,
          },
          { spawnObserver },
        ),
      ).rejects.toThrow("group reparent requires exactly one");
      await expect(
        runGroupCommand(
          ["members", "add", "grp_parent", "--not-an-id"],
          { config: fixture.config },
          {
            spawnObserver,
          },
        ),
      ).rejects.toThrow("Unknown group members add option: --not-an-id");
      await expect(
        runGroupCommand(
          ["create", "web", "Name", "--timeout-ms", "0"],
          {
            config: fixture.config,
          },
          { spawnObserver },
        ),
      ).rejects.toThrow("--timeout-ms must be a positive integer");
      expect(spawnObserver).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("honors --require-running for read-only discovery without spawning", async () => {
    const fixture = await createTempState();
    const spawnObserver = vi.fn();
    const deps: ObserverProcessDeps = {
      spawnObserver,
      clientFactory: () =>
        ({ health: async () => Promise.reject(new Error("not running")) }) as never,
    };

    try {
      for (const args of [
        ["list", "--require-running"],
        ["get", "grp_parent", "--require-running"],
      ]) {
        await expect(
          runGroupCommand(args, { config: fixture.config, timeoutMs: 20 }, deps),
        ).rejects.toMatchObject({ error: { code: "OBSERVER_NOT_RUNNING" } });
      }
      expect(spawnObserver).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("creates an empty Group from the typed durable result and refreshes by returned id", async () => {
    const fixture = await createTempState();
    const initial = groupSnapshot();
    const created = SessionGroupCreateCommandResultSchema.parse({
      type: "sessionGroup.create",
      projectId: "web",
      groupId: "grp_created",
      version: 1,
    });
    const refreshed = withGroups(initial, [
      ...initial.sessionGroups,
      groupView("grp_created", "web", "New Group", [], 1),
    ]);
    const harness = snapshotObserverDeps(fixture.socketPath, [initial, refreshed], {
      waitForCommand: async (commandId, command) => succeededRecord(commandId, command, created),
    });

    try {
      const result = await runGroupCommand(
        ["create", "web", "  New Group  ", "--json"],
        { config: fixture.config },
        harness.deps,
      );

      expect(harness.commands).toEqual([
        {
          type: "sessionGroup.create",
          payload: { projectId: "web", name: "New Group" },
        },
      ]);
      expect(result).toMatchObject({
        action: "create",
        created,
        convergence: {
          status: "confirmed",
          projectId: "web",
          groups: refreshed.sessionGroups.filter((group) => group.projectId === "web"),
        },
      });
      expect(harness.snapshotReads()).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("creates multiple direct members in argv order and refuses duplicate, grouped, cross-project, and missing sessions", async () => {
    const fixture = await createTempState();
    const initial = groupSnapshot();
    const created = SessionGroupCreateCommandResultSchema.parse({
      type: "sessionGroup.create",
      projectId: "web",
      groupId: "grp_many",
      version: 2,
    });
    const refreshed = withGroups(initial, [
      ...initial.sessionGroups,
      groupView("grp_many", "web", "Many", ["ses_free", "ses_free_2"], 2),
    ]);
    const successful = snapshotObserverDeps(fixture.socketPath, [initial, refreshed], {
      waitForCommand: async (commandId, command) => succeededRecord(commandId, command, created),
    });

    try {
      await runGroupCommand(
        ["create", "web", "Many", "--session", "ses_free", "--session", "ses_free_2"],
        { config: fixture.config },
        successful.deps,
      );
      expect(successful.commands[0]).toEqual({
        type: "sessionGroup.create",
        payload: {
          projectId: "web",
          name: "Many",
          initialSessionIds: ["ses_free", "ses_free_2"],
        },
      });

      for (const args of [
        ["create", "web", "Duplicate", "--session", "ses_free", "--session", "ses_free"],
        ["create", "web", "Grouped", "--session", "ses_parent"],
        ["create", "web", "Cross", "--session", "ses_api"],
        ["create", "web", "Missing", "--session", "ses_missing"],
      ]) {
        const harness = snapshotObserverDeps(fixture.socketPath, [initial]);
        await expect(
          runGroupCommand(args, { config: fixture.config }, harness.deps),
        ).rejects.toBeDefined();
        expect(harness.commands).toEqual([]);
        expect(harness.snapshotReads()).toBe(1);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed when a successful create lacks its exact durable result", async () => {
    const fixture = await createTempState();
    const harness = snapshotObserverDeps(fixture.socketPath, [groupSnapshot(), groupSnapshot()], {
      waitForCommand: async (commandId, command) => succeededRecord(commandId, command),
    });

    try {
      await expect(
        runGroupCommand(
          ["create", "web", "Missing result"],
          { config: fixture.config },
          harness.deps,
        ),
      ).rejects.toMatchObject({ code: "GROUP_CREATE_RESULT_INVALID", commandId: "cmd_group" });
      expect(harness.snapshotReads()).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns command correlation and a nonzero exit code for rejected mutations", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const harness = snapshotObserverDeps(fixture.socketPath, [groupSnapshot()], {
      dispatch: async () => rejectedReceipt("cmd_rejected"),
    });

    try {
      const result = await runCli(
        ["--config", configPath, "group", "rename", "grp_parent", "Rejected", "--json"],
        { observerDeps: harness.deps },
      );

      expect(result).toMatchObject({
        code: 1,
        correlation: {
          status: "rejected",
          commandId: "cmd_rejected",
          traceId: "trc_group",
        },
        output: { action: "rename", outcome: { status: "rejected" } },
      });
      const text = renderGroupCommandText(
        await runGroupCommand(
          ["members", "add", "grp_parent", "ses_free"],
          { config: fixture.config },
          snapshotObserverDeps(fixture.socketPath, [groupSnapshot()], {
            dispatch: async () => rejectedReceipt("cmd_text_rejected"),
          }).deps,
        ),
      );
      expect(text).toContain("Group members add");
      expect(text.indexOf("Command: cmd_text_rejected")).toBeLessThan(
        text.indexOf("Trace: trc_group"),
      );
      expect(text).toContain(
        "Error: The Group command was rejected by Observer preconditions. (GROUP_COMMAND_REJECTED)",
      );
      expect(text).toContain("Hint: Refresh Group state.");
      expect(harness.snapshotReads()).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("renames with the target project and observed version, then confirms refreshed identity", async () => {
    const fixture = await createTempState();
    const initial = groupSnapshot();
    const refreshed = withGroup(initial, "grp_parent", {
      name: "Renamed",
      version: 3,
      updatedAt: "2026-08-30T12:01:00.000Z",
    });
    const harness = snapshotObserverDeps(fixture.socketPath, [initial, refreshed]);

    try {
      const result = await runGroupCommand(
        ["rename", "grp_parent", "  Renamed  "],
        { config: fixture.config },
        harness.deps,
      );

      expect(harness.commands).toEqual([
        {
          type: "sessionGroup.rename",
          payload: {
            projectId: "web",
            groupId: "grp_parent",
            expectedVersion: 2,
            name: "Renamed",
          },
        },
      ]);
      expect(result).toMatchObject({
        action: "rename",
        target: initial.sessionGroups[0],
        convergence: { status: "confirmed", groups: refreshed.sessionGroups.filter(isWebGroup) },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("adds direct members with observed membership expectations, including atomic moves and no-ops", async () => {
    const fixture = await createTempState();
    const initial = groupSnapshot();
    const moved = withGroups(
      initial,
      initial.sessionGroups.map((group) => {
        if (group.id === "grp_parent")
          return { ...group, sessionIds: ["ses_parent", "ses_child"], version: 3 };
        if (group.id === "grp_child") return { ...group, sessionIds: [], version: 5 };
        return group;
      }),
    );
    const move = snapshotObserverDeps(fixture.socketPath, [initial, moved]);
    const noop = snapshotObserverDeps(fixture.socketPath, [initial, initial]);

    try {
      await runGroupCommand(
        ["members", "add", "grp_parent", "ses_child"],
        { config: fixture.config },
        move.deps,
      );
      expect(move.commands[0]).toEqual({
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "grp_parent",
          expectedVersion: 2,
          add: [{ sessionId: "ses_child", expectedGroupId: "grp_child" }],
        },
      });

      await runGroupCommand(
        ["members", "add", "grp_parent", "ses_parent"],
        { config: fixture.config },
        noop.deps,
      );
      expect(noop.commands[0]).toEqual({
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "grp_parent",
          expectedVersion: 2,
          add: [{ sessionId: "ses_parent", expectedGroupId: "grp_parent" }],
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("removes only direct members and refuses a stale or indirect removal before dispatch", async () => {
    const fixture = await createTempState();
    const initial = groupSnapshot();
    const refreshed = withGroup(initial, "grp_parent", { sessionIds: [] });
    const success = snapshotObserverDeps(fixture.socketPath, [initial, refreshed]);

    try {
      await runGroupCommand(
        ["members", "remove", "grp_parent", "ses_parent"],
        { config: fixture.config },
        success.deps,
      );
      expect(success.commands[0]).toEqual({
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "grp_parent",
          expectedVersion: 2,
          remove: [{ sessionId: "ses_parent", expectedGroupId: "grp_parent" }],
        },
      });

      const refused = snapshotObserverDeps(fixture.socketPath, [initial]);
      await expect(
        runGroupCommand(
          ["members", "remove", "grp_parent", "ses_child"],
          { config: fixture.config },
          refused.deps,
        ),
      ).rejects.toMatchObject({ code: "GROUP_SESSION_NOT_MEMBER" });
      expect(refused.commands).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reparents to a current same-project parent or omits the parent for root", async () => {
    const fixture = await createTempState();
    const initial = groupSnapshot();
    const parented = withGroup(initial, "grp_duplicate", {
      parentGroupId: "grp_parent",
      version: 2,
    });
    const parentHarness = snapshotObserverDeps(fixture.socketPath, [initial, parented]);
    const rooted = withGroup(initial, "grp_child", { parentGroupId: undefined, version: 6 });
    const rootHarness = snapshotObserverDeps(fixture.socketPath, [initial, rooted]);

    try {
      await runGroupCommand(
        ["reparent", "grp_duplicate", "--parent", "grp_parent"],
        { config: fixture.config },
        parentHarness.deps,
      );
      expect(parentHarness.commands[0]).toEqual({
        type: "sessionGroup.reparent",
        payload: {
          projectId: "web",
          groupId: "grp_duplicate",
          expectedVersion: 1,
          parentGroupId: "grp_parent",
        },
      });

      await runGroupCommand(
        ["reparent", "grp_child", "--root"],
        { config: fixture.config },
        rootHarness.deps,
      );
      expect(rootHarness.commands[0]).toEqual({
        type: "sessionGroup.reparent",
        payload: {
          projectId: "web",
          groupId: "grp_child",
          expectedVersion: 4,
        },
      });

      const crossProject = snapshotObserverDeps(fixture.socketPath, [initial]);
      await expect(
        runGroupCommand(
          ["reparent", "grp_parent", "--parent", "grp_api"],
          { config: fixture.config },
          crossProject.deps,
        ),
      ).rejects.toMatchObject({ code: "GROUP_PARENT_PROJECT_MISMATCH" });
      expect(crossProject.commands).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("leaves self-parenting to Observer preconditions", async () => {
    const fixture = await createTempState();
    const rejected = rejectedReceipt("cmd_self_parent");
    const harness = snapshotObserverDeps(fixture.socketPath, [groupSnapshot()], {
      dispatch: async () => rejected,
    });

    try {
      const result = await runGroupCommand(
        ["reparent", "grp_parent", "--parent", "grp_parent"],
        { config: fixture.config },
        harness.deps,
      );
      expect(harness.commands).toHaveLength(1);
      expect(result).toMatchObject({ action: "reparent", outcome: { status: "rejected" } });
      expect(harness.snapshotReads()).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("deletes only the Group definition and confirms member/child projection without lifecycle effects", async () => {
    const fixture = await createTempState();
    const initial = groupSnapshot();
    const refreshed = withGroups(
      initial,
      initial.sessionGroups
        .filter((group) => group.id !== "grp_parent")
        .map((group) =>
          group.id === "grp_child" ? { ...group, parentGroupId: undefined } : group,
        ),
    );
    const harness = snapshotObserverDeps(fixture.socketPath, [initial, refreshed]);

    try {
      const result = await runGroupCommand(
        ["delete", "grp_parent", "--json"],
        { config: fixture.config },
        harness.deps,
      );

      expect(harness.commands).toEqual([
        {
          type: "sessionGroup.delete",
          payload: { projectId: "web", groupId: "grp_parent", expectedVersion: 2 },
        },
      ]);
      expect(result).toMatchObject({
        action: "delete",
        target: initial.sessionGroups[0],
        convergence: { status: "confirmed", projectId: "web" },
      });
      expect(refreshed.sessions).toEqual(initial.sessions);
      expect(refreshed.rows).toEqual(initial.rows);
      expect(refreshed.sessionGroups.find((group) => group.id === "grp_child")).toMatchObject({
        parentGroupId: undefined,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not refresh rejected or failed commands, and keeps correlation on timeout", async () => {
    const fixture = await createTempState();
    const initial = groupSnapshot();
    const rejectedHarness = snapshotObserverDeps(fixture.socketPath, [initial, initial], {
      dispatch: async () => rejectedReceipt("cmd_rejected"),
    });
    const failedHarness = snapshotObserverDeps(fixture.socketPath, [initial, initial], {
      waitForCommand: async (commandId, command) => failedRecord(commandId, command),
    });
    const timeoutHarness = snapshotObserverDeps(fixture.socketPath, [initial], {
      waitForCommand: async () => new Promise<TerminalCommandRecord>(() => undefined),
    });

    try {
      const rejected = await runGroupCommand(
        ["rename", "grp_parent", "Rejected"],
        { config: fixture.config },
        rejectedHarness.deps,
      );
      const failed = await runGroupCommand(
        ["rename", "grp_parent", "Failed"],
        { config: fixture.config },
        failedHarness.deps,
      );
      expect(rejected).toMatchObject({ action: "rename", outcome: { status: "rejected" } });
      expect(failed).toMatchObject({ action: "rename", outcome: { status: "failed" } });
      expect(rejectedHarness.snapshotReads()).toBe(1);
      expect(failedHarness.snapshotReads()).toBe(1);

      await expect(
        runGroupCommand(
          ["rename", "grp_parent", "Timed out"],
          { config: fixture.config, timeoutMs: 10 },
          timeoutHarness.deps,
        ),
      ).rejects.toMatchObject({
        code: "COMMAND_WAIT_TIMEOUT",
        commandId: "cmd_group",
        traceId: "trc_group",
      });
      expect(timeoutHarness.snapshotReads()).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns warning convergence with exit code zero for refresh failure or projection mismatch", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const initial = groupSnapshot();
    const refreshFailure = snapshotObserverDeps(fixture.socketPath, [initial], {
      snapshot: async (read) => {
        if (read === 1) return initial;
        throw new Error("refresh unavailable");
      },
    });
    const mismatch = withGroup(initial, "grp_parent", { name: "Unexpected" });
    const mismatchHarness = snapshotObserverDeps(fixture.socketPath, [initial, mismatch]);
    const membershipMismatchHarness = snapshotObserverDeps(fixture.socketPath, [initial, initial]);
    const deleteMismatchHarness = snapshotObserverDeps(fixture.socketPath, [initial, initial]);

    try {
      const failedRefresh = await runCli(
        ["--config", configPath, "group", "rename", "grp_parent", "Renamed", "--json"],
        { observerDeps: refreshFailure.deps },
      );
      expect(failedRefresh).toMatchObject({ code: 0, output: { action: "rename" } });
      expect(failedRefresh.output).toMatchObject({
        convergence: { status: "warning", projectId: "web", warning: expect.any(Object) },
      });

      const mismatched = await runGroupCommand(
        ["rename", "grp_parent", "Renamed"],
        { config: fixture.config },
        mismatchHarness.deps,
      );
      expect(mismatched).toMatchObject({
        action: "rename",
        convergence: {
          status: "warning",
          groups: mismatch.sessionGroups.filter(isWebGroup),
          warning: { code: "GROUP_RENAME_CONVERGENCE_MISMATCH" },
        },
      });

      const membershipMismatch = await runGroupCommand(
        ["members", "add", "grp_parent", "ses_free"],
        { config: fixture.config },
        membershipMismatchHarness.deps,
      );
      expect(membershipMismatch).toMatchObject({
        convergence: {
          status: "warning",
          warning: {
            message: expect.stringContaining("Group members add command"),
          },
        },
      });
      expect(membershipMismatch.convergence.warning?.message).not.toContain("members_add");

      const deleteMismatch = await runGroupCommand(
        ["delete", "grp_parent"],
        { config: fixture.config },
        deleteMismatchHarness.deps,
      );
      expect(deleteMismatch).toMatchObject({
        convergence: {
          status: "warning",
          warning: {
            hint: expect.stringContaining("stn group list --project web --json"),
          },
        },
      });
      expect(deleteMismatch.convergence.warning?.hint).not.toContain("group get grp_parent");
    } finally {
      await fixture.cleanup();
    }
  });
});

function textOutput(result: { output?: unknown }): string {
  expect(typeof result.output).toBe("string");
  return String(result.output);
}

function isWebGroup(group: SessionGroupView): boolean {
  return group.projectId === "web";
}

function snapshotObserverDeps(
  socketPath: string,
  snapshots: readonly StationSnapshot[],
  options: {
    dispatch?: (command: StationCommand) => Promise<CommandReceipt>;
    snapshot?: (read: number) => Promise<StationSnapshot>;
    waitForCommand?: (commandId: string, command: StationCommand) => Promise<TerminalCommandRecord>;
  } = {},
): {
  deps: ObserverProcessDeps;
  commands: StationCommand[];
  snapshotReads: () => number;
} {
  let reads = 0;
  let lastCommand: StationCommand | undefined;
  const commands: StationCommand[] = [];
  const deps: ObserverProcessDeps = {
    buildVersion: observerBuildVersion,
    clientFactory: (requestedSocketPath: string) =>
      ({
        health: async () => ({
          schemaVersion: "0.12.0",
          status: "healthy",
          pid: 1234,
          startedAt: now,
          version: observerBuildVersion,
          socketPath: requestedSocketPath,
        }),
        getSnapshot: async () => {
          reads += 1;
          if (options.snapshot !== undefined) return options.snapshot(reads);
          const snapshot = snapshots[reads - 1] ?? snapshots.at(-1);
          if (snapshot === undefined) throw new Error("No snapshot fixture is available.");
          return snapshot;
        },
        dispatch: async (command: StationCommand) => {
          lastCommand = command;
          commands.push(command);
          return options.dispatch?.(command) ?? acceptedReceipt("cmd_group");
        },
        waitForCommand: async (commandId: string) => {
          if (lastCommand === undefined) throw new Error("No command was dispatched.");
          return (
            options.waitForCommand?.(commandId, lastCommand) ??
            succeededRecord(commandId, lastCommand)
          );
        },
      }) as never,
    sleep: async () => undefined,
    socketPath,
  };
  return { deps, commands, snapshotReads: () => reads };
}

function acceptedReceipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_group",
    spanId: "spn_group",
    accepted: true,
    status: "accepted",
  };
}

function rejectedReceipt(commandId: string): CommandReceipt {
  return {
    commandId,
    traceId: "trc_group",
    spanId: "spn_group",
    accepted: false,
    status: "rejected",
    error: {
      tag: "CommandRejectedError",
      code: "GROUP_COMMAND_REJECTED",
      message: "The Group command was rejected by Observer preconditions.",
      hint: "Refresh Group state.",
    },
  };
}

function succeededRecord(
  id: string,
  command: StationCommand,
  result?: unknown,
): TerminalCommandRecord {
  const record = {
    id,
    type: command.type,
    command,
    status: "succeeded" as const,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    traceId: "trc_group",
    spanId: "spn_group",
    ...(result === undefined ? {} : { result }),
  } as unknown as CommandRecord;
  return record as TerminalCommandRecord;
}

function failedRecord(id: string, command: StationCommand): TerminalCommandRecord {
  return {
    id,
    type: command.type,
    command,
    status: "failed",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    traceId: "trc_group",
    spanId: "spn_group",
    error: {
      tag: "CommandExecutionError",
      code: "GROUP_COMMAND_FAILED",
      message: "The Group command failed in Observer.",
    },
  } as TerminalCommandRecord;
}

function groupView(
  id: string,
  projectId: string,
  name: string,
  sessionIds: string[],
  version: number,
  parentGroupId?: string,
): SessionGroupView {
  const group: SessionGroupView = {
    id,
    projectId,
    name,
    sessionIds,
    version,
    createdAt: now,
    updatedAt: now,
  } as SessionGroupView;
  if (parentGroupId !== undefined) group.parentGroupId = parentGroupId;
  return group;
}

function withGroup(
  snapshot: StationSnapshot,
  id: string,
  changes: Partial<SessionGroupView>,
): StationSnapshot {
  return withGroups(
    snapshot,
    snapshot.sessionGroups.map((group) => (group.id === id ? { ...group, ...changes } : group)),
  );
}

function withGroups(snapshot: StationSnapshot, sessionGroups: SessionGroupView[]): StationSnapshot {
  return StationSnapshotSchema.parse({ ...snapshot, sessionGroups });
}

function groupSnapshot(): StationSnapshot {
  return snapshotWithGroups();
}

function snapshotWithGroups(): StationSnapshot {
  const sessions = [
    sessionView("ses_parent", "web", "wt_parent", "Parent session"),
    sessionView("ses_child", "web", "wt_child", "Child session"),
    sessionView("ses_free", "web", "wt_free", "Free session"),
    sessionView("ses_free_2", "web", "wt_free_2", "Second free session"),
    sessionView("ses_api", "api", "wt_api", "API session"),
  ];
  const rows = sessions.map((session) => ({
    id: session.worktreeId,
    projectId: session.projectId,
    projectLabel: session.projectId === "web" ? "Web App" : "API Service",
    title: session.title,
    branch: `feature/${session.id}`,
    path: `/projects/${session.projectId}/${session.id}`,
    registrationIdentity: `registration-${session.id}`,
    worktree: { state: "exists" as const, source: "worktrunk" as const },
    display: { statusLabel: "idle" as const, sortPriority: 10, alert: false },
  }));
  return StationSnapshotSchema.parse({
    schemaVersion: "0.12.0",
    generatedAt: now,
    observer: { pid: 1234, startedAt: now, version: "0.0.0", healthy: true },
    providerHealth: {},
    projects: [
      projectView("web", "Web App", "/projects/web", "codex"),
      projectView("api", "API Service", "/projects/api", "claude"),
    ],
    rows,
    sessions,
    sessionGroups: [
      groupView("grp_parent", "web", "Parent", ["ses_parent"], 2),
      groupView("grp_child", "web", "Child", ["ses_child"], 4, "grp_parent"),
      groupView("grp_duplicate", "web", "Duplicate", [], 1),
      groupView("grp_duplicate_2", "web", "Duplicate", [], 1),
      groupView("grp_api", "api", "API Group", ["ses_api"], 1),
    ],
    counts: {
      projects: 2,
      sessions: 5,
      worktrees: 5,
      agents: 5,
      working: 0,
      idle: 5,
      attention: 0,
      unknown: 0,
    },
    alerts: [],
  });
}

function projectView(id: string, label: string, root: string, harness: string) {
  return {
    id,
    label,
    root,
    defaults: { harness, terminal: "tmux", layout: "agent-build-shell" },
    health: {
      provider: "worktrunk",
      providerType: "worktree",
      status: "healthy",
      lastCheckedAt: now,
    },
    counts: {
      sessions: id === "web" ? 4 : 1,
      worktrees: id === "web" ? 4 : 1,
      agents: id === "web" ? 4 : 1,
      working: 0,
      idle: id === "web" ? 4 : 1,
      attention: 0,
      unknown: 0,
    },
  };
}

function sessionView(id: string, projectId: string, worktreeId: string, title: string) {
  return {
    id,
    origin: "station" as const,
    projectId,
    worktreeId,
    createdAt: now,
    updatedAt: now,
    harness: {
      provider: projectId === "web" ? "codex" : "claude",
      mode: "interactive" as const,
      capabilities: {
        canLaunch: true,
        canDiscoverRuns: true,
        canEmitEvents: true,
        canReceivePrompt: true,
        canResume: true,
        canStop: true,
        canRunNonInteractive: true,
        canExposeApprovalState: true,
        supportsModifiedEnterSoftNewline: false,
      },
    },
    status: {
      value: "idle" as const,
      confidence: "high" as const,
      reason: "Fixture is idle.",
      source: "reconcile" as const,
      updatedAt: now,
    },
    title,
    tags: [],
  };
}
