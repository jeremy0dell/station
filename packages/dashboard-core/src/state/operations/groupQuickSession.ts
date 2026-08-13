import type { SafeError, SessionId, StationSnapshot } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { safeErrorToToast, toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import { buildUpdateSessionGroupMembershipCommand } from "../commandBuilders.js";
import { focusDashboardGroup, focusDashboardSession } from "../dashboardFocus.js";
import { removeCreateSessionLocalRow } from "../localRows.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import { replaceSnapshot } from "../screen.js";
import { addTuiToast } from "../toasts.js";
import type { DashboardState } from "../types.js";
import type { DashboardCapabilityOperationRunner } from "./capabilityOperation.js";
import { executeDashboardCommandError } from "./commandExecutionError.js";
import type { CreateQuickSessionInGroupOperation } from "./types.js";

/**
 * Launches one ordinary Quick Session, then records one latest-version Group membership update;
 * post-launch failures preserve the created session and never retry the launch.
 */
export async function runQuickSessionInGroupOperation(input: {
  store: StoreApi<DashboardState>;
  service: ObserverService;
  capabilities: DashboardCapabilityOperationRunner;
  operation: CreateQuickSessionInGroupOperation;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const { store, service, capabilities, operation, clientLabel, scope } = input;
  const currentGroup = store
    .getState()
    .snapshot?.sessionGroups.find(
      (group) => group.id === operation.groupId && group.projectId === operation.project.id,
    );
  if (currentGroup === undefined) {
    scope.commit(() => {
      focusGroup(store, operation);
      addErrorToast(store, convergenceError("The Group is no longer available."));
    });
    return;
  }

  const capabilityResult = await capabilities.run({
    type: "quickCreateManagedSession",
    localId: operation.localId,
    project: operation.project,
    title: operation.title,
    hiddenBranch: operation.hiddenBranch,
    harness: operation.harness,
    targetGroupId: operation.groupId,
  });
  if (!scope.isOpen()) return;
  if (capabilityResult.kind !== "success") {
    scope.commit(() => focusGroup(store, operation));
    return;
  }

  let launchedSnapshot: StationSnapshot;
  try {
    launchedSnapshot = await service.loadSnapshot();
  } catch (error: unknown) {
    scope.commit(() => {
      removeTargetedRow(store, operation.localId);
      focusGroup(store, operation);
      addErrorToast(store, toSafeError(error, { clientLabel }));
    });
    return;
  }
  if (!scope.isOpen()) return;
  scope.commit(() => store.setState(replaceSnapshot(store.getState(), launchedSnapshot)));
  const sessionResolution = resolveLaunchedSession(
    launchedSnapshot,
    operation.project.id,
    operation.hiddenBranch,
  );
  if (sessionResolution.kind === "failure") {
    scope.commit(() => {
      removeTargetedRow(store, operation.localId);
      focusGroup(store, operation);
      addErrorToast(store, sessionResolution.error);
    });
    return;
  }
  const latestGroup = launchedSnapshot.sessionGroups.find(
    (group) => group.id === operation.groupId,
  );
  if (latestGroup === undefined || latestGroup.projectId !== operation.project.id) {
    scope.commit(() => {
      removeTargetedRow(store, operation.localId);
      focusCanonicalSessionOrGroup(store, sessionResolution.sessionId, operation);
      addErrorToast(store, convergenceError("The Group disappeared before placement."));
    });
    return;
  }

  const membershipCommand = buildUpdateSessionGroupMembershipCommand({
    projectId: operation.project.id,
    groupId: operation.groupId,
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
      removeTargetedRow(store, operation.localId);
      focusCanonicalSessionOrGroup(store, sessionResolution.sessionId, operation);
      addErrorToast(store, membershipFailure);
    });
    return;
  }
  if (!scope.isOpen()) return;

  const convergedGroup = store
    .getState()
    .snapshot?.sessionGroups.find((group) => group.id === operation.groupId);
  scope.commit(() => {
    removeTargetedRow(store, operation.localId);
    focusCanonicalSessionOrGroup(store, sessionResolution.sessionId, operation);
    if (convergedGroup?.sessionIds.includes(sessionResolution.sessionId) !== true) {
      addErrorToast(store, convergenceError("The new session did not converge into its Group."));
    }
  });
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

function focusCanonicalSessionOrGroup(
  store: StoreApi<DashboardState>,
  sessionId: SessionId,
  operation: CreateQuickSessionInGroupOperation,
): void {
  const state = store.getState();
  const session = state.snapshot?.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) {
    focusGroup(store, operation);
    return;
  }
  const group = state.snapshot?.sessionGroups.find((candidate) =>
    candidate.sessionIds.includes(sessionId),
  );
  const collapsedProjectIds = new Set(state.collapsedProjectIds);
  const collapsedGroupIds = new Set(state.collapsedGroupIds);
  collapsedProjectIds.delete(session.projectId);
  if (group !== undefined) collapsedGroupIds.delete(group.id);
  store.setState(
    focusDashboardSession(
      {
        ...state,
        screen: { name: "dashboard" },
        collapsedProjectIds,
        collapsedGroupIds,
      },
      sessionId,
    ),
  );
}

function focusGroup(
  store: StoreApi<DashboardState>,
  operation: CreateQuickSessionInGroupOperation,
): void {
  store.setState(focusDashboardGroup(store.getState(), operation.groupId, operation.fallbackCell));
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
