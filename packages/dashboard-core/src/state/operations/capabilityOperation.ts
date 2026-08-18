import type { SafeError } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { safeErrorToToast, toSafeError } from "../../services/errors/errors.js";
import type {
  DashboardCapabilities,
  DashboardExecutionHandle,
  DashboardExecutionResult,
} from "../capabilities/execution.js";
import {
  addPendingCreateSessionRow,
  addPendingStartAgentRow,
  failPendingCreateSessionRow,
  removeCreateSessionLocalRow,
  removePendingRemoveWorktreeRow,
  removePendingStartAgentRow,
} from "../localRows.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import { completeNewSessionSubmission, failNewSessionSubmission } from "../screens/newSession.js";
import { FAILED_CREATE_ROW_TTL_MS } from "../timing.js";
import { addTuiToast } from "../toasts.js";
import type { DashboardState } from "../types.js";
import {
  createFailedCreateExpiryScheduler,
  type FailedCreateExpiryScheduler,
} from "./failedCreateExpiry.js";
import type { DashboardCapabilityOperation } from "./types.js";

/**
 * Scope-bound executor returning the settled capability result after applying optimistic and
 * feedback policy, so composite operations can continue from the same execution.
 */
export type DashboardCapabilityOperationRunner = {
  run(operation: DashboardCapabilityOperation): Promise<DashboardExecutionResult>;
};

