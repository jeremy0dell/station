import type { SafeError, SessionGroupId, SessionId } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { dashboardRowIds, selectDashboardTree } from "../../selectors/dashboardTree.js";
import { selectMoveToGroupSessionContext } from "../../selectors/selectors.js";
import { safeErrorToToast, toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import { buildMoveSessionToGroupCommand } from "../commandBuilders.js";
import {
  focusDashboardGroup,
  focusDashboardSession,
  focusResolvedDashboardCursor,
  reconcileDashboardFocus,
} from "../dashboardFocus.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import { resolveQuickSessionInGroupOperation } from "../screens/quickSession.js";
import { addTuiToast } from "../toasts.js";
import type { DashboardState } from "../types.js";
import type { DashboardCapabilityOperationRunner } from "./capabilityOperation.js";
import { executeDashboardCommandError } from "./commandExecutionError.js";
import { runQuickSessionInGroupOperation } from "./groupQuickSession.js";
import type {
  CreateSessionGroupForMoveOperation,
  CreateSessionGroupOperation,
  MoveSessionToGroupOperation,
} from "./types.js";

export type MoveSessionToGroupResolution =
  | { kind: "submit"; operation: MoveSessionToGroupOperation }
  | { kind: "noop" }
  | { kind: "failure"; error: SafeError };

/** Resolves one canonical reassignment operation for every current and future Group surface. */
export function resolveMoveSessionToGroupOperation(
  state: DashboardState,
  sessionId: SessionId,
  destinationGroupId: SessionGroupId | null,
): MoveSessionToGroupResolution {
  const snapshot = state.snapshot;
  const context =
    snapshot === undefined ? undefined : selectMoveToGroupSessionContext(snapshot, sessionId);
  if (snapshot === undefined || context === undefined) {
    return { kind: "failure", error: staleMoveError("The session is no longer available.") };
  }
  const destination =
    destinationGroupId === null
      ? undefined
      : snapshot.sessionGroups.find(
          (group) =>
            group.id === destinationGroupId &&
            group.projectId === context.project.id &&
            group.parentGroupId === undefined,
        );
  if (destinationGroupId !== null && destination === undefined) {
    return {
      kind: "failure",
      error: staleMoveError("The destination Group is no longer available."),
    };
  }
  const command = buildMoveSessionToGroupCommand({
    projectId: context.project.id,
    sessionId,
    currentGroup: context.currentGroup,
    destinationGroup: destination,
  });
  if (command === undefined) return { kind: "noop" };
  return {
    kind: "submit",
    operation: {
      type: "moveSessionToGroup",
      sessionId,
      projectId: context.project.id,
      expectedCurrentGroupId: context.currentGroup?.id ?? null,
      destinationGroupId,
      command,
    },
  };
}

export async function runMoveSessionToGroupOperation(input: {
  store: StoreApi<DashboardState>;
  service: ObserverService;
  operation: MoveSessionToGroupOperation;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const stale = validatePreparedMove(input.store.getState(), input.operation);
  if (stale !== undefined) {
    input.scope.commit(() => closeMoveOnConflict(input.store, input.operation.sessionId, stale));
    return;
  }
  let failure: SafeError | undefined;
  try {
    failure = await executeDashboardCommandError({
      service: input.service,
      command: input.operation.command,
      clientLabel: input.clientLabel,
    });
  } catch (error: unknown) {
    failure = toSafeError(error, { clientLabel: input.clientLabel });
  }
  if (!input.scope.isOpen()) return;
  if (failure === undefined) {
    input.scope.commit(() => {
      const state = input.store.getState();
      input.store.setState(focusDashboardSession(state, input.operation.sessionId));
    });
    return;
  }
  input.scope.commit(() => {
    if (isMembershipConflict(failure)) {
      closeMoveOnConflict(input.store, input.operation.sessionId, failure);
    } else {
      retainMoveFailure(input.store, input.operation, failure);
    }
  });
}

export async function runCreateSessionGroupForMoveOperation(input: {
  store: StoreApi<DashboardState>;
  service: ObserverService;
  operation: CreateSessionGroupForMoveOperation;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  let createFailure: SafeError | undefined;
  try {
    createFailure = await executeDashboardCommandError({
      service: input.service,
      command: input.operation.command,
      clientLabel: input.clientLabel,
    });
  } catch (error: unknown) {
    createFailure = toSafeError(error, { clientLabel: input.clientLabel });
  }
  if (!input.scope.isOpen()) return;
  if (createFailure !== undefined) {
    input.scope.commit(() => retainMoveCreateFailure(input.store, input.operation, createFailure));
    return;
  }
  const created = resolveCreatedGroup(input.store.getState(), input.operation);
  if (created.kind === "failure") {
    input.scope.commit(() =>
      closeMoveOnConflict(input.store, input.operation.sessionId, created.error),
    );
    return;
  }
  const resolution = resolveMoveSessionToGroupOperation(
    input.store.getState(),
    input.operation.sessionId,
    created.group.id,
  );
  if (resolution.kind !== "submit") {
    const error =
      resolution.kind === "failure"
        ? resolution.error
        : convergenceError("The created Group could not receive the session.");
    input.scope.commit(() => closeMoveOnConflict(input.store, input.operation.sessionId, error));
    return;
  }
  input.scope.commit(() => {
    const state = input.store.getState();
    if (
      state.screen.name === "moveToGroup" &&
      state.screen.step === "createGroup" &&
      state.screen.sessionId === input.operation.sessionId
    ) {
      input.store.setState({
        ...state,
        screen: {
          name: "moveToGroup",
          step: "chooseDestination",
          sessionId: state.screen.sessionId,
          sessionTitle: state.screen.sessionTitle,
          submitting: true,
        },
      });
    }
  });
  await runMoveSessionToGroupOperation({
    store: input.store,
    service: input.service,
    operation: resolution.operation,
    clientLabel: input.clientLabel,
    scope: input.scope,
  });
}

/**
 * Runs durable Group creation before ordinary Quick Session execution, expected membership, and
 * final dashboard focus; valid Groups and sessions are never rolled back after partial failure.
 */
export async function runCreateSessionGroupOperation(input: {
  store: StoreApi<DashboardState>;
  service: ObserverService;
  capabilities: DashboardCapabilityOperationRunner;
  operation: CreateSessionGroupOperation;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const { store, service, capabilities, operation, clientLabel, scope } = input;
  let createFailure: SafeError | undefined;
  try {
    createFailure = await executeDashboardCommandError({
      service,
      command: operation.command,
      clientLabel,
    });
  } catch (error: unknown) {
    createFailure = toSafeError(error, { clientLabel });
  }
  if (createFailure !== undefined) {
    scope.commit(() => retainCreateGroupFailure(store, operation, createFailure));
    return;
  }
  if (!scope.isOpen()) return;

  const created = resolveCreatedGroup(store.getState(), operation);
  if (created.kind === "failure") {
    scope.commit(() => closeOnConvergenceFailure(store, operation.projectId, created.error));
    return;
  }
  const groupId = created.group.id;
  scope.commit(() => store.setState(focusDashboardGroup(store.getState(), groupId)));
  if (!operation.quickSession) return;

  const quickResolution = resolveQuickSessionInGroupOperation(
    store.getState(),
    groupId,
    "identity",
  );
  if (quickResolution.kind !== "submit") {
    if (quickResolution.kind === "blocked") {
      scope.commit(() => addErrorToast(store, quickResolution.error));
    } else {
      scope.commit(() =>
        addErrorToast(
          store,
          convergenceError("The created Group's Project is no longer available."),
        ),
      );
    }
    return;
  }
  await runQuickSessionInGroupOperation({
    store,
    service,
    capabilities,
    operation: quickResolution.operation,
    clientLabel,
    scope,
  });
}

function resolveCreatedGroup(
  state: DashboardState,
  operation: CreateSessionGroupOperation | CreateSessionGroupForMoveOperation,
):
  | { kind: "success"; group: NonNullable<DashboardState["snapshot"]>["sessionGroups"][number] }
  | { kind: "failure"; error: SafeError } {
  const previous = new Set(operation.previousGroupIds);
  const candidates =
    state.snapshot?.sessionGroups.filter(
      (group) =>
        !previous.has(group.id) &&
        group.projectId === operation.projectId &&
        group.name === operation.name,
    ) ?? [];
  const candidate = candidates[0];
  return candidates.length === 1 && candidate !== undefined
    ? { kind: "success", group: candidate }
    : {
        kind: "failure",
        error: convergenceError("The created Group could not be identified uniquely."),
      };
}

function validatePreparedMove(
  state: DashboardState,
  operation: MoveSessionToGroupOperation,
): SafeError | undefined {
  const snapshot = state.snapshot;
  const context =
    snapshot === undefined
      ? undefined
      : selectMoveToGroupSessionContext(snapshot, operation.sessionId);
  if (context === undefined || context.project.id !== operation.projectId) {
    return staleMoveError("The session is no longer available.");
  }
  if ((context.currentGroup?.id ?? null) !== operation.expectedCurrentGroupId) {
    return assignmentConflictError();
  }
  const target = snapshot?.sessionGroups.find(
    (group) => group.id === operation.command.payload.groupId,
  );
  if (
    target === undefined ||
    target.projectId !== operation.projectId ||
    target.version !== operation.command.payload.expectedVersion
  ) {
    return versionConflictError();
  }
  if (operation.destinationGroupId !== null) {
    const destination = snapshot?.sessionGroups.find(
      (group) => group.id === operation.destinationGroupId,
    );
    if (destination?.parentGroupId !== undefined) {
      return staleMoveError("The destination Group is no longer at the Project root.");
    }
  }
  return undefined;
}

function retainMoveFailure(
  store: StoreApi<DashboardState>,
  operation: MoveSessionToGroupOperation,
  error: SafeError,
): void {
  const state = store.getState();
  const screen = state.screen;
  const next =
    screen.name === "moveToGroup" &&
    screen.step === "chooseDestination" &&
    screen.sessionId === operation.sessionId
      ? { ...state, screen: { ...screen, submitting: false } }
      : state;
  store.setState(addTuiToast(next, safeErrorToToast(error)));
}

function retainMoveCreateFailure(
  store: StoreApi<DashboardState>,
  operation: CreateSessionGroupForMoveOperation,
  error: SafeError,
): void {
  const state = store.getState();
  const screen = state.screen;
  const next =
    screen.name === "moveToGroup" &&
    screen.step === "createGroup" &&
    screen.sessionId === operation.sessionId
      ? { ...state, screen: { ...screen, submitting: false } }
      : state;
  store.setState(addTuiToast(next, safeErrorToToast(error)));
}

function closeMoveOnConflict(
  store: StoreApi<DashboardState>,
  sessionId: SessionId,
  error: SafeError,
): void {
  const focused = focusDashboardSession(
    { ...store.getState(), screen: { name: "dashboard" } },
    sessionId,
  );
  store.setState(addTuiToast(focused, safeErrorToToast(error)));
}

function isMembershipConflict(error: SafeError): boolean {
  return (
    error.code === "SESSION_GROUP_VERSION_CONFLICT" ||
    error.code === "SESSION_GROUP_ASSIGNMENT_CONFLICT"
  );
}

function staleMoveError(message: string): SafeError {
  return {
    tag: "CommandConflictError",
    code: "SESSION_GROUP_ASSIGNMENT_CONFLICT",
    message,
    hint: "Review the session's current Group before trying again.",
  };
}

function assignmentConflictError(): SafeError {
  return staleMoveError("The session's Group changed before the move could start.");
}

function versionConflictError(): SafeError {
  return {
    tag: "CommandConflictError",
    code: "SESSION_GROUP_VERSION_CONFLICT",
    message: "The destination Group changed before the move could start.",
    hint: "Review the current Group state before trying again.",
  };
}

function retainCreateGroupFailure(
  store: StoreApi<DashboardState>,
  operation: CreateSessionGroupOperation,
  error: SafeError,
): void {
  const state = store.getState();
  const screen = state.screen;
  const next =
    screen.name === "createGroup" && screen.projectId === operation.projectId
      ? { ...state, screen: { ...screen, submitting: false } }
      : state;
  store.setState(addTuiToast(next, safeErrorToToast(error)));
}

function closeOnConvergenceFailure(
  store: StoreApi<DashboardState>,
  projectId: string,
  error: SafeError,
): void {
  const state = store.getState();
  const dashboard = { ...state, screen: { name: "dashboard" as const } };
  if (dashboard.snapshot?.projects.some((project) => project.id === projectId) === true) {
    const tree = selectDashboardTree(dashboard.snapshot, dashboard, dashboard.screen);
    store.setState(
      addTuiToast(
        focusResolvedDashboardCursor(dashboard, tree, {
          rowId: dashboardRowIds.project(projectId),
          cellId: "menu",
        }),
        safeErrorToToast(error),
      ),
    );
    return;
  }
  store.setState(addTuiToast(reconcileDashboardFocus(state, dashboard), safeErrorToToast(error)));
}

function addErrorToast(store: StoreApi<DashboardState>, error: SafeError): void {
  store.setState(addTuiToast(store.getState(), safeErrorToToast(error)));
}

function convergenceError(message: string): SafeError {
  return {
    tag: "ClientObserverError",
    code: "SESSION_GROUP_CONVERGENCE_FAILED",
    message,
    hint: "Refresh the dashboard before trying again.",
  };
}
