import {
  createSetupSessionApplication,
  type SetupOperationExecutor,
  type SetupSessionApplication,
} from "@station/setup-core";
import {
  createSetupInspectionAdapter,
  type SetupInspectionAdapter,
  type SetupInspectionSnapshot,
} from "../adapters/inspection.js";
import type { SetupMode } from "../adapters/inspectionTypes.js";
import { createSetupOperationAdapter } from "../adapters/operations.js";
import type { SetupCommandDeps, SetupCommandOptions } from "../types.js";

export type CliSetupSession = {
  readonly application: SetupSessionApplication;
  readonly inspection: SetupInspectionAdapter;
  readonly snapshot: () => SetupInspectionSnapshot | undefined;
};

export type CreateCliSetupSessionOptions = {
  readonly mode: SetupMode;
  readonly options: SetupCommandOptions;
  readonly deps: SetupCommandDeps;
  readonly noBrew: boolean;
  readonly planConfigWrite: boolean;
};

export function createCliSetupSession(options: CreateCliSetupSessionOptions): CliSetupSession {
  const inspection = createSetupInspectionAdapter({
    mode: options.mode,
    options: options.options,
    deps: options.deps,
    noBrew: options.noBrew,
    planConfigWrite: options.planConfigWrite,
  });
  let executor: SetupOperationExecutor | undefined;
  const executeOperation: SetupOperationExecutor = async (operation) => {
    if (executor === undefined) {
      const snapshot = inspection.current();
      if (snapshot === undefined) {
        return {
          status: "failed",
          operationId: operation.id,
          error: {
            tag: "SetupSessionError",
            code: "SETUP_INSPECTION_REQUIRED",
            message: "Setup inspection must complete before operations can run.",
          },
        };
      }
      // One operation adapter retains the committed config identity for the following activation.
      executor = createSetupOperationAdapter({ facts: snapshot.facts, deps: options.deps });
    }
    return executor(operation);
  };
  const application = createSetupSessionApplication({
    intent: {
      mode: options.mode,
      harnessSelection: { kind: "automatic" },
      installWorktrunkHooks: false,
    },
    inspection,
    executeOperation,
  });
  return { application, inspection, snapshot: inspection.current };
}
