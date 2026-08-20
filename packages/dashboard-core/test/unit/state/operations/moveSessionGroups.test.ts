import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { buildCreateSessionGroupCommand } from "../../../../src/state/commandBuilders.js";
import {
  resolveMoveSessionToGroupOperation,
  runCreateSessionGroupForMoveOperation,
  runMoveSessionToGroupOperation,
} from "../../../../src/state/operations/sessionGroups.js";
import type { CreateSessionGroupForMoveOperation } from "../../../../src/state/operations/types.js";
import { createDashboardRuntimeEffectScope } from "../../../../src/state/runtimeEffectScope.js";
import { createInitialTuiState, replaceSnapshot } from "../../../../src/state/screen.js";
import { openMoveToGroupForRow } from "../../../../src/state/screens/moveToGroup.js";
import type { DashboardState } from "../../../../src/state/types.js";
import { createGroupedDashboardSnapshot, fixtureNow } from "../../../fixtures/snapshots.js";
import { FakeTuiObserverService } from "../../../support/fakeObserverService.js";

describe("Move Session to Group operation", () => {
  it("moves Group to Group once and follows canonical focus", async () => {
    const setup = moveSetup("ses_wt_web_attention", "group_empty");
    setup.service.waitForCommandCompletion = async (commandId) => {
      setup.store.setState(
        replaceSnapshot(
          setup.store.getState(),
          moveMembership(setup.initial, setup.sessionId, "group_empty"),
        ),
      );
      return { status: "succeeded", commandId };
    };

    await setup.run();

    expect(setup.service.dispatched).toEqual([setup.operation.command]);
    expect(setup.store.getState()).toMatchObject({
      screen: { name: "dashboard" },
      dashboardFocus: { rowId: `session:${setup.sessionId}`, cellId: "identity" },
    });
    expect(currentGroupId(setup.store.getState(), setup.sessionId)).toBe("group_empty");
    await setup.scope.dispose();
  });

  it("moves an ungrouped session with a null expectation", () => {
    const initial = createGroupedDashboardSnapshot();
    const state = openMoveToGroupForRow(
      createInitialTuiState({ initialSnapshot: initial }),
      "ses_wt_web_stuck",
    );
    const resolution = resolveMoveSessionToGroupOperation(state, "ses_wt_web_stuck", "group_empty");
    expect(resolution).toMatchObject({
      kind: "submit",
      operation: {
        command: {
          payload: {
            add: [{ sessionId: "ses_wt_web_stuck", expectedGroupId: null }],
          },
        },
      },
    });
  });

  it("retains the picker for an ordinary failure", async () => {
    const setup = moveSetup("ses_wt_web_attention", "group_empty");
    setup.service.nextReceipt = {
      commandId: "cmd_rejected",
      accepted: false,
      status: "rejected",
      error: {
        tag: "CommandValidationError",
        code: "MOVE_REJECTED",
        message: "Move was rejected.",
      },
    };

    await setup.run();

    expect(setup.store.getState().screen).toMatchObject({
      name: "moveToGroup",
      step: "chooseDestination",
      submitting: false,
    });
    expect(setup.store.getState().toasts.at(-1)?.toast).toMatchObject({
      message: "Move was rejected.",
    });
    await setup.scope.dispose();
  });

  it("closes on assignment conflict and focuses the session at canonical truth", async () => {
    const setup = moveSetup("ses_wt_web_attention", "group_empty");
    setup.service.waitForCommandCompletion = async (commandId) => {
      const canonical = moveMembership(setup.initial, setup.sessionId, "group_build");
      setup.service.setSnapshot(canonical);
      setup.store.setState(replaceSnapshot(setup.store.getState(), canonical));
      return {
        status: "failed",
        commandId,
        error: {
          tag: "CommandConflictError",
          code: "SESSION_GROUP_ASSIGNMENT_CONFLICT",
          message: "The session moved elsewhere.",
        },
      };
    };

    await setup.run();

    expect(setup.store.getState()).toMatchObject({
      screen: { name: "dashboard" },
      dashboardFocus: { rowId: `session:${setup.sessionId}`, cellId: "identity" },
      toasts: [
        expect.objectContaining({
          toast: expect.objectContaining({
            message: 'The session\'s Group changed; it is now in "Build".',
          }),
        }),
      ],
    });
    expect(setup.store.getState().collapsedGroupIds.has("group_build")).toBe(false);
    await setup.scope.dispose();
  });
});

