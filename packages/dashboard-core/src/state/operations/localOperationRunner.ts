import type { CommandId, SafeError, StationCommand, StationEvent } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { safeErrorToToast } from "../../services/errors/errors.js";
import type { TuiFolderService } from "../../services/folderService.js";
import type { TuiObserverService } from "../../services/types.js";
import {
  failPendingCreateSessionRow,
  removeCreateSessionLocalRow,
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
import type { TuiStore } from "../store.js";
import { FAILED_CREATE_ROW_TTL_MS } from "../timing.js";
import { addTuiToast } from "../toasts.js";
import type { TuiState } from "../types.js";
import { runCreateSessionOperation } from "./createSession.js";
import { runRemoveWorktreeOperation } from "./removeWorktree.js";
import { runRenameSessionOperation } from "./renameSession.js";
import type { CommandRuntimeOptions } from "./runtimeCommands.js";
import { type FocusStartedAgentRow, runStartAgentOperation } from "./startAgent.js";
import type { TuiOperation } from "./types.js";

export type CommandFailedEventHandling = {
  suppressReducerToast: boolean;
  applyLocalEffect(): void;
};

export type TuiLocalOperationRunner = {
  run(operations: readonly TuiOperation[] | undefined): void;
  prepareCommandFailedEvent(event: CommandFailedEvent): CommandFailedEventHandling;
};

type CommandFailedEvent = Extract<StationEvent, { type: "command.failed" }>;

type LocalCommandFailure =
  | { type: "createSession"; localId: string }
  | { type: "removeWorktree"; localId: string }
  | { type: "startAgent" | "resumeAgent"; localId: string }
  | { type: "renameSession"; sessionId: string };

function localCommandFailureForState(
  state: TuiState,
  commandId: CommandId,
): LocalCommandFailure | undefined {
  const createRow = state.localRows.pendingCreate.find(
    (candidate) => candidate.commandId === commandId,
  );
  if (createRow !== undefined) {
    return { type: "createSession", localId: createRow.localId };
  }
  const removeRow = state.localRows.pendingRemove.find(
    (candidate) => candidate.commandId === commandId,
  );
  if (removeRow !== undefined) {
    return { type: "removeWorktree", localId: removeRow.localId };
  }
  const startRow = state.localRows.pendingStart.find(
    (candidate) => candidate.commandId === commandId,
  );
  if (startRow !== undefined) {
    return { type: startRow.operation ?? "startAgent", localId: startRow.localId };
  }
  const renameRow = Object.values(state.localRows.pendingRenameTitles ?? {}).find(
    (candidate) => candidate.commandId === commandId,
  );
  if (renameRow !== undefined) {
    return { type: "renameSession", sessionId: renameRow.sessionId };
  }
  return undefined;
}

function markCreateSessionRowFailed(
  store: StoreApi<TuiStore>,
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

function markRemoveWorktreeRowFailed(store: StoreApi<TuiStore>, localId: string): void {
  store.setState(removePendingRemoveWorktreeRow(store.getState(), localId));
}

function markStartAgentRowFailed(store: StoreApi<TuiStore>, localId: string): void {
  store.setState(removePendingStartAgentRow(store.getState(), localId));
}

function markRenameSessionFailed(store: StoreApi<TuiStore>, sessionId: string): void {
  store.setState(removePendingRenameSessionTitle(store.getState(), sessionId));
}

function addSafeErrorToast(store: StoreApi<TuiStore>, error: SafeError): void {
  store.setState(addTuiToast(store.getState(), safeErrorToToast(error)));
}

function addRenameSuccessToast(store: StoreApi<TuiStore>): void {
  store.setState(
    addTuiToast(store.getState(), {
      kind: "success",
      message: "Session renamed.",
    }),
  );
}

export function createTuiLocalOperationRunner(input: {
  getStore: () => StoreApi<TuiStore>;
  service: TuiObserverService;
  folderService: TuiFolderService;
  runtime: CommandRuntimeOptions;
  clientLabel: string;
  focusStartedAgentRow: FocusStartedAgentRow;
}): TuiLocalOperationRunner {
  const handledCommandFailureIds = new Set<CommandId>();
  const store = () => input.getStore();

  return {
    run: (operations) => {
      for (const operation of operations ?? []) {
        if (operation.type === "createSession") {
          void runCreateSessionOperation(
            store(),
            input.service,
            input.runtime,
            operation,
            (localId, error) => markCreateSessionRowFailed(store(), localId, error),
            (commandId) => handledCommandFailureIds.add(commandId),
            (commandId) => handledCommandFailureIds.has(commandId),
            (error) => addSafeErrorToast(store(), error),
          );
        }
        if (operation.type === "removeWorktree") {
          void runRemoveWorktreeOperation(
            store(),
            input.service,
            operation,
            input.clientLabel,
            (localId) => markRemoveWorktreeRowFailed(store(), localId),
            (commandId) => handledCommandFailureIds.add(commandId),
            (commandId) => handledCommandFailureIds.has(commandId),
            (error) => addSafeErrorToast(store(), error),
          );
        }
        if (operation.type === "startAgent" || operation.type === "resumeAgent") {
          void runStartAgentOperation(
            store(),
            input.service,
            input.runtime,
            operation,
            (localId) => markStartAgentRowFailed(store(), localId),
            (commandId) => handledCommandFailureIds.add(commandId),
            (commandId) => handledCommandFailureIds.has(commandId),
            (error) => addSafeErrorToast(store(), error),
            input.focusStartedAgentRow,
          );
        }
        if (operation.type === "renameSession") {
          void runRenameSessionOperation(
            store(),
            input.service,
            operation,
            input.clientLabel,
            (sessionId) => markRenameSessionFailed(store(), sessionId),
            (commandId) => handledCommandFailureIds.add(commandId),
            (commandId) => handledCommandFailureIds.has(commandId),
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
      }
    },
    prepareCommandFailedEvent: (event) => {
      const localFailure = localCommandFailureForState(store().getState(), event.commandId);
      const suppressReducerToast =
        localFailure !== undefined || handledCommandFailureIds.has(event.commandId);
      return {
        suppressReducerToast,
        applyLocalEffect: () => {
          if (localFailure === undefined) {
            return;
          }
          handledCommandFailureIds.add(event.commandId);
          if (localFailure.type === "createSession") {
            markCreateSessionRowFailed(store(), localFailure.localId, event.error);
          } else if (localFailure.type === "removeWorktree") {
            markRemoveWorktreeRowFailed(store(), localFailure.localId);
          } else if (localFailure.type === "startAgent" || localFailure.type === "resumeAgent") {
            markStartAgentRowFailed(store(), localFailure.localId);
          } else if (localFailure.type === "renameSession") {
            markRenameSessionFailed(store(), localFailure.sessionId);
          }
          addSafeErrorToast(store(), event.error);
        },
      };
    },
  };
}

async function runLoadProjectDirectoryOperation(
  store: StoreApi<TuiStore>,
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
  store: StoreApi<TuiStore>,
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
  store: StoreApi<TuiStore>,
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
  store: StoreApi<TuiStore>,
  service: TuiObserverService,
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
