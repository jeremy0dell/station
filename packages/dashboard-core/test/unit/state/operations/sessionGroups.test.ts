import type { StationSnapshot } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { dashboardRowIds, selectDashboardTree } from "../../../../src/selectors/dashboardTree.js";
import { dashboardExecution } from "../../../../src/state/capabilities/execution.js";
import { buildCreateSessionGroupCommand } from "../../../../src/state/commandBuilders.js";
import { createDashboardCapabilityOperationRunner } from "../../../../src/state/operations/capabilityOperation.js";
import { runQuickSessionInGroupOperation } from "../../../../src/state/operations/groupQuickSession.js";
import { runCreateSessionGroupOperation } from "../../../../src/state/operations/sessionGroups.js";
import type {
  CreateQuickSessionInGroupOperation,
  CreateSessionGroupOperation,
} from "../../../../src/state/operations/types.js";
import { createDashboardRuntimeEffectScope } from "../../../../src/state/runtimeEffectScope.js";
import { createInitialTuiState, replaceSnapshot } from "../../../../src/state/screen.js";
import type { DashboardState } from "../../../../src/state/types.js";
import { createGroupedDashboardSnapshot, fixtureNow, row } from "../../../fixtures/snapshots.js";
import { createFakeDashboardCapabilities } from "../../../support/fakeDashboardCapabilities.js";
import { FakeTuiObserverService } from "../../../support/fakeObserverService.js";

