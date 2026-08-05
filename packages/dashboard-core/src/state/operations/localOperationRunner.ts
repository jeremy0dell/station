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
import { runRemoveWorktreeOperation } from "./removeWorktree.js";
import { runRenameSessionOperation } from "./renameSession.js";
import type { DashboardCapabilityOperation, TuiOperation } from "./types.js";

export type TuiLocalOperationRunner = {
  run(operations: readonly TuiOperation[] | undefined): void;
};

function markCreateSessionRowFailed(
  store: StoreApi<DashboardState>,
  localId: string,
  error: SafeError,
): void {
  store.setState(
    failPendingCreateSessionRow(
      store.getState(),
      localId,
      error,
      Date.now() + FAILED_CREATE_ROW_TTL_MS,
    ),
  );
  setTimeout(() => {
    store.setState(removeCreateSessionLocalRow(store.getState(), localId));
  }, FAILED_CREATE_ROW_TTL_MS);
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
}): TuiLocalOperationRunner {
  const store = () => input.getStore();

  return {
    run: (operations) => {
      for (const operation of operations ?? []) {
        if (isDashboardCapabilityOperation(operation)) {
          runDashboardCapabilityOperation(
            store(),
            input.capabilities,
            operation,
            input.clientLabel,
          );
        }
        if (operation.type === "removeWorktree") {
          void runRemoveWorktreeOperation(
            store(),
            input.service,
            operation,
            input.clientLabel,
            (localId) => markRemoveWorktreeRowFailed(store(), localId),
            (error) => addSafeErrorToast(store(), error),
          );
        }
        if (operation.type === "renameSession") {
          void runRenameSessionOperation(
            store(),
            input.service,
            operation,
            input.clientLabel,
            (sessionId) => markRenameSessionFailed(store(), sessionId),
            (error) => addSafeErrorToast(store(), error),
            () => addRenameSuccessToast(store()),
          );
        }
        if (operation.type === "loadProjectDirectory") {
          void runLoadProjectDirectoryOperation(
            store(),
            input.folderService,
            operation.path,
            input.clientLabel,
          );
        }
        if (operation.type === "reviewProjectFolder") {
          void runReviewProjectFolderOperation(
            store(),
            input.folderService,
            operation.path,
            input.clientLabel,
          );
        }
        if (operation.type === "searchProjectDirectories") {
          void runSearchProjectDirectoriesOperation(
            store(),
            input.folderService,
            operation.query,
            input.clientLabel,
          );
        }
        if (operation.type === "addProject") {
          void runAddProjectOperation(store(), input.service, operation.command, input.clientLabel);
        }
        if (operation.type === "setProjectDefaultHarness") {
          void runSetProjectDefaultHarnessOperation(
            store(),
            input.service,
            operation.command,
            input.clientLabel,
          );
        }
        if (operation.type === "removeProject") {
          void runRemoveProjectOperation(
            store(),
            input.service,
            operation.command,
            input.clientLabel,
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

function runDashboardCapabilityOperation(
  store: StoreApi<DashboardState>,
  capabilities: DashboardCapabilities,
  operation: DashboardCapabilityOperation,
  clientLabel: string,
): void {
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
    addSafeErrorToast(store, toSafeError(error, { clientLabel }));
    return;
  }

  applyCapabilityOptimisticState(store, operation, handle);
  void handle.completion.then(
    (result) => settleDashboardCapabilityOperation(store, operation, handle, result),
    (error: unknown) => {
      removeCapabilityOptimisticRow(store, operation);
      addSafeErrorToast(store, toSafeError(error, { clientLabel }));
    },
  );
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

function settleDashboardCapabilityOperation(
  store: StoreApi<DashboardState>,
  operation: DashboardCapabilityOperation,
  handle: DashboardExecutionHandle,
  result: Awaited<DashboardExecutionHandle["completion"]>,
): void {
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
    markCreateSessionRowFailed(store, operation.localId, result.error);
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

async function runSetProjectDefaultHarnessOperation(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  command: Extract<StationCommand, { type: "project.setDefaultHarness" }>,
  clientLabel: string,
): Promise<void> {
  // Roll the optimistic marker back to the snapshot's default; success leaves it
  // for the next snapshot to prune once the change has landed.
  const revertOptimistic = () =>
    store.setState(removePendingProjectDefaultHarness(store.getState(), command.payload.projectId));
  try {
    const receipt = await service.dispatch(command);
    if (!receipt.accepted) {
      revertOptimistic();
      addSafeCommandToast(
        store,
        receipt.error ?? {
          tag: "CommandExecutionError",
          code: "COMMAND_REJECTED",
          message: `${command.type} was rejected.`,
        },
      );
      return;
    }
    const completion = await service.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "failed") {
      revertOptimistic();
      addSafeCommandToast(store, completion.error);
      return;
    }
    const snapshot = await service.loadSnapshot();
    store.setState(
      addTuiToast(replaceSnapshot(store.getState(), snapshot), {
        kind: "success",
        message: `Default agent set to ${command.payload.harness}.`,
      }),
    );
  } catch (error: unknown) {
    revertOptimistic();
    addSafeCommandToast(store, toSafeError(error, { clientLabel }));
  }
}

async function runRemoveProjectOperation(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  command: Extract<StationCommand, { type: "project.remove" }>,
  clientLabel: string,
): Promise<void> {
  // Read the label before dispatch; the post-reload snapshot no longer has it.
  const label = store
    .getState()
    .snapshot?.projects.find((candidate) => candidate.id === command.payload.projectId)?.label;
  try {
    const receipt = await service.dispatch(command);
    if (!receipt.accepted) {
      addSafeCommandToast(
        store,
        receipt.error ?? {
          tag: "CommandExecutionError",
          code: "COMMAND_REJECTED",
          message: `${command.type} was rejected.`,
        },
      );
      return;
    }
    const completion = await service.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "failed") {
      addSafeCommandToast(store, completion.error);
      return;
    }
    const snapshot = await service.loadSnapshot();
    store.setState(
      addTuiToast(replaceSnapshot(store.getState(), snapshot), {
        kind: "success",
        message: label === undefined ? "Project removed." : `Removed project ${label}.`,
      }),
    );
  } catch (error: unknown) {
    addSafeCommandToast(store, toSafeError(error, { clientLabel }));
  }
}

function addSafeCommandToast(store: StoreApi<DashboardState>, error: SafeError): void {
  store.setState(addTuiToast(store.getState(), safeErrorToToast(error)));
}

async function runLoadProjectDirectoryOperation(
  store: StoreApi<DashboardState>,
  folderService: TuiFolderService,
  path: string,
  clientLabel: string,
): Promise<void> {
  try {
    const result = await folderService.readDirectory(path);
    store.setState(applyAddProjectFolderLoaded(store.getState(), result));
  } catch (error: unknown) {
    store.setState(applyAddProjectFolderLoadFailed(store.getState(), path, error, clientLabel));
  }
}

async function runReviewProjectFolderOperation(
  store: StoreApi<DashboardState>,
  folderService: TuiFolderService,
  path: string,
  clientLabel: string,
): Promise<void> {
  try {
    const review = await folderService.reviewFolder(path);
    store.setState(applyAddProjectFolderReviewed(store.getState(), review));
  } catch (error: unknown) {
    store.setState(applyAddProjectFolderReviewFailed(store.getState(), path, error, clientLabel));
  }
}

async function runSearchProjectDirectoriesOperation(
  store: StoreApi<DashboardState>,
  folderService: TuiFolderService,
  query: string,
  clientLabel: string,
): Promise<void> {
  try {
    const result = await folderService.searchDirectories(query);
    store.setState(applyAddProjectFolderSearchLoaded(store.getState(), result));
  } catch (error: unknown) {
    store.setState(applyAddProjectFolderSearchFailed(store.getState(), query, error, clientLabel));
  }
}

async function runAddProjectOperation(
  store: StoreApi<DashboardState>,
  service: ObserverService,
  command: Extract<StationCommand, { type: "project.add" }>,
  clientLabel: string,
): Promise<void> {
  try {
    const reviewedProject = currentReviewedProject(store.getState());
    const receipt = await service.dispatch(command);
    if (!receipt.accepted) {
      const error =
        receipt.error ??
        ({
          tag: "CommandDispatchError",
          code: "PROJECT_ADD_REJECTED",
          message: "Project add was rejected.",
        } satisfies SafeError);
      store.setState(applyAddProjectSubmitFailed(store.getState(), error));
      return;
    }
    const completion = await service.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "failed") {
      store.setState(applyAddProjectSubmitFailed(store.getState(), completion.error));
      return;
    }
    const snapshot = await service.loadSnapshot();
    const withSnapshot = replaceSnapshot(store.getState(), snapshot);
    store.setState(
      applyAddProjectSubmitted(withSnapshot, {
        label: reviewedProject?.label ?? command.payload.label ?? command.payload.id ?? "project",
        root: reviewedProject?.gitRoot ?? command.payload.path,
      }),
    );
  } catch (error: unknown) {
    store.setState(applyAddProjectSubmitFailed(store.getState(), error, clientLabel));
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
