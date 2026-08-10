import type { StationConfig } from "@station/config";
import type { StationCommand, StationEvent } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CommandQueue, createCommandQueue } from "../../src/commands/queue";
import { registerObserverCommandHandlers } from "../../src/commands/router";
import type { ObserverPersistenceBundle } from "../../src/persistence";
import { createSqliteObserverPersistence } from "../../src/persistence";
import { ProviderRegistry } from "../../src/providers/registry";
import { createObserverCore, type ObserverCore } from "../../src/reconcile/core";
import { createObserverEventBus } from "../../src/runtime/eventBus";
import { openObserverSqlite } from "../../src/sqlite";
import { createInMemoryObserverPersistence } from "../support/inMemoryObserverPersistence";
import { createUnexpectedProjectConfigWriter } from "../support/projectConfigWriter";

const now = "2026-05-20T12:00:00.000Z";
const storageKinds = ["SQLite", "in-memory"] as const;

describe.each(storageKinds)("recorded Session Group commands with %s persistence", (storage) => {
  const fixtures: GroupCommandFixture[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await fixture.queue.shutdown();
      fixture.close();
    }
  });

  async function fixture(
    options: {
      repeatedGroupId?: boolean;
      commandTimeoutMs?: number;
      groupCommitDelayMs?: number;
    } = {},
  ) {
    const created = await createFixture(storage, options);
    fixtures.push(created);
    return created;
  }

  it("creates empty and membered Groups with immediate command-correlated convergence", async () => {
    const test = await fixture();
    const providerReads = vi.spyOn(test.providers.worktree, "listWorktrees");

    const empty = await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "  Empty  " },
    });
    expect(empty.status).toBe("succeeded");
    expect(test.core.getSnapshot().sessionGroups).toEqual([
      expect.objectContaining({
        id: "grp_1",
        projectId: "web",
        name: "Empty",
        sessionIds: [],
        version: 1,
      }),
    ]);

    const membered = await test.dispatch({
      type: "sessionGroup.create",
      payload: {
        projectId: "web",
        name: "Membered",
        initialSessionIds: ["ses_web_a"],
      },
    });
    expect(membered.status).toBe("succeeded");
    expect(test.core.getSnapshot().sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_1", sessionIds: [] }),
      expect.objectContaining({ id: "grp_2", sessionIds: ["ses_web_a"] }),
    ]);
    expect(providerReads).not.toHaveBeenCalled();
    await expect(test.persistence.listEvents({ commandId: membered.id })).resolves.toEqual([
      expect.objectContaining({ type: "command.accepted" }),
      expect.objectContaining({ type: "command.started" }),
      expect.objectContaining({
        type: "sessionGroup.updated",
        event: expect.objectContaining({
          commandId: membered.id,
          group: expect.objectContaining({ id: "grp_2" }),
        }),
      }),
      expect.objectContaining({ type: "command.succeeded" }),
    ]);
  });

  it("emits no Group event or version change for validated rename and membership no-ops", async () => {
    const test = await fixture();
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Stable", initialSessionIds: ["ses_web_a"] },
    });

    const rename = await test.dispatch({
      type: "sessionGroup.rename",
      payload: { projectId: "web", groupId: "grp_1", expectedVersion: 1, name: " Stable " },
    });
    const membership = await test.dispatch({
      type: "sessionGroup.updateMembership",
      payload: { projectId: "web", groupId: "grp_1", expectedVersion: 1, add: [], remove: [] },
    });

    expect(test.core.getSnapshot().sessionGroups[0]).toMatchObject({ version: 1 });
    for (const commandId of [rename.id, membership.id]) {
      expect((await test.persistence.listEvents({ commandId })).map((event) => event.type)).toEqual(
        ["command.accepted", "command.started", "command.succeeded"],
      );
    }
  });

  it("reparents and detaches Groups with immediate flat snapshot convergence", async () => {
    const test = await fixture();
    const providerReads = vi.spyOn(test.providers.worktree, "listWorktrees");
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Parent" },
    });
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Child" },
    });

    const reparent = await test.dispatch({
      type: "sessionGroup.reparent",
      payload: {
        projectId: "web",
        groupId: "grp_2",
        expectedVersion: 1,
        parentGroupId: "grp_1",
      },
    });
    expect(reparent.status).toBe("succeeded");
    expect(test.core.getSnapshot().sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_1", version: 1 }),
      expect.objectContaining({ id: "grp_2", parentGroupId: "grp_1", version: 2 }),
    ]);
    expect(
      (await test.persistence.listEvents({ commandId: reparent.id })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "sessionGroup.updated", "command.succeeded"]);

    const sameParent = await test.dispatch({
      type: "sessionGroup.reparent",
      payload: {
        projectId: "web",
        groupId: "grp_2",
        expectedVersion: 2,
        parentGroupId: "grp_1",
      },
    });
    const rootToRoot = await test.dispatch({
      type: "sessionGroup.reparent",
      payload: { projectId: "web", groupId: "grp_1", expectedVersion: 1 },
    });
    for (const commandId of [sameParent.id, rootToRoot.id]) {
      expect((await test.persistence.listEvents({ commandId })).map((event) => event.type)).toEqual(
        ["command.accepted", "command.started", "command.succeeded"],
      );
    }

    const detach = await test.dispatch({
      type: "sessionGroup.reparent",
      payload: { projectId: "web", groupId: "grp_2", expectedVersion: 2 },
    });
    expect(detach.status).toBe("succeeded");
    expect(test.core.getSnapshot().sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_1", version: 1 }),
      expect.not.objectContaining({ parentGroupId: expect.anything() }),
    ]);
    expect(test.core.getSnapshot().sessionGroups[1]).toMatchObject({ id: "grp_2", version: 3 });
    expect(providerReads).not.toHaveBeenCalled();
  });

  it("rejects invalid reparent ancestry with typed errors and no Group mutation", async () => {
    const test = await fixture();
    for (const [projectId, name] of [
      ["web", "Parent"],
      ["web", "Child"],
      ["web", "Grandchild"],
      ["api", "API"],
    ] as const) {
      await test.dispatch({ type: "sessionGroup.create", payload: { projectId, name } });
    }
    await test.dispatch({
      type: "sessionGroup.reparent",
      payload: {
        projectId: "web",
        groupId: "grp_2",
        expectedVersion: 1,
        parentGroupId: "grp_1",
      },
    });
    await test.dispatch({
      type: "sessionGroup.reparent",
      payload: {
        projectId: "web",
        groupId: "grp_3",
        expectedVersion: 1,
        parentGroupId: "grp_2",
      },
    });
    const before = await test.persistence.listSessionGroups();

    const cases: Array<{ command: StationCommand; code: string }> = [
      {
        command: {
          type: "sessionGroup.reparent",
          payload: {
            projectId: "web",
            groupId: "grp_2",
            expectedVersion: 2,
            parentGroupId: "grp_missing",
          },
        },
        code: "SESSION_GROUP_NOT_FOUND",
      },
      {
        command: {
          type: "sessionGroup.reparent",
          payload: {
            projectId: "web",
            groupId: "grp_2",
            expectedVersion: 2,
            parentGroupId: "grp_4",
          },
        },
        code: "SESSION_GROUP_PROJECT_MISMATCH",
      },
      {
        command: {
          type: "sessionGroup.reparent",
          payload: {
            projectId: "web",
            groupId: "grp_2",
            expectedVersion: 2,
            parentGroupId: "grp_2",
          },
        },
        code: "SESSION_GROUP_PARENT_SELF",
      },
      {
        command: {
          type: "sessionGroup.reparent",
          payload: {
            projectId: "web",
            groupId: "grp_1",
            expectedVersion: 1,
            parentGroupId: "grp_3",
          },
        },
        code: "SESSION_GROUP_PARENT_CYCLE",
      },
      {
        command: {
          type: "sessionGroup.reparent",
          payload: { projectId: "web", groupId: "grp_2", expectedVersion: 1 },
        },
        code: "SESSION_GROUP_VERSION_CONFLICT",
      },
    ];
    for (const { command, code } of cases) {
      const failed = await test.dispatch(command);
      expect(failed).toMatchObject({ status: "failed", error: { code } });
      expect(
        (await test.persistence.listEvents({ commandId: failed.id })).map((event) => event.type),
      ).toEqual(["command.accepted", "command.started", "command.failed"]);
    }
    await expect(test.persistence.listSessionGroups()).resolves.toEqual(before);
  });

  it("terminates on corrupt persisted ancestry and rejects it before commit", async () => {
    if (storage !== "SQLite") return;
    const test = await fixture();
    for (const name of ["A", "B", "X"]) {
      await test.dispatch({
        type: "sessionGroup.create",
        payload: { projectId: "web", name },
      });
    }
    if (test.sqlite === undefined) throw new Error("Expected SQLite persistence.");
    const setParent = test.sqlite.database.prepare(
      "UPDATE session_groups SET parent_group_id = ? WHERE id = ?",
    );
    setParent.run("grp_2", "grp_1");
    setParent.run("grp_1", "grp_2");

    const listed = await test.persistence.listSessionGroups();
    expect(listed.map((group) => group.id)).toEqual(["grp_1", "grp_2", "grp_3"]);
    await expect(
      test.persistence.reparentSessionGroup({
        id: "grp_3",
        expectedVersion: 1,
        parentGroupId: "grp_1",
      }),
    ).rejects.toBeDefined();
    const failed = await test.dispatch({
      type: "sessionGroup.reparent",
      payload: {
        projectId: "web",
        groupId: "grp_3",
        expectedVersion: 1,
        parentGroupId: "grp_1",
      },
    });
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "SESSION_GROUP_PARENT_GRAPH_INVALID" },
    });
    expect(
      (await test.persistence.listSessionGroups()).find((group) => group.id === "grp_3"),
    ).not.toHaveProperty("parentGroupId");
  });

  it("projects only the command project without repairing durable memberships", async () => {
    const test = await fixture();
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Web" },
    });
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "api", name: "API" },
    });
    await test.persistence.updateSessionGroupMembership({
      id: "grp_1",
      expectedVersion: 1,
      add: [{ sessionId: "ses_missing_web", projectId: "web", expectedGroupId: null }],
      updatedAt: "2026-05-20T12:01:00.000Z",
    });
    await test.persistence.updateSessionGroupMembership({
      id: "grp_2",
      expectedVersion: 1,
      add: [{ sessionId: "ses_missing_api", projectId: "api", expectedGroupId: null }],
      updatedAt: "2026-05-20T12:01:00.000Z",
    });

    const command = await test.dispatch({
      type: "sessionGroup.updateMembership",
      payload: { projectId: "web", groupId: "grp_1", expectedVersion: 2, add: [], remove: [] },
    });

    expect(command.status).toBe("succeeded");
    await expect(test.persistence.listSessionGroups()).resolves.toEqual([
      expect.objectContaining({ id: "grp_2", version: 2, sessionIds: ["ses_missing_api"] }),
      expect.objectContaining({ id: "grp_1", version: 2, sessionIds: ["ses_missing_web"] }),
    ]);
    expect(test.core.getSnapshot().sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_2", version: 1, sessionIds: [] }),
      expect.objectContaining({ id: "grp_1", version: 2, sessionIds: [] }),
    ]);
    expect(
      (await test.persistence.listEvents({ commandId: command.id })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "command.succeeded"]);
  });

  it("times out before the Group commit without a late mutation or event", async () => {
    const test = await fixture({ commandTimeoutMs: 5, groupCommitDelayMs: 30 });

    const command = await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Too late" },
    });
    expect(command).toMatchObject({ status: "failed", error: { code: "COMMAND_TIMEOUT" } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(test.persistence.listSessionGroups()).resolves.toEqual([]);
    expect(
      (await test.persistence.listEvents({ commandId: command.id })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "command.failed"]);
    expect(test.publishedEvents.map((event) => event.type)).toEqual([
      "command.accepted",
      "command.started",
      "command.failed",
    ]);
  });

  it("atomically reassigns and ungroups sessions while publishing every changed Group in order", async () => {
    const test = await fixture();
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Source", initialSessionIds: ["ses_web_a"] },
    });
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Target" },
    });

    const move = await test.dispatch({
      type: "sessionGroup.updateMembership",
      payload: {
        projectId: "web",
        groupId: "grp_2",
        expectedVersion: 1,
        add: [{ sessionId: "ses_web_a", expectedGroupId: "grp_1" }],
      },
    });
    expect(test.core.getSnapshot().sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_1", version: 2, sessionIds: [] }),
      expect.objectContaining({ id: "grp_2", version: 2, sessionIds: ["ses_web_a"] }),
    ]);
    expect(
      (await test.persistence.listEvents({ commandId: move.id }))
        .filter((event) => event.type === "sessionGroup.updated")
        .map((event) =>
          event.event.type === "sessionGroup.updated" ? event.event.group.id : undefined,
        ),
    ).toEqual(["grp_1", "grp_2"]);

    const ungroup = await test.dispatch({
      type: "sessionGroup.updateMembership",
      payload: {
        projectId: "web",
        groupId: "grp_2",
        expectedVersion: 2,
        remove: [{ sessionId: "ses_web_a", expectedGroupId: "grp_2" }],
      },
    });
    expect(ungroup.status).toBe("succeeded");
    expect(test.core.getSnapshot().sessionGroups[1]).toMatchObject({
      id: "grp_2",
      version: 3,
      sessionIds: [],
    });
  });

  it("rejects stale versions and assignment expectations without partial mutation", async () => {
    const test = await fixture();
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Source", initialSessionIds: ["ses_web_a"] },
    });
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Target" },
    });

    const stale = await test.dispatch({
      type: "sessionGroup.rename",
      payload: { projectId: "web", groupId: "grp_2", expectedVersion: 2, name: "Changed" },
    });
    expect(stale).toMatchObject({
      status: "failed",
      error: { code: "SESSION_GROUP_VERSION_CONFLICT" },
    });
    const assignment = await test.dispatch({
      type: "sessionGroup.updateMembership",
      payload: {
        projectId: "web",
        groupId: "grp_2",
        expectedVersion: 1,
        add: [{ sessionId: "ses_web_a", expectedGroupId: null }],
      },
    });
    expect(assignment).toMatchObject({
      status: "failed",
      error: { code: "SESSION_GROUP_ASSIGNMENT_CONFLICT" },
    });
    await expect(test.persistence.listSessionGroups()).resolves.toEqual([
      expect.objectContaining({ id: "grp_1", version: 1, sessionIds: ["ses_web_a"] }),
      expect.objectContaining({ id: "grp_2", version: 1, sessionIds: [] }),
    ]);
  });

  it("rejects missing and cross-project Groups and sessions before durable mutation", async () => {
    const test = await fixture();
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Web" },
    });

    const commands: Array<{ command: StationCommand; code: string }> = [
      {
        command: {
          type: "sessionGroup.rename",
          payload: { projectId: "web", groupId: "grp_missing", expectedVersion: 1, name: "No" },
        },
        code: "SESSION_GROUP_NOT_FOUND",
      },
      {
        command: {
          type: "sessionGroup.rename",
          payload: { projectId: "api", groupId: "grp_1", expectedVersion: 1, name: "No" },
        },
        code: "SESSION_GROUP_PROJECT_MISMATCH",
      },
      {
        command: {
          type: "sessionGroup.create",
          payload: { projectId: "web", name: "Missing", initialSessionIds: ["ses_missing"] },
        },
        code: "SESSION_NOT_FOUND",
      },
      {
        command: {
          type: "sessionGroup.create",
          payload: { projectId: "web", name: "Cross", initialSessionIds: ["ses_api_a"] },
        },
        code: "SESSION_GROUP_SESSION_PROJECT_MISMATCH",
      },
      {
        command: {
          type: "sessionGroup.create",
          payload: { projectId: "missing", name: "No project" },
        },
        code: "PROJECT_NOT_FOUND",
      },
    ];
    for (const { command, code } of commands) {
      await expect(test.dispatch(command)).resolves.toMatchObject({
        status: "failed",
        error: { code },
      });
    }
    await expect(test.persistence.listSessionGroups()).resolves.toEqual([
      expect.objectContaining({ id: "grp_1", projectId: "web", version: 1 }),
    ]);
  });

  it("deletes one Group, reparents direct children, and publishes canonical child updates first", async () => {
    const test = await fixture();
    const before = test.core.getSnapshot();
    for (const [name, initialSessionIds] of [
      ["Root", undefined],
      ["Parent", ["ses_web_a"]],
      ["Child A", undefined],
      ["Child B", undefined],
      ["Grandchild", undefined],
    ] as const) {
      await test.dispatch({
        type: "sessionGroup.create",
        payload: {
          projectId: "web",
          name,
          ...(initialSessionIds === undefined ? {} : { initialSessionIds: [...initialSessionIds] }),
        },
      });
    }
    for (const [groupId, parentGroupId] of [
      ["grp_2", "grp_1"],
      ["grp_3", "grp_2"],
      ["grp_4", "grp_2"],
      ["grp_5", "grp_3"],
    ] as const) {
      await test.dispatch({
        type: "sessionGroup.reparent",
        payload: { projectId: "web", groupId, expectedVersion: 1, parentGroupId },
      });
    }

    const deleted = await test.dispatch({
      type: "sessionGroup.delete",
      payload: { projectId: "web", groupId: "grp_2", expectedVersion: 2 },
    });
    expect(deleted.status).toBe("succeeded");
    expect(test.core.getSnapshot().sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_1", version: 1, sessionIds: [] }),
      expect.objectContaining({ id: "grp_3", parentGroupId: "grp_1", version: 3 }),
      expect.objectContaining({ id: "grp_4", parentGroupId: "grp_1", version: 3 }),
      expect.objectContaining({ id: "grp_5", parentGroupId: "grp_3", version: 2 }),
    ]);
    expect(test.core.getSnapshot().sessions).toEqual(before.sessions);
    expect(test.core.getSnapshot().rows).toEqual(before.rows);
    expect(
      (await test.persistence.listEvents({ commandId: deleted.id })).map((event) =>
        event.event.type === "sessionGroup.updated"
          ? `${event.type}:${event.event.group.id}`
          : event.type,
      ),
    ).toEqual([
      "command.accepted",
      "command.started",
      "sessionGroup.updated:grp_3",
      "sessionGroup.updated:grp_4",
      "sessionGroup.removed",
      "command.succeeded",
    ]);

    const repeated = await test.dispatch({
      type: "sessionGroup.delete",
      payload: { projectId: "web", groupId: "grp_2", expectedVersion: 2 },
    });
    expect(repeated).toMatchObject({
      status: "failed",
      error: { code: "SESSION_GROUP_NOT_FOUND" },
    });
    expect(test.core.getSnapshot().sessionGroups).toEqual([
      expect.objectContaining({ id: "grp_1", version: 1 }),
      expect.objectContaining({ id: "grp_3", version: 3 }),
      expect.objectContaining({ id: "grp_4", version: 3 }),
      expect.objectContaining({ id: "grp_5", version: 2 }),
    ]);
  });

  it("deletes only Group organization and reports generated id collisions", async () => {
    const test = await fixture({ repeatedGroupId: true });
    const before = test.core.getSnapshot();
    await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Disposable", initialSessionIds: ["ses_web_a"] },
    });
    const collision = await test.dispatch({
      type: "sessionGroup.create",
      payload: { projectId: "web", name: "Collision" },
    });
    expect(collision).toMatchObject({
      status: "failed",
      error: { code: "SESSION_GROUP_ID_COLLISION" },
    });

    const deleted = await test.dispatch({
      type: "sessionGroup.delete",
      payload: { projectId: "web", groupId: "grp_1", expectedVersion: 1 },
    });
    expect(deleted.status).toBe("succeeded");
    expect(test.core.getSnapshot().sessionGroups).toEqual([]);
    expect(test.core.getSnapshot().sessions).toEqual(before.sessions);
    expect(test.core.getSnapshot().rows).toEqual(before.rows);
    expect(
      (await test.persistence.listEvents({ commandId: deleted.id })).map((event) => event.type),
    ).toEqual(["command.accepted", "command.started", "sessionGroup.removed", "command.succeeded"]);
  });
});