describe("Create Session Group operation", () => {
  it("creates an empty durable Group and focuses its identity without launching", async () => {
    const setup = createOperationSetup(false);

    await setup.run();

    expect(setup.service.dispatched).toEqual([setup.operation.command]);
    expect(setup.capabilities.quickCreateRequests).toEqual([]);
    expect(setup.store.getState()).toMatchObject({
      screen: { name: "dashboard" },
      dashboardFocus: { rowId: "group:group_new", cellId: "identity" },
    });
    await setup.scope.dispose();
  });

  it("launches through Quick Session then records expected membership and focuses once", async () => {
    const setup = createOperationSetup(true);

    await setup.run();

    expect(setup.capabilities.quickCreateRequests).toHaveLength(1);
    const request = setup.capabilities.quickCreateRequests[0];
    expect(request).toMatchObject({
      project: { id: "web" },
      harness: "codex",
    });
    expect(setup.service.dispatched.map((command) => command.type)).toEqual([
      "sessionGroup.create",
      "sessionGroup.updateMembership",
    ]);
    expect(setup.service.dispatched[1]).toEqual({
      type: "sessionGroup.updateMembership",
      payload: {
        projectId: "web",
        groupId: "group_new",
        expectedVersion: 1,
        add: [{ sessionId: "ses_wt_web_quick_group", expectedGroupId: null }],
      },
    });
    expect(setup.store.getState().localRows.pendingCreate).toEqual([]);
    expect(setup.store.getState().dashboardFocus).toEqual({
      rowId: "session:ses_wt_web_quick_group",
      cellId: "identity",
    });
    expect(request?.hiddenBranch).toBe(request?.title);
    await setup.scope.dispose();
  });

  it("retains a submitted sheet when Group creation is rejected", async () => {
    const snapshot = createGroupedDashboardSnapshot();
    const store = createStore<DashboardState>(() => ({
      ...createInitialTuiState({ initialSnapshot: snapshot }),
      screen: {
        name: "createGroup",
        projectId: "web",
        draftName: { value: "Launches", cursor: 8 },
        quickSession: false,
        focus: "create",
        submitting: true,
        returnTo: "projectMenu",
      },
    }));
    const service = new FakeTuiObserverService(snapshot);
    service.nextReceipt = {
      commandId: "cmd_rejected",
      accepted: false,
      status: "rejected",
      error: {
        tag: "CommandValidationError",
        code: "GROUP_REJECTED",
        message: "Group creation was rejected.",
      },
    };
    const scope = createDashboardRuntimeEffectScope();
    const capabilities = createDashboardCapabilityOperationRunner({
      getStore: () => store,
      capabilities: createFakeDashboardCapabilities(),
      clientLabel: "test",
      scope,
    });

    await runCreateSessionGroupOperation({
      store,
      service,
      capabilities,
      operation: operation(snapshot, false),
      clientLabel: "test",
      scope,
    });

    expect(store.getState().screen).toMatchObject({
      name: "createGroup",
      submitting: false,
      draftName: { value: "Launches" },
      focus: "create",
    });
    expect(store.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "Group creation was rejected.",
    });
    await scope.dispose();
  });

  it("keeps the durable Group and ordinary failed row when Quick Session fails", async () => {
    const setup = createOperationSetup(true);
    setup.capabilities.quickCreateHandle = () =>
      dashboardExecution(
        {
          kind: "failure",
          disposition: "retain-failed",
          error: {
            tag: "StationLaunchError",
            code: "QUICK_LAUNCH_FAILED",
            message: "Quick Session failed.",
          },
        },
        { optimistic: "pending-create" },
      );

    await setup.run();

    expect(setup.service.dispatched.map((command) => command.type)).toEqual([
      "sessionGroup.create",
    ]);
    expect(setup.store.getState().snapshot?.sessionGroups).toContainEqual(
      expect.objectContaining({ id: "group_new", sessionIds: [] }),
    );
    expect(setup.store.getState().localRows.failedCreate).toEqual([
      expect.not.objectContaining({ targetGroupId: expect.anything() }),
    ]);
    expect(setup.store.getState().dashboardFocus).toEqual({
      rowId: "group:group_new",
      cellId: "identity",
    });
    await setup.scope.dispose();
  });

  it("does not launch again when canonical Quick Session correlation is missing", async () => {
    const setup = createOperationSetup(true);
    setup.capabilities.quickCreateHandle = () => {
      setup.service.setSnapshot(withCreatedGroup(createGroupedDashboardSnapshot()));
      return dashboardExecution({ kind: "success" }, { optimistic: "pending-create" });
    };

    await setup.run();

    expect(setup.capabilities.quickCreateRequests).toHaveLength(1);
    expect(setup.service.dispatched.map((command) => command.type)).toEqual([
      "sessionGroup.create",
    ]);
    expect(setup.store.getState().localRows.pendingCreate).toEqual([]);
    expect(setup.store.getState().toasts.at(-1)?.toast).toMatchObject({
      kind: "error",
      message: "The new session could not be identified uniquely.",
    });
    await setup.scope.dispose();
  });

  it("closes safely when the created Group cannot be correlated uniquely", async () => {
    const setup = createOperationSetup(false);
    const initial = createGroupedDashboardSnapshot();
    const created = withCreatedGroup(initial);
    const createdGroup = created.sessionGroups.find((group) => group.id === "group_new");
    if (createdGroup === undefined) throw new Error("created Group fixture missing");
    setup.service.waitForCommandCompletion = async (commandId) => {
      setup.store.setState(
        replaceSnapshot(setup.store.getState(), {
          ...created,
          sessionGroups: [...created.sessionGroups, { ...createdGroup, id: "group_new_duplicate" }],
        }),
      );
      return { status: "succeeded", commandId };
    };

    await setup.run();

    expect(setup.capabilities.quickCreateRequests).toEqual([]);
    expect(setup.store.getState()).toMatchObject({
      screen: { name: "dashboard" },
      dashboardFocus: { rowId: "project:web", cellId: "menu" },
    });
    expect(setup.store.getState().toasts.at(-1)?.toast).toMatchObject({
      message: "The created Group could not be identified uniquely.",
    });
    await setup.scope.dispose();
  });

  it("keeps the durable Group when the Project default cannot launch Quick Session", async () => {
    const initial = createGroupedDashboardSnapshot();
    const unavailable = {
      ...initial,
      projects: initial.projects.map((project) =>
        project.id === "web"
          ? { ...project, health: { ...project.health, status: "unavailable" as const } }
          : project,
      ),
    };
    const setup = createOperationSetup(true, unavailable);

    await setup.run();

    expect(setup.service.dispatched.map((command) => command.type)).toEqual([
      "sessionGroup.create",
    ]);
    expect(setup.capabilities.quickCreateRequests).toEqual([]);
    expect(setup.store.getState().snapshot?.sessionGroups).toContainEqual(
      expect.objectContaining({ id: "group_new", sessionIds: [] }),
    );
    expect(setup.store.getState().dashboardFocus).toEqual({
      rowId: "group:group_new",
      cellId: "identity",
    });
    await setup.scope.dispose();
  });

  it("reports successful membership that does not converge without relaunching", async () => {
    const setup = createOperationSetup(true);
    const created = withCreatedGroup(createGroupedDashboardSnapshot());
    setup.service.waitForCommandCompletion = async (commandId) => {
      if (setup.service.dispatched.at(-1)?.type === "sessionGroup.create") {
        setup.store.setState(replaceSnapshot(setup.store.getState(), created));
      }
      return { status: "succeeded", commandId };
    };

    await setup.run();

    expect(setup.capabilities.quickCreateRequests).toHaveLength(1);
    expect(setup.store.getState().localRows.pendingCreate).toEqual([]);
    expect(setup.store.getState().dashboardFocus).toEqual({
      rowId: "session:ses_wt_web_quick_group",
      cellId: "identity",
    });
    expect(setup.store.getState().toasts.at(-1)?.toast).toMatchObject({
      message: "The new session did not converge into its Group.",
    });
    await setup.scope.dispose();
  });

  it("does not retry an expected membership conflict", async () => {
    const setup = createOperationSetup(true);
    const successfulWait = setup.service.waitForCommandCompletion.bind(setup.service);
    setup.service.waitForCommandCompletion = async (commandId) => {
      if (setup.service.dispatched.at(-1)?.type === "sessionGroup.updateMembership") {
        const current = setup.store.getState().snapshot;
        if (current !== undefined) {
          setup.store.setState(
            replaceSnapshot(setup.store.getState(), {
              ...current,
              sessionGroups: current.sessionGroups.map((group) =>
                group.id === "group_build"
                  ? { ...group, sessionIds: [...group.sessionIds, "ses_wt_web_quick_group"] }
                  : group,
              ),
            }),
          );
        }
        return {
          status: "failed",
          commandId,
          error: {
            tag: "CommandExecutionError",
            code: "SESSION_GROUP_EXPECTATION_CONFLICT",
            message: "Session membership changed concurrently.",
          },
        };
      }
      return successfulWait(commandId);
    };

    await setup.run();

    expect(setup.service.dispatched.map((command) => command.type)).toEqual([
      "sessionGroup.create",
      "sessionGroup.updateMembership",
    ]);
    expect(setup.store.getState().localRows.pendingCreate).toEqual([]);
    expect(setup.store.getState().dashboardFocus).toEqual({
      rowId: "session:ses_wt_web_quick_group",
      cellId: "identity",
    });
    expect(setup.store.getState().toasts.at(-1)?.toast).toMatchObject({
      message: "Session membership changed concurrently.",
    });
    const state = setup.store.getState();
    if (state.snapshot === undefined) throw new Error("snapshot missing");
    expect(
      selectDashboardTree(state.snapshot, state, state.screen).rowById.get(
        dashboardRowIds.session("ses_wt_web_quick_group"),
      )?.parentId,
    ).toBe(dashboardRowIds.group("group_build"));
    await setup.scope.dispose();
  });

  it("does not reopen a submitted sheet after its Project disappears", async () => {
    const snapshot = createGroupedDashboardSnapshot();
    const store = createStore<DashboardState>(() => ({
      ...createInitialTuiState({ initialSnapshot: snapshot }),
      screen: {
        name: "createGroup",
        projectId: "web",
        draftName: { value: "Launches", cursor: 8 },
        quickSession: false,
        focus: "create",
        submitting: true,
        returnTo: "projectMenu",
      },
    }));
    const service = new FakeTuiObserverService(snapshot);
    service.waitForCommandCompletion = async (commandId) => {
      const withoutProject = {
        ...snapshot,
        projects: snapshot.projects.filter((project) => project.id !== "web"),
        sessionGroups: snapshot.sessionGroups.filter((group) => group.projectId !== "web"),
      };
      store.setState(replaceSnapshot(store.getState(), withoutProject));
      return {
        status: "failed",
        commandId,
        error: {
          tag: "CommandExecutionError",
          code: "PROJECT_REMOVED",
          message: "Project was removed.",
        },
      };
    };
    const scope = createDashboardRuntimeEffectScope();

    await runCreateSessionGroupOperation({
      store,
      service,
      capabilities: createDashboardCapabilityOperationRunner({
        getStore: () => store,
        capabilities: createFakeDashboardCapabilities(),
        clientLabel: "test",
        scope,
      }),
      operation: operation(snapshot, false),
      clientLabel: "test",
      scope,
    });

    expect(store.getState().screen).toEqual({ name: "dashboard" });
    expect(store.getState().toasts.at(-1)?.toast).toMatchObject({
      message: "Project was removed.",
    });
    await scope.dispose();
  });
});

