import type { StoreApi } from "zustand/vanilla";
import type { TuiFolderService } from "../../services/folderService.js";
import type { ObserverService } from "../../services/types.js";
import type { DashboardCapabilities } from "../capabilities/execution.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import type { DashboardState } from "../types.js";
import {
  runAddProjectOperation,
  runLoadProjectDirectoryOperation,
  runReviewProjectFolderOperation,
  runSearchProjectDirectoriesOperation,
} from "./addProject.js";
import { createDashboardCapabilityOperationRunner } from "./capabilityOperation.js";
import { projectCommandOperations } from "./projectCommands.js";
import { runRemoveWorktreeOperation } from "./removeWorktree.js";
import { runRenameSessionOperation } from "./renameSession.js";
import { runCreateSessionGroupOperation } from "./sessionGroups.js";
import type { DashboardCapabilityOperation, TuiOperation } from "./types.js";

type OperationHandlers = {
  [Kind in TuiOperation["type"]]: (operation: Extract<TuiOperation, { type: Kind }>) => void;
};

function dispatchOperation(operation: TuiOperation, handlers: OperationHandlers): void {
  // The mapped type preserves key/payload correlation, which union indexing cannot express.
  const handler = handlers[operation.type] as (current: TuiOperation) => void;
  handler(operation);
}

/** Scope-bound admission and dispatch table for dashboard-local operations. */
export type TuiLocalOperationRunner = {
  run(operations: readonly TuiOperation[] | undefined): void;
};

export function createTuiLocalOperationRunner(input: {
  getStore: () => StoreApi<DashboardState>;
  service: ObserverService;
  folderService: TuiFolderService;
  capabilities: DashboardCapabilities;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
}): TuiLocalOperationRunner {
  const store = (): StoreApi<DashboardState> => input.getStore();
  const capabilityOperations = createDashboardCapabilityOperationRunner({
    getStore: input.getStore,
    capabilities: input.capabilities,
    clientLabel: input.clientLabel,
    scope: input.scope,
  });

  const runCapabilityOperation = (operation: DashboardCapabilityOperation): void => {
    input.scope.run(async () => {
      await capabilityOperations.run(operation);
    });
  };
  const handlers: OperationHandlers = {
    activateSession: runCapabilityOperation,
    createManagedSession: runCapabilityOperation,
    quickCreateManagedSession: runCapabilityOperation,
    forkManagedSession: runCapabilityOperation,
    openDashboardShell: runCapabilityOperation,
    dismissDashboard: runCapabilityOperation,
    exitDashboardRenderer: runCapabilityOperation,
    removeWorktree: (operation) => {
      input.scope.run(() =>
        runRemoveWorktreeOperation({
          store: store(),
          service: input.service,
          operation,
          clientLabel: input.clientLabel,
          scope: input.scope,
        }),
      );
    },
    renameSession: (operation) => {
      input.scope.run(() =>
        runRenameSessionOperation({
          store: store(),
          service: input.service,
          operation,
          clientLabel: input.clientLabel,
          scope: input.scope,
        }),
      );
    },
    loadProjectDirectory: (operation) => {
      input.scope.run(() =>
        runLoadProjectDirectoryOperation({
          store: store(),
          folderService: input.folderService,
          path: operation.path,
          clientLabel: input.clientLabel,
          scope: input.scope,
        }),
      );
    },
    reviewProjectFolder: (operation) => {
      input.scope.run(() =>
        runReviewProjectFolderOperation({
          store: store(),
          folderService: input.folderService,
          path: operation.path,
          clientLabel: input.clientLabel,
          scope: input.scope,
        }),
      );
    },
    searchProjectDirectories: (operation) => {
      input.scope.run(() =>
        runSearchProjectDirectoriesOperation({
          store: store(),
          folderService: input.folderService,
          query: operation.query,
          clientLabel: input.clientLabel,
          scope: input.scope,
        }),
      );
    },
    addProject: (operation) => {
      input.scope.run(() =>
        runAddProjectOperation({
          store: store(),
          service: input.service,
          command: operation.command,
          clientLabel: input.clientLabel,
          scope: input.scope,
        }),
      );
    },
    setProjectDefaultHarness: (operation) => {
      input.scope.run(() =>
        projectCommandOperations.setDefaultHarness({
          store: store(),
          service: input.service,
          command: operation.command,
          clientLabel: input.clientLabel,
          scope: input.scope,
        }),
      );
    },
    removeProject: (operation) => {
      input.scope.run(() =>
        projectCommandOperations.remove({
          store: store(),
          service: input.service,
          command: operation.command,
          clientLabel: input.clientLabel,
          scope: input.scope,
        }),
      );
    },
    createSessionGroup: (operation) => {
      input.scope.run(() =>
        runCreateSessionGroupOperation({
          store: store(),
          service: input.service,
          capabilities: capabilityOperations,
          operation,
          clientLabel: input.clientLabel,
          scope: input.scope,
        }),
      );
    },
  };

  return {
    run: (operations) => {
      for (const operation of operations ?? []) {
        dispatchOperation(operation, handlers);
      }
    },
  };
}
