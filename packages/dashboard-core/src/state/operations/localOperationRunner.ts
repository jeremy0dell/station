import { executeObserverCommand, type ObserverCommandExecutionResult } from "@station/client";
import type { SafeError, StationCommand } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { safeErrorToToast, toSafeError } from "../../services/errors/errors.js";
import type { TuiFolderService } from "../../services/folderService.js";
import type { ObserverService } from "../../services/types.js";
import type { DashboardCapabilities, DashboardExecutionHandle } from "../capabilities/execution.js";
import {
  addPendingCreateSessionRow,
  addPendingStartAgentRow,
  failPendingCreateSessionRow,
  removeCreateSessionLocalRow,
  removePendingProjectDefaultHarness,
  removePendingRemoveWorktreeRow,
  removePendingRenameSessionTitle,
  removePendingStartAgentRow,
} from "../localRows.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import { replaceSnapshot } from "../screen.js";
import {
  applyAddProjectFolderLoaded,
  applyAddProjectFolderLoadFailed,
  applyAddProjectFolderReviewed,
  applyAddProjectFolderReviewFailed,
  applyAddProjectFolderSearchFailed,
  applyAddProjectFolderSearchLoaded,
  applyAddProjectSubmitFailed,
  applyAddProjectSubmitted,
} from "../screens/addProjectScreen.js";
import { FAILED_CREATE_ROW_TTL_MS } from "../timing.js";
import { addTuiToast } from "../toasts.js";
import type { DashboardState, TuiState } from "../types.js";
import {
  createFailedCreateExpiryScheduler,
  type FailedCreateExpiryScheduler,
} from "./failedCreateExpiry.js";
import { runRemoveWorktreeOperation } from "./removeWorktree.js";
import { runRenameSessionOperation } from "./renameSession.js";
import type { DashboardCapabilityOperation, TuiOperation } from "./types.js";

/** Scope-bound executor for dashboard-local operations and capability completion. */
export type TuiLocalOperationRunner = {
  run(operations: readonly TuiOperation[] | undefined): void;
};

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

function markRemoveWorktreeRowFailed(store: StoreApi<DashboardState>, localId: string): void {
  store.setState(removePendingRemoveWorktreeRow(store.getState(), localId));
}

function markStartAgentRowFailed(store: StoreApi<DashboardState>, localId: string): void {
  store.setState(removePendingStartAgentRow(store.getState(), localId));
}

function markRenameSessionFailed(store: StoreApi<DashboardState>, sessionId: string): void {
  store.setState(removePendingRenameSessionTitle(store.getState(), sessionId));
}

function addSafeErrorToast(store: StoreApi<DashboardState>, error: SafeError): void {
  store.setState(addTuiToast(store.getState(), safeErrorToToast(error)));
}

function addRenameSuccessToast(store: StoreApi<DashboardState>): void {
  store.setState(
    addTuiToast(store.getState(), {
      kind: "success",
      message: "Session renamed.",
    }),
  );
}