describe("Quick Session in existing Group operation", () => {
  it("launches once, records latest expected membership, and focuses the canonical session", async () => {
    const setup = createExistingGroupQuickSetup();

    await setup.run();

    expect(setup.capabilities.quickCreateRequests).toEqual([
      expect.objectContaining({
        project: expect.objectContaining({ id: "web" }),
        title: setup.operation.title,
        hiddenBranch: setup.operation.hiddenBranch,
      }),
    ]);
    expect(setup.capabilities.quickCreateRequests[0]).not.toHaveProperty("group");
    expect(setup.service.dispatched).toEqual([
      {
        type: "sessionGroup.updateMembership",
        payload: {
          projectId: "web",
          groupId: "group_active",
          expectedVersion: 1,
          add: [{ sessionId: "ses_wt_web_quick_group", expectedGroupId: null }],
        },
      },
    ]);
    expect(setup.store.getState().localRows.pendingCreate).toEqual([]);
    expect(setup.store.getState().dashboardFocus).toEqual({
      rowId: "session:ses_wt_web_quick_group",
      cellId: "identity",
    });
    await setup.scope.dispose();
  });

  it("does not launch after the target Group disappears", async () => {
    const setup = createExistingGroupQuickSetup();
    const current = setup.store.getState().snapshot;
    if (current === undefined) throw new Error("snapshot missing");
    setup.store.setState(
      replaceSnapshot(setup.store.getState(), {
        ...current,
        sessionGroups: current.sessionGroups.filter(
          (group) => group.id !== setup.operation.groupId,
        ),
      }),
    );

    await setup.run();

    expect(setup.capabilities.quickCreateRequests).toEqual([]);
    expect(setup.service.dispatched).toEqual([]);
    expect(setup.store.getState().toasts.at(-1)?.toast).toMatchObject({
      message: "The Group is no longer available.",
    });
    await setup.scope.dispose();
  });

  it("keeps the ordinary failed row and returns focus to the Group quick cell", async () => {
    const setup = createExistingGroupQuickSetup();
    setup.capabilities.quickCreateHandle = () =>
      dashboardExecution(
        {
          kind: "failure",
          disposition: "retain-failed",
          error: {
            tag: "StationLaunchError",
            code: "QUICK_LAUNCH_FAILED",
            message: "Quick Session failed.",
          },
        },
        { optimistic: "pending-create" },
      );

    await setup.run();

    expect(setup.capabilities.quickCreateRequests).toHaveLength(1);
    expect(setup.service.dispatched).toEqual([]);
    expect(setup.store.getState().localRows.failedCreate).toEqual([
      expect.not.objectContaining({ targetGroupId: expect.anything() }),
    ]);
    expect(setup.store.getState().dashboardFocus).toEqual({
      rowId: dashboardRowIds.group("group_active"),
      cellId: "quickSession",
    });
    await setup.scope.dispose();
  });
});