type GroupCommandFixture = {
  persistence: ObserverPersistenceBundle;
  providers: ProviderRegistry;
  core: ObserverCore;
  queue: CommandQueue;
  sqlite: ReturnType<typeof openObserverSqlite> | undefined;
  publishedEvents: StationEvent[];
  dispatch(
    command: StationCommand,
  ): Promise<NonNullable<Awaited<ReturnType<ObserverPersistenceBundle["getCommand"]>>>>;
  close(): void;
};

async function createFixture(
  storage: (typeof storageKinds)[number],
  options: {
    repeatedGroupId?: boolean;
    commandTimeoutMs?: number;
    groupCommitDelayMs?: number;
  },
): Promise<GroupCommandFixture> {
  let instant = Date.parse(now);
  const clock = { now: () => new Date(instant++) };
  const idFactory = ids(options);
  const sqlite = storage === "SQLite" ? openObserverSqlite({ clock }) : undefined;
  const persistence =
    sqlite === undefined
      ? createInMemoryObserverPersistence({ clock, idFactory })
      : createSqliteObserverPersistence({ sqlite, clock, idFactory });
  const providers = fakeProviders();
  const core = createObserverCore({ config, providers, persistence, clock });
  await core.reconcile("session-group-command-fixture");
  const groupCommitDelayMs = options.groupCommitDelayMs;
  const handlerCore: ObserverCore =
    groupCommitDelayMs === undefined
      ? core
      : {
          ...core,
          commitSessionGroupMutation: async (projectId, mutate) => {
            await new Promise((resolve) => setTimeout(resolve, groupCommitDelayMs));
            return core.commitSessionGroupMutation(projectId, mutate);
          },
        };
  const eventBus = createObserverEventBus();
  const publishedEvents: StationEvent[] = [];
  vi.spyOn(eventBus, "publish").mockImplementation((event) => publishedEvents.push(event));
  const queue = createCommandQueue({
    persistence,
    clock,
    idFactory,
    eventBus,
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
  });
  registerObserverCommandHandlers({
    queue,
    core: handlerCore,
    providers,
    projects: config.projects,
    persistence,
    eventBus,
    clock,
    idFactory,
    projectConfigWriter: createUnexpectedProjectConfigWriter(),
  });

  return {
    persistence,
    providers,
    core,
    queue,
    sqlite,
    publishedEvents,
    dispatch: async (command) => {
      const receipt = await queue.dispatch(command);
      await queue.drain();
      const record = await persistence.getCommand(receipt.commandId);
      if (record === undefined) throw new Error("Expected a persisted command record.");
      return record;
    },
    close: () => sqlite?.close(),
  };
}

