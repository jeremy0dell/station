import type { SafeError } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { dashboardRowIds, selectDashboardTree } from "../../selectors/dashboardTree.js";
import { safeErrorToToast, toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import {
  focusDashboardGroup,
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