function createOperationSetup(
  quickSession: boolean,
  initial: StationSnapshot = createGroupedDashboardSnapshot(),
) {
  const created = withCreatedGroup(initial);
  const store = createStore<DashboardState>(() =>
    createInitialTuiState({ initialSnapshot: initial }),
  );
  const service = new FakeTuiObserverService(initial);
  const capabilities = createFakeDashboardCapabilities();
  const scope = createDashboardRuntimeEffectScope();
  const capabilityRunner = createDashboardCapabilityOperationRunner({
    getStore: () => store,
    capabilities,
    clientLabel: "test",
    scope,
  });
  const groupOperation = operation(initial, quickSession);

  capabilities.quickCreateHandle = (request) => {
    service.setSnapshot(withLaunchedSession(created, request.hiddenBranch));
    return dashboardExecution({ kind: "success" }, { optimistic: "pending-create" });
  };
  service.waitForCommandCompletion = async (commandId) => {
    const command = service.dispatched.at(-1);
    if (command?.type === "sessionGroup.create") {
      store.setState(replaceSnapshot(store.getState(), created));
    } else if (command?.type === "sessionGroup.updateMembership") {
      const current = store.getState().snapshot;
      if (current !== undefined) {
        const converged = {
          ...current,
          sessionGroups: current.sessionGroups.map((group) =>
            group.id === "group_new"
              ? {
                  ...group,
                  version: group.version + 1,
                  sessionIds: ["ses_wt_web_quick_group"],
                }
              : group,
          ),
        };
        store.setState(replaceSnapshot(store.getState(), converged));
      }
    }
    return { status: "succeeded", commandId };
  };

  return {
    store,
    service,
    capabilities,
    scope,
    operation: groupOperation,
    run: () =>
      runCreateSessionGroupOperation({
        store,
        service,
        capabilities: capabilityRunner,
        operation: groupOperation,
        clientLabel: "test",
        scope,
      }),
  };
}