export function createTuiLocalOperationRunner(input: {
  getStore: () => StoreApi<DashboardState>;
  service: ObserverService;
  folderService: TuiFolderService;
  capabilities: DashboardCapabilities;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): TuiLocalOperationRunner {
  const store = () => input.getStore();
  const expiry = createFailedCreateExpiryScheduler({
    getStore: input.getStore,
    scope: input.scope,
  });
  const commit = (mutation: () => void): void => {
    input.scope.commit(mutation);
  };

  return {
    run: (operations) => {
      for (const operation of operations ?? []) {
        if (isDashboardCapabilityOperation(operation)) {
          input.scope.run(() =>
            runDashboardCapabilityOperation({
              store: store(),
              capabilities: input.capabilities,
              operation,
              clientLabel: input.clientLabel,
              scope: input.scope,
              expiry,
            }),
          );
        }
        if (operation.type === "removeWorktree") {
          input.scope.run(() =>
            runRemoveWorktreeOperation({
              service: input.service,
              operation,
              clientLabel: input.clientLabel,
              markRemoveWorktreeRowFailed: (localId) =>
                commit(() => markRemoveWorktreeRowFailed(store(), localId)),
              addSafeErrorToast: (error) => commit(() => addSafeErrorToast(store(), error)),
            }),
          );
        }
        if (operation.type === "renameSession") {
          input.scope.run(() =>
            runRenameSessionOperation({
              service: input.service,
              operation,
              clientLabel: input.clientLabel,
              markRenameSessionFailed: (sessionId) =>
                commit(() => markRenameSessionFailed(store(), sessionId)),
              addSafeErrorToast: (error) => commit(() => addSafeErrorToast(store(), error)),
              addRenameSuccessToast: () => commit(() => addRenameSuccessToast(store())),
            }),
          );
        }
        if (operation.type === "loadProjectDirectory") {
          input.scope.run(() =>
            runLoadProjectDirectoryOperation({
              store: store(),
              folderService: input.folderService,
              path: operation.path,
              clientLabel: input.clientLabel,
              scope: input.scope,
            }),
          );
        }
        if (operation.type === "reviewProjectFolder") {
          input.scope.run(() =>
            runReviewProjectFolderOperation({
              store: store(),
              folderService: input.folderService,
              path: operation.path,
              clientLabel: input.clientLabel,
              scope: input.scope,
            }),
          );
        }
        if (operation.type === "searchProjectDirectories") {
          input.scope.run(() =>
            runSearchProjectDirectoriesOperation({
              store: store(),
              folderService: input.folderService,
              query: operation.query,
              clientLabel: input.clientLabel,
              scope: input.scope,
            }),
          );
        }
        if (operation.type === "addProject") {
          input.scope.run(() =>
            runAddProjectOperation({
              store: store(),
              service: input.service,
              command: operation.command,
              clientLabel: input.clientLabel,
              scope: input.scope,
            }),
          );
        }
        if (operation.type === "setProjectDefaultHarness") {
          input.scope.run(() =>
            runSetProjectDefaultHarnessOperation({
              store: store(),
              service: input.service,
              command: operation.command,
              clientLabel: input.clientLabel,
              scope: input.scope,
            }),
          );
        }
        if (operation.type === "removeProject") {
          input.scope.run(() =>
            runRemoveProjectOperation({
              store: store(),
              service: input.service,
              command: operation.command,
              clientLabel: input.clientLabel,
              scope: input.scope,
            }),
          );
        }
      }
    },
  };
}

function isDashboardCapabilityOperation(
  operation: TuiOperation,
): operation is DashboardCapabilityOperation {
  switch (operation.type) {
    case "activateSession":
    case "createManagedSession":
    case "quickCreateManagedSession":
    case "forkManagedSession":
    case "openDashboardShell":
    case "dismissDashboard":
    case "exitDashboardRenderer":
      return true;
    default:
      return false;
  }
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
    store.setState(
      addPendingCreateSessionRow(store.getState(), {
        localId: operation.localId,
        projectId: operation.project.id,
        title: operation.title,
        branch: operation.hiddenBranch,
        createdAt: new Date().toISOString(),
        ...(operation.type === "forkManagedSession"
          ? operation.inheritedHarness === undefined
            ? {}
            : { harnessProvider: operation.inheritedHarness }
          : { harnessProvider: operation.harness }),
      }),
    );
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

async function runSetProjectDefaultHarnessOperation(input: {
  store: StoreApi<DashboardState>;
  service: ObserverService;
  command: Extract<StationCommand, { type: "project.setDefaultHarness" }>;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const { store, service, command, clientLabel, scope } = input;
  // Roll the optimistic marker back to the snapshot's default; success leaves it
  // for the next snapshot to prune once the change has landed.
  const revertOptimistic = (): void => {
    scope.commit(() =>
      store.setState(
        removePendingProjectDefaultHarness(store.getState(), command.payload.projectId),
      ),
    );
  };
  try {
    const execution = await executeObserverCommand(service, command, { clientLabel });
    const failure = commandExecutionError(execution, (error) => ({
      ...error,
      tag: "CommandExecutionError",
      code: "COMMAND_REJECTED",
      message: `${command.type} was rejected.`,
    }));
    if (failure !== undefined) {
      revertOptimistic();
      scope.commit(() => addSafeCommandToast(store, failure));
      return;
    }
    const snapshot = await service.loadSnapshot();
    scope.commit(() =>
      store.setState(
        addTuiToast(replaceSnapshot(store.getState(), snapshot), {
          kind: "success",
          message: `Default agent set to ${command.payload.harness}.`,
        }),
      ),
    );
  } catch (error: unknown) {
    revertOptimistic();
    scope.commit(() => addSafeCommandToast(store, toSafeError(error, { clientLabel })));
  }
}

async function runRemoveProjectOperation(input: {
  store: StoreApi<DashboardState>;
  service: ObserverService;
  command: Extract<StationCommand, { type: "project.remove" }>;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const { store, service, command, clientLabel, scope } = input;
  // Read the label before dispatch; the post-reload snapshot no longer has it.
  const label = store
    .getState()
    .snapshot?.projects.find((candidate) => candidate.id === command.payload.projectId)?.label;
  try {
    const execution = await executeObserverCommand(service, command, { clientLabel });
    const failure = commandExecutionError(execution, (error) => ({
      ...error,
      tag: "CommandExecutionError",
      code: "COMMAND_REJECTED",
      message: `${command.type} was rejected.`,
    }));
    if (failure !== undefined) {
      scope.commit(() => addSafeCommandToast(store, failure));
      return;
    }
    const snapshot = await service.loadSnapshot();
    scope.commit(() =>
      store.setState(
        addTuiToast(replaceSnapshot(store.getState(), snapshot), {
          kind: "success",
          message: label === undefined ? "Project removed." : `Removed project ${label}.`,
        }),
      ),
    );
  } catch (error: unknown) {
    scope.commit(() => addSafeCommandToast(store, toSafeError(error, { clientLabel })));
  }
}

function addSafeCommandToast(store: StoreApi<DashboardState>, error: SafeError): void {
  store.setState(addTuiToast(store.getState(), safeErrorToToast(error)));
}

async function runLoadProjectDirectoryOperation(input: {
  store: StoreApi<DashboardState>;
  folderService: TuiFolderService;
  path: string;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const { store, folderService, path, clientLabel, scope } = input;
  try {
    const result = await folderService.readDirectory(path);
    scope.commit(() => store.setState(applyAddProjectFolderLoaded(store.getState(), result)));
  } catch (error: unknown) {
    scope.commit(() =>
      store.setState(applyAddProjectFolderLoadFailed(store.getState(), path, error, clientLabel)),
    );
  }
}

async function runReviewProjectFolderOperation(input: {
  store: StoreApi<DashboardState>;
  folderService: TuiFolderService;
  path: string;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const { store, folderService, path, clientLabel, scope } = input;
  try {
    const review = await folderService.reviewFolder(path);
    scope.commit(() => store.setState(applyAddProjectFolderReviewed(store.getState(), review)));
  } catch (error: unknown) {
    scope.commit(() =>
      store.setState(applyAddProjectFolderReviewFailed(store.getState(), path, error, clientLabel)),
    );
  }
}

async function runSearchProjectDirectoriesOperation(input: {
  store: StoreApi<DashboardState>;
  folderService: TuiFolderService;
  query: string;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const { store, folderService, query, clientLabel, scope } = input;
  try {
    const result = await folderService.searchDirectories(query);
    scope.commit(() => store.setState(applyAddProjectFolderSearchLoaded(store.getState(), result)));
  } catch (error: unknown) {
    scope.commit(() =>
      store.setState(
        applyAddProjectFolderSearchFailed(store.getState(), query, error, clientLabel),
      ),
    );
  }
}

async function runAddProjectOperation(input: {
  store: StoreApi<DashboardState>;
  service: ObserverService;
  command: Extract<StationCommand, { type: "project.add" }>;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): Promise<void> {
  const { store, service, command, clientLabel, scope } = input;
  try {
    const reviewedProject = currentReviewedProject(store.getState());
    const execution = await executeObserverCommand(service, command, { clientLabel });
    const failure = commandExecutionError(execution, (error) => ({
      ...error,
      tag: "CommandDispatchError",
      code: "PROJECT_ADD_REJECTED",
      message: "Project add was rejected.",
    }));
    if (failure !== undefined) {
      scope.commit(() => store.setState(applyAddProjectSubmitFailed(store.getState(), failure)));
      return;
    }
    const snapshot = await service.loadSnapshot();
    scope.commit(() => {
      const withSnapshot = replaceSnapshot(store.getState(), snapshot);
      store.setState(
        applyAddProjectSubmitted(withSnapshot, {
          label: reviewedProject?.label ?? command.payload.label ?? command.payload.id ?? "project",
          root: reviewedProject?.gitRoot ?? command.payload.path,
        }),
      );
    });
  } catch (error: unknown) {
    scope.commit(() =>
      store.setState(applyAddProjectSubmitFailed(store.getState(), error, clientLabel)),
    );
  }
}

function commandExecutionError(
  execution: ObserverCommandExecutionResult,
  rejectedFallback: (error: SafeError) => SafeError,
): SafeError | undefined {
  switch (execution.status) {
    case "accepted":
    case "succeeded":
      return undefined;
    case "failed":
    case "thrown":
      return execution.error;
    case "rejected":
      return execution.receipt.error === undefined
        ? rejectedFallback(execution.error)
        : execution.error;
  }
}

function currentReviewedProject(state: TuiState):
  | {
      label: string;
      gitRoot?: string;
    }
  | undefined {
  if (state.screen.name !== "addProject" || state.screen.flow.mode !== "review") {
    return undefined;
  }
  const result: { label: string; gitRoot?: string } = { label: state.screen.flow.label };
  if (state.screen.flow.gitRoot !== undefined) {
    result.gitRoot = state.screen.flow.gitRoot;
  }
  return result;
}
