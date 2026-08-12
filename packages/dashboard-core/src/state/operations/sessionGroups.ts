import type { SafeError, SessionGroupId, SessionId, StationSnapshot } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { dashboardRowIds, selectDashboardTree } from "../../selectors/dashboardTree.js";
import { safeErrorToToast, toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import { buildUpdateSessionGroupMembershipCommand } from "../commandBuilders.js";
import {
  focusDashboardSession,
  focusResolvedDashboardCursor,
  reconcileDashboardFocus,
} from "../dashboardFocus.js";
import { removeCreateSessionLocalRow } from "../localRows.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import { replaceSnapshot } from "../screen.js";
import { resolveQuickSessionIntent } from "../screens/quickSession.js";
import { addTuiToast } from "../toasts.js";
import type { DashboardState } from "../types.js";
import type { DashboardCapabilityOperationRunner } from "./capabilityOperation.js";
import { executeDashboardCommandError } from "./commandExecutionError.js";
import type { CreateSessionGroupOperation } from "./types.js";

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
  scope.commit(() => focusGroup(store, groupId));
  if (!operation.quickSession) return;

  const quickResolution = resolveQuickSessionIntent(store.getState(), operation.projectId);
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
  const project = store
    .getState()
    .snapshot?.projects.find((candidate) => candidate.id === operation.projectId);
  if (project === undefined) {
    scope.commit(() =>
      addErrorToast(store, convergenceError("The created Group's Project is no longer available.")),
    );
    return;
  }
  const localId = `create:${operation.projectId}:${quickResolution.token}`;
  const capabilityResult = await capabilities.run({
    type: "quickCreateManagedSession",
    localId,
    project,
    title: quickResolution.title,
    hiddenBranch: quickResolution.branch,
    harness: quickResolution.harnessProvider,
    targetGroupId: groupId,
  });
  if (!scope.isOpen()) return;
  if (capabilityResult.kind !== "success") {
    scope.commit(() => focusGroup(store, groupId));
    return;
  }

  let launchedSnapshot: StationSnapshot;
  try {
    launchedSnapshot = await service.loadSnapshot();
  } catch (error: unknown) {
    scope.commit(() => {
      removeTargetedRow(store, localId);
      focusGroup(store, groupId);
      addErrorToast(store, toSafeError(error, { clientLabel }));
    });
    return;
  }
  if (!scope.isOpen()) return;
  scope.commit(() => store.setState(replaceSnapshot(store.getState(), launchedSnapshot)));
  const sessionResolution = resolveLaunchedSession(
    launchedSnapshot,
    operation.projectId,
    quickResolution.branch,
  );
  if (sessionResolution.kind === "failure") {
    scope.commit(() => {
      removeTargetedRow(store, localId);
      focusGroup(store, groupId);
      addErrorToast(store, sessionResolution.error);
    });
    return;
  }
  const latestGroup = launchedSnapshot.sessionGroups.find((group) => group.id === groupId);
  if (latestGroup === undefined || latestGroup.projectId !== operation.projectId) {
    scope.commit(() => {
      removeTargetedRow(store, localId);
      focusCanonicalSessionOrGroup(store, sessionResolution.sessionId, groupId);
      addErrorToast(store, convergenceError("The created Group disappeared before placement."));
    });
    return;
  }

  const membershipCommand = buildUpdateSessionGroupMembershipCommand({
    projectId: operation.projectId,
    groupId,
    expectedVersion: latestGroup.version,
    sessionId: sessionResolution.sessionId,
  });
  let membershipFailure: SafeError | undefined;
  try {
    membershipFailure = await executeDashboardCommandError({
      service,
      command: membershipCommand,
      clientLabel,
    });
  } catch (error: unknown) {
    membershipFailure = toSafeError(error, { clientLabel });
  }
  if (membershipFailure !== undefined) {
    scope.commit(() => {
      removeTargetedRow(store, localId);
      focusCanonicalSessionOrGroup(store, sessionResolution.sessionId, groupId);
      addErrorToast(store, membershipFailure);
    });
    return;
  }
  if (!scope.isOpen()) return;

  const convergedGroup = store
    .getState()
    .snapshot?.sessionGroups.find((group) => group.id === groupId);
  scope.commit(() => {
    removeTargetedRow(store, localId);
    focusCanonicalSessionOrGroup(store, sessionResolution.sessionId, groupId);
    if (convergedGroup?.sessionIds.includes(sessionResolution.sessionId) !== true) {
      addErrorToast(store, convergenceError("The new session did not converge into its Group."));
    }
  });
}

function resolveCreatedGroup(
  state: DashboardState,
  operation: CreateSessionGroupOperation,
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

function resolveLaunchedSession(
  snapshot: StationSnapshot,
  projectId: string,
  branch: string,
): { kind: "success"; sessionId: SessionId } | { kind: "failure"; error: SafeError } {
  const rowsById = new Map(snapshot.rows.map((row) => [row.id, row]));
  const candidates = snapshot.sessions.filter((session) => {
    const row = rowsById.get(session.worktreeId);
    return session.projectId === projectId && row?.branch === branch;
  });
  const candidate = candidates[0];
  return candidates.length === 1 && candidate !== undefined
    ? { kind: "success", sessionId: candidate.id }
    : {
        kind: "failure",
        error: convergenceError("The new session could not be identified uniquely."),
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

function focusGroup(store: StoreApi<DashboardState>, groupId: SessionGroupId): void {
  const previous = store.getState();
  const group = previous.snapshot?.sessionGroups.find((candidate) => candidate.id === groupId);
  const collapsedProjectIds = new Set(previous.collapsedProjectIds);
  const collapsedGroupIds = new Set(previous.collapsedGroupIds);
  if (group !== undefined) collapsedProjectIds.delete(group.projectId);
  collapsedGroupIds.delete(groupId);
  const dashboard = {
    ...previous,
    screen: { name: "dashboard" as const },
    collapsedProjectIds,
    collapsedGroupIds,
  };
  if (dashboard.snapshot === undefined) {
    store.setState(dashboard);
    return;
  }
  const tree = selectDashboardTree(dashboard.snapshot, dashboard, dashboard.screen);
  store.setState(
    focusResolvedDashboardCursor(dashboard, tree, {
      rowId: dashboardRowIds.group(groupId),
      cellId: "identity",
    }),
  );
}

function focusCanonicalSessionOrGroup(
  store: StoreApi<DashboardState>,
  sessionId: SessionId,
  groupId: SessionGroupId,
): void {
  const previous = store.getState();
  const hasSession =
    previous.snapshot?.sessions.some((session) => session.id === sessionId) === true;
  if (hasSession) {
    const session = previous.snapshot?.sessions.find((candidate) => candidate.id === sessionId);
    const group = previous.snapshot?.sessionGroups.find((candidate) =>
      candidate.sessionIds.includes(sessionId),
    );
    const collapsedProjectIds = new Set(previous.collapsedProjectIds);
    const collapsedGroupIds = new Set(previous.collapsedGroupIds);
    if (session !== undefined) collapsedProjectIds.delete(session.projectId);
    if (group !== undefined) collapsedGroupIds.delete(group.id);
    store.setState(
      focusDashboardSession(
        {
          ...previous,
          screen: { name: "dashboard" },
          collapsedProjectIds,
          collapsedGroupIds,
        },
        sessionId,
      ),
    );
  } else {
    focusGroup(store, groupId);
  }
}

function removeTargetedRow(store: StoreApi<DashboardState>, localId: string): void {
  store.setState(removeCreateSessionLocalRow(store.getState(), localId));
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
