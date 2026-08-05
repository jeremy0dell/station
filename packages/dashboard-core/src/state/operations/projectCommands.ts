import type { SafeError, StationCommand, StationSnapshot } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { safeErrorToToast, toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import { removePendingProjectDefaultHarness } from "../localRows.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import { replaceSnapshot } from "../screen.js";
import { addTuiToast } from "../toasts.js";
import type { DashboardState } from "../types.js";
import { executeDashboardCommandError } from "./commandExecutionError.js";

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
  const result = await executeProjectSnapshotCommand({ service, command, clientLabel });
  if (result.kind === "failure") {
    revertOptimistic();
    scope.commit(() => addSafeCommandToast(store, result.error));
    return;
  }
  commitProjectCommandSuccess({
    store,
    scope,
    snapshot: result.snapshot,
    toast: {
      kind: "success",
      message: `Default agent set to ${command.payload.harness}.`,
    },
  });
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
  const result = await executeProjectSnapshotCommand({ service, command, clientLabel });
  if (result.kind === "failure") {
    scope.commit(() => addSafeCommandToast(store, result.error));
    return;
  }
  commitProjectCommandSuccess({
    store,
    scope,
    snapshot: result.snapshot,
    toast: {
      kind: "success",
      message: label === undefined ? "Project removed." : `Removed project ${label}.`,
    },
  });
}

function commitProjectCommandSuccess(input: {
  store: StoreApi<DashboardState>;
  scope: DashboardRuntimeEffectScope;
  snapshot: StationSnapshot;
  toast: Parameters<typeof addTuiToast>[1];
}): void {
  input.scope.commit(() =>
    input.store.setState(
      addTuiToast(replaceSnapshot(input.store.getState(), input.snapshot), input.toast),
    ),
  );
}

type ProjectSnapshotCommand = Extract<
  StationCommand,
  { type: "project.setDefaultHarness" | "project.remove" }
>;

type ProjectSnapshotCommandResult =
  | { kind: "success"; snapshot: StationSnapshot }
  | { kind: "failure"; error: SafeError };

async function executeProjectSnapshotCommand(input: {
  service: ObserverService;
  command: ProjectSnapshotCommand;
  clientLabel: string;
}): Promise<ProjectSnapshotCommandResult> {
  try {
    const failure = await executeDashboardCommandError({
      service: input.service,
      command: input.command,
      clientLabel: input.clientLabel,
    });
    if (failure !== undefined) {
      return { kind: "failure", error: failure };
    }
    return { kind: "success", snapshot: await input.service.loadSnapshot() };
  } catch (error: unknown) {
    return {
      kind: "failure",
      error: toSafeError(error, { clientLabel: input.clientLabel }),
    };
  }
}

/** Observer-backed project settings/removal workflows and snapshot convergence. */
export const projectCommandOperations = {
  setDefaultHarness: runSetProjectDefaultHarnessOperation,
  remove: runRemoveProjectOperation,
};

function addSafeCommandToast(store: StoreApi<DashboardState>, error: SafeError): void {
  store.setState(addTuiToast(store.getState(), safeErrorToToast(error)));
}
