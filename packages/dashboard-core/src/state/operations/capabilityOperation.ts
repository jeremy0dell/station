import type { SafeError } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { safeErrorToToast, toSafeError } from "../../services/errors/errors.js";
import type { DashboardCapabilities, DashboardExecutionHandle } from "../capabilities/execution.js";
import {
  addPendingCreateSessionRow,
  addPendingStartAgentRow,
  failPendingCreateSessionRow,
  removeCreateSessionLocalRow,
  removePendingStartAgentRow,
} from "../localRows.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import { FAILED_CREATE_ROW_TTL_MS } from "../timing.js";
import { addTuiToast } from "../toasts.js";
import type { DashboardState } from "../types.js";
import {
  createFailedCreateExpiryScheduler,
  type FailedCreateExpiryScheduler,
} from "./failedCreateExpiry.js";
import type { DashboardCapabilityOperation } from "./types.js";

/** Scope-bound executor for renderer-injected dashboard capabilities and settlement policy. */
export type DashboardCapabilityOperationRunner = {
  run(operation: DashboardCapabilityOperation): Promise<void>;
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
}): Promise<void> {
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
    scope.commit(() => addSafeErrorToast(store, toSafeError(error, { clientLabel })));
    return;
  }

  scope.commit(() => applyCapabilityOptimisticState(store, operation, handle));
  try {
    const result = await handle.completion;
    scope.commit(() =>
      settleDashboardCapabilityOperation({ store, operation, handle, result, expiry }),
    );
  } catch (error: unknown) {
    scope.commit(() => {
      removeCapabilityOptimisticRow(store, operation);
      addSafeErrorToast(store, toSafeError(error, { clientLabel }));
    });
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
    (operation.type === "createManagedSession" ||
      operation.type === "quickCreateManagedSession" ||
      operation.type === "forkManagedSession")
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
  if (result.kind === "success") {
    if (handle.successDisposition === "remove-immediately") {
      removeCapabilityOptimisticRow(store, operation);
    }
    return;
  }
  if (result.kind === "notice") {
    removeCapabilityOptimisticRow(store, operation);
    store.setState(addTuiToast(store.getState(), result.notice));
    return;
  }
  if (
    result.disposition === "retain-failed" &&
    (operation.type === "createManagedSession" ||
      operation.type === "quickCreateManagedSession" ||
      operation.type === "forkManagedSession")
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
  if (
    operation.type === "createManagedSession" ||
    operation.type === "quickCreateManagedSession" ||
    operation.type === "forkManagedSession"
  ) {
    store.setState(removeCreateSessionLocalRow(store.getState(), operation.localId));
  }
}