export function createDashboardCapabilityOperationRunner(input: {
  getStore: () => StoreApi<DashboardState>;
  capabilities: DashboardCapabilities;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): DashboardCapabilityOperationRunner {
  const expiry = createFailedCreateExpiryScheduler({
    getStore: input.getStore,
    scope: input.scope,
  });
  return {
    run: (operation) =>
      runDashboardCapabilityOperation({
        store: input.getStore(),
        capabilities: input.capabilities,
        operation,
        clientLabel: input.clientLabel,
        scope: input.scope,
        expiry,
      }),
  };
}

function markCreateSessionRowFailed(
  store: StoreApi<DashboardState>,
  localId: string,
  error: SafeError,
  expiry: FailedCreateExpiryScheduler,
): void {
  store.setState(
    failPendingCreateSessionRow(
      store.getState(),
      localId,
      error,
      Date.now() + FAILED_CREATE_ROW_TTL_MS,
    ),
  );
  expiry.schedule();
}

function markStartAgentRowFailed(store: StoreApi<DashboardState>, localId: string): void {
  store.setState(removePendingStartAgentRow(store.getState(), localId));
}

function addSafeErrorToast(store: StoreApi<DashboardState>, error: SafeError): void {
  store.setState(addTuiToast(store.getState(), safeErrorToToast(error)));
}

async function runDashboardCapabilityOperation(input: {
  store: StoreApi<DashboardState>;
  capabilities: DashboardCapabilities;
  operation: DashboardCapabilityOperation;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
  expiry: FailedCreateExpiryScheduler;
}): Promise<DashboardExecutionResult> {
  const { store, capabilities, operation, clientLabel, scope, expiry } = input;
  let handle: DashboardExecutionHandle;
  try {
    switch (operation.type) {
      case "activateSession":
        handle = capabilities.activation.activate({
          sessionId: operation.sessionId,
          projectId: operation.projectId,
          worktreeId: operation.worktreeId,
          branch: operation.branch,
          preferredObserverAction: operation.preferredObserverAction,
        });
        break;
      case "createManagedSession":
      case "quickCreateManagedSession": {
        const request = {
          project: operation.project,
          title: operation.title,
          hiddenBranch: operation.hiddenBranch,
          harness: operation.harness,
          ...(operation.group === undefined ? {} : { group: operation.group }),
        };
        handle =
          operation.type === "createManagedSession"
            ? capabilities.managedSessions.create(request)
            : capabilities.managedSessions.quickCreate(request);
        break;
      }
      case "forkManagedSession":
        handle = capabilities.managedSessions.fork({
          project: operation.project,
          sourceWorktreeId: operation.sourceWorktreeId,
          title: operation.title,
          hiddenBranch: operation.hiddenBranch,
          copyDirty: operation.copyDirty,
          ...(operation.inheritedHarness === undefined
            ? {}
            : { inheritedHarness: operation.inheritedHarness }),
        });
        break;
      case "removeWorktree":
        handle = capabilities.worktreeRemoval.remove({
          worktreeId: operation.worktreeId,
          command: operation.command,
        });
        break;
      case "openDashboardShell":
        handle = capabilities.shell.open(operation.target);
        break;
      case "dismissDashboard":
        handle = capabilities.dismissal.dismissDashboard();
        break;
      case "exitDashboardRenderer":
        handle = capabilities.dismissal.exitRenderer({ exitCode: operation.exitCode });
        break;
      default: {
        const unreachable: never = operation;
        return unreachable;
      }
    }
  } catch (error: unknown) {
    const result: DashboardExecutionResult = {
      kind: "failure",
      error: toSafeError(error, { clientLabel }),
      disposition: "remove-immediately",
    };
    scope.commit(() => {
      if (operation.type === "createManagedSession") {
        store.setState(failNewSessionSubmission(store.getState(), operation.localId, result.error));
      }
      addSafeErrorToast(store, result.error);
    });
    return result;
  }

  scope.commit(() => applyCapabilityOptimisticState(store, operation, handle));
  try {
    const result = await handle.completion;
    scope.commit(() =>
      settleDashboardCapabilityOperation({ store, operation, handle, result, expiry }),
    );
    return result;
  } catch (error: unknown) {
    const result: DashboardExecutionResult = {
      kind: "failure",
      error: toSafeError(error, { clientLabel }),
      disposition: "remove-immediately",
    };
    scope.commit(() => {
      if (operation.type === "createManagedSession") {
        store.setState(failNewSessionSubmission(store.getState(), operation.localId, result.error));
      }
      removeCapabilityOptimisticRow(store, operation);
      addSafeErrorToast(store, result.error);
    });
    return result;
  }
}

function applyCapabilityOptimisticState(
  store: StoreApi<DashboardState>,
  operation: DashboardCapabilityOperation,
  handle: DashboardExecutionHandle,
): void {
  if (handle.optimistic === "pending-start" && operation.type === "activateSession") {
    if (operation.localId === undefined) {
      return;
    }
    store.setState(
      addPendingStartAgentRow(store.getState(), {
        localId: operation.localId,
        operation: operation.preferredObserverAction === "resume" ? "resumeAgent" : "startAgent",
        projectId: operation.projectId,
        worktreeId: operation.worktreeId,
        branch: operation.branch,
        createdAt: new Date().toISOString(),
      }),
    );
    return;
  }
  if (
    handle.optimistic === "pending-create" &&
    (operation.type === "quickCreateManagedSession" || operation.type === "forkManagedSession")
  ) {
    const pendingRow: Parameters<typeof addPendingCreateSessionRow>[1] = {
      localId: operation.localId,
      projectId: operation.project.id,
      title: operation.title,
      branch: operation.hiddenBranch,
      createdAt: new Date().toISOString(),
    };
    if (operation.type === "forkManagedSession") {
      if (operation.inheritedHarness !== undefined) {
        pendingRow.harnessProvider = operation.inheritedHarness;
      }
    } else {
      pendingRow.harnessProvider = operation.harness;
      if (operation.targetGroupId !== undefined) {
        pendingRow.targetGroupId = operation.targetGroupId;
      }
    }
    store.setState(addPendingCreateSessionRow(store.getState(), pendingRow));
  }
}

function settleDashboardCapabilityOperation(input: {
  store: StoreApi<DashboardState>;
  operation: DashboardCapabilityOperation;
  handle: DashboardExecutionHandle;
  result: Awaited<DashboardExecutionHandle["completion"]>;
  expiry: FailedCreateExpiryScheduler;
}): void {
  const { store, operation, handle, result, expiry } = input;
  if (operation.type === "createManagedSession") {
    if (result.kind === "success") {
      store.setState(completeNewSessionSubmission(store.getState(), operation.localId));
      if (result.notice !== undefined) {
        store.setState(addTuiToast(store.getState(), result.notice));
      }
      return;
    }
    const error = result.kind === "failure" ? result.error : undefined;
    store.setState(failNewSessionSubmission(store.getState(), operation.localId, error));
    if (result.kind === "notice") {
      store.setState(addTuiToast(store.getState(), result.notice));
    } else {
      addSafeErrorToast(store, result.error);
    }
    return;
  }
  if (result.kind === "success") {
    if (
      handle.successDisposition === "remove-immediately" &&
      !(operation.type === "quickCreateManagedSession" && operation.targetGroupId !== undefined)
    ) {
      removeCapabilityOptimisticRow(store, operation);
    }
    if (result.notice !== undefined) {
      store.setState(addTuiToast(store.getState(), result.notice));
    }
    return;
  }
  if (result.kind === "notice") {
    if (operation.type === "quickCreateManagedSession" && operation.targetGroupId !== undefined) {
      markCreateSessionRowFailed(
        store,
        operation.localId,
        {
          tag: "CommandExecutionError",
          code: "SESSION_CREATE_NOT_COMPLETED",
          message: result.notice.message,
          ...(result.notice.hint === undefined ? {} : { hint: result.notice.hint }),
        },
        expiry,
      );
    } else {
      removeCapabilityOptimisticRow(store, operation);
    }
    store.setState(addTuiToast(store.getState(), result.notice));
    return;
  }
  if (
    result.disposition === "retain-failed" &&
    (operation.type === "quickCreateManagedSession" || operation.type === "forkManagedSession")
  ) {
    markCreateSessionRowFailed(store, operation.localId, result.error, expiry);
  } else {
    removeCapabilityOptimisticRow(store, operation);
  }
  addSafeErrorToast(store, result.error);
}

function removeCapabilityOptimisticRow(
  store: StoreApi<DashboardState>,
  operation: DashboardCapabilityOperation,
): void {
  if (operation.type === "activateSession") {
    if (operation.localId !== undefined) {
      markStartAgentRowFailed(store, operation.localId);
    }
    return;
  }
  if (operation.type === "removeWorktree") {
    store.setState(removePendingRemoveWorktreeRow(store.getState(), operation.localId));
    return;
  }
  if (
    operation.type === "createManagedSession" ||
    operation.type === "quickCreateManagedSession" ||
    operation.type === "forkManagedSession"
  ) {
    store.setState(removeCreateSessionLocalRow(store.getState(), operation.localId));
  }
}