function ids(options: { repeatedGroupId?: boolean }) {
  let command = 0;
  let event = 0;
  let error = 0;
  let observation = 0;
  let group = 0;
  return {
    commandId: () => `cmd_${++command}`,
    eventId: () => `evt_${++event}`,
    errorId: () => `err_${++error}`,
    observationId: () => `obs_${++observation}`,
    sessionGroupId: () => `grp_${options.repeatedGroupId === true ? 1 : ++group}`,
  };
}

function fakeProviders(): ProviderRegistry {
  const sessions = [
    { projectId: "web", worktreeId: "wt_web_a", sessionId: "ses_web_a", runId: "run_web_a" },
    { projectId: "web", worktreeId: "wt_web_b", sessionId: "ses_web_b", runId: "run_web_b" },
    { projectId: "api", worktreeId: "wt_api_a", sessionId: "ses_api_a", runId: "run_api_a" },
  ];
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({
      now,
      worktrees: sessions.map(({ projectId, worktreeId }) =>
        createFakeWorktree({ id: worktreeId, projectId, now }),
      ),
    }),
    terminal: new FakeTerminalProvider({
      now,
      targets: sessions.map(({ projectId, worktreeId, sessionId, runId }) =>
        createFakeTerminalTarget({
          id: `term_${sessionId}`,
          projectId,
          worktreeId,
          sessionId,
          harnessRunId: runId,
          now,
        }),
      ),
    }),
    harnesses: [
      new FakeHarnessProvider({
        now,
        runs: sessions.map(({ projectId, worktreeId, sessionId, runId }) =>
          createFakeHarnessRun({
            id: runId,
            projectId,
            worktreeId,
            sessionId,
            state: "idle",
            now,
          }),
        ),
      }),
    ],
  });
}

const config: StationConfig = {
  schemaVersion: 1,
  defaults: {
    worktreeProvider: "fake-worktree",
    terminal: "fake-terminal",
    harness: "fake-harness",
    layout: "agent-shell",
  },
  projects: ["web", "api"].map((projectId) => ({
    id: projectId,
    label: projectId,
    root: `/tmp/station/${projectId}`,
    defaults: {
      harness: "fake-harness",
      terminal: "fake-terminal",
      layout: "agent-shell" as const,
    },
    worktrunk: { enabled: true },
  })),
};