function createExistingGroupQuickSetup() {
  const initial = createGroupedDashboardSnapshot();
  const project = initial.projects.find((candidate) => candidate.id === "web");
  if (project === undefined) throw new Error("project fixture missing");
  const operation: CreateQuickSessionInGroupOperation = {
    type: "quickCreateSessionInGroup",
    localId: "create:web:existing-group",
    project,
    groupId: "group_active",
    title: "station/quick-existing-group",
    hiddenBranch: "station/quick-existing-group",
    harness: project.defaults.harness,
    fallbackCell: "quickSession",
  };
  const store = createStore<DashboardState>(() =>
    createInitialTuiState({
      initialSnapshot: initial,
      dashboardFocus: {
        rowId: dashboardRowIds.group("group_active"),
        cellId: "quickSession",
      },
    }),
  );
  const service = new FakeTuiObserverService(initial);
  const capabilities = createFakeDashboardCapabilities();
  const scope = createDashboardRuntimeEffectScope();
  const capabilityRunner = createDashboardCapabilityOperationRunner({
    getStore: () => store,
    capabilities,
    clientLabel: "test",
    scope,
  });
  capabilities.quickCreateHandle = () => {
    service.setSnapshot(withLaunchedSession(initial, operation.hiddenBranch));
    return dashboardExecution({ kind: "success" }, { optimistic: "pending-create" });
  };
  service.waitForCommandCompletion = async (commandId) => {
    const current = store.getState().snapshot;
    if (current !== undefined) {
      store.setState(
        replaceSnapshot(store.getState(), {
          ...current,
          sessionGroups: current.sessionGroups.map((group) =>
            group.id === operation.groupId
              ? {
                  ...group,
                  version: group.version + 1,
                  sessionIds: [...group.sessionIds, "ses_wt_web_quick_group"],
                }
              : group,
          ),
        }),
      );
    }
    return { status: "succeeded", commandId };
  };
  return {
    store,
    service,
    capabilities,
    scope,
    operation,
    run: () =>
      runQuickSessionInGroupOperation({
        store,
        service,
        capabilities: capabilityRunner,
        operation,
        clientLabel: "test",
        scope,
      }),
  };
}

function operation(snapshot: StationSnapshot, quickSession: boolean): CreateSessionGroupOperation {
  return {
    type: "createSessionGroup",
    projectId: "web",
    name: "Launches",
    quickSession,
    previousGroupIds: snapshot.sessionGroups.map((group) => group.id),
    command: buildCreateSessionGroupCommand({ projectId: "web", name: "Launches" }),
  };
}

function withCreatedGroup(snapshot: StationSnapshot): StationSnapshot {
  return {
    ...snapshot,
    sessionGroups: [
      ...snapshot.sessionGroups,
      {
        id: "group_new",
        projectId: "web",
        name: "Launches",
        sessionIds: [],
        version: 1,
        createdAt: fixtureNow,
        updatedAt: fixtureNow,
      },
    ],
  };
}

function withLaunchedSession(snapshot: StationSnapshot, branch: string): StationSnapshot {
  const launchedRow = row({
    id: "wt_web_quick_group",
    projectId: "web",
    branch,
    state: "idle",
  });
  const templateSession = snapshot.sessions.find((session) => session.id === "ses_wt_web_idle");
  if (templateSession === undefined) throw new Error("session fixture missing");
  return {
    ...snapshot,
    rows: [...snapshot.rows, launchedRow],
    sessions: [
      ...snapshot.sessions,
      {
        ...templateSession,
        id: "ses_wt_web_quick_group",
        worktreeId: launchedRow.id,
        title: branch,
        createdAt: fixtureNow,
        updatedAt: fixtureNow,
      },
    ],
  };
}