describe("Create Group for move operation", () => {
  it("preserves the valid empty Group and picker when the subsequent move fails", async () => {
    const initial = createGroupedDashboardSnapshot();
    const screenState = openMoveToGroupForRow(
      createInitialTuiState({ initialSnapshot: initial }),
      "ses_wt_web_attention",
    );
    const store = createStore<DashboardState>(() => ({
      ...screenState,
      screen: {
        name: "moveToGroup",
        step: "createGroup",
        sessionId: "ses_wt_web_attention",
        sessionTitle: "checkout-copy",
        draftName: { value: "Fresh", cursor: 5 },
        submitting: true,
      },
    }));
    const service = new FakeTuiObserverService(initial);
    const scope = createDashboardRuntimeEffectScope();
    const operation: CreateSessionGroupForMoveOperation = {
      type: "createSessionGroupForMove",
      sessionId: "ses_wt_web_attention",
      projectId: "web",
      name: "Fresh",
      previousGroupIds: initial.sessionGroups.map((group) => group.id),
      command: buildCreateSessionGroupCommand({ projectId: "web", name: "Fresh" }),
    };
    service.waitForCommandCompletion = async (commandId) => {
      if (service.dispatched.at(-1)?.type === "sessionGroup.create") {
        store.setState(
          replaceSnapshot(store.getState(), {
            ...initial,
            sessionGroups: [
              ...initial.sessionGroups,
              {
                id: "group_fresh",
                projectId: "web",
                name: "Fresh",
                sessionIds: [],
                version: 1,
                createdAt: fixtureNow,
                updatedAt: fixtureNow,
              },
            ],
          }),
        );
        return { status: "succeeded", commandId };
      }
      return {
        status: "failed",
        commandId,
        error: { tag: "CommandExecutionError", code: "MOVE_FAILED", message: "Move failed." },
      };
    };

    await runCreateSessionGroupForMoveOperation({
      store,
      service,
      operation,
      clientLabel: "test",
      scope,
    });

    expect(service.dispatched.map((command) => command.type)).toEqual([
      "sessionGroup.create",
      "sessionGroup.updateMembership",
    ]);
    expect(store.getState().snapshot?.sessionGroups).toContainEqual(
      expect.objectContaining({ id: "group_fresh", sessionIds: [] }),
    );
    expect(currentGroupId(store.getState(), operation.sessionId)).toBe("group_active");
    expect(store.getState().screen).toMatchObject({
      name: "moveToGroup",
      step: "chooseDestination",
      submitting: false,
    });
    await scope.dispose();
  });
});

function moveSetup(sessionId: string, destinationGroupId: string) {
  const initial = createGroupedDashboardSnapshot();
  const open = openMoveToGroupForRow(
    createInitialTuiState({ initialSnapshot: initial }),
    sessionId,
  );
  const resolution = resolveMoveSessionToGroupOperation(open, sessionId, destinationGroupId);
  if (resolution.kind !== "submit") throw new Error("move fixture did not resolve");
  const state = {
    ...open,
    screen: { ...open.screen, submitting: true },
  } as DashboardState;
  const store = createStore<DashboardState>(() => state);
  const service = new FakeTuiObserverService(initial);
  const scope = createDashboardRuntimeEffectScope();
  return {
    initial,
    sessionId,
    store,
    service,
    scope,
    operation: resolution.operation,
    run: () =>
      runMoveSessionToGroupOperation({
        store,
        service,
        operation: resolution.operation,
        clientLabel: "test",
        scope,
      }),
  };
}

function moveMembership(
  snapshot: ReturnType<typeof createGroupedDashboardSnapshot>,
  sessionId: string,
  destinationGroupId: string | null,
) {
  return {
    ...snapshot,
    sessionGroups: snapshot.sessionGroups.map((group) => ({
      ...group,
      version:
        group.id === destinationGroupId || group.sessionIds.includes(sessionId)
          ? group.version + 1
          : group.version,
      sessionIds:
        group.id === destinationGroupId
          ? [...group.sessionIds.filter((id) => id !== sessionId), sessionId]
          : group.sessionIds.filter((id) => id !== sessionId),
    })),
  };
}

function currentGroupId(state: DashboardState, sessionId: string): string | undefined {
  return state.snapshot?.sessionGroups.find((group) => group.sessionIds.includes(sessionId))?.id;
}
