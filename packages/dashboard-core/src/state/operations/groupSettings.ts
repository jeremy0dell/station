import type { SafeError } from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { safeErrorToToast, toSafeError } from "../../services/errors/errors.js";
import type { ObserverService } from "../../services/types.js";
import { focusDashboardProject } from "../dashboardFocus.js";
import type { DashboardRuntimeEffectScope } from "../runtimeEffectScope.js";
import { reseedCompletedGroupSettings } from "../screens/groupSettings.js";
import { addTuiToast } from "../toasts.js";
import type { DashboardState } from "../types.js";
import { executeDashboardCommandError } from "./commandExecutionError.js";
import type {
  DeleteSessionGroupOperation,
  RenameSessionGroupOperation,
  UpdateSessionGroupMembershipOperation,
} from "./types.js";

export async function runRenameSessionGroupOperation(
  input: GroupSettingsOperationInput<RenameSessionGroupOperation>,
): Promise<void> {
  const failure = await executeGroupSettingsCommand(input);
  if (!input.scope.isOpen()) return;
  input.scope.commit(() => {
    if (failure === undefined) {
      input.store.setState(
        reseedCompletedGroupSettings(input.store.getState(), "rename", input.operation.groupId),
      );
    } else {
      retainGroupSettingsFailure(input.store, input.operation, "rename", failure);
    }
  });
}

export async function runUpdateSessionGroupMembershipOperation(
  input: GroupSettingsOperationInput<UpdateSessionGroupMembershipOperation>,
): Promise<void> {
  const failure = await executeGroupSettingsCommand(input);
  if (!input.scope.isOpen()) return;
  input.scope.commit(() => {
    if (failure === undefined) {
      input.store.setState(
        reseedCompletedGroupSettings(input.store.getState(), "membership", input.operation.groupId),
      );
    } else {
      retainGroupSettingsFailure(input.store, input.operation, "membership", failure);
    }
  });
}

export async function runDeleteSessionGroupOperation(
  input: GroupSettingsOperationInput<DeleteSessionGroupOperation>,
): Promise<void> {
  const failure = await executeGroupSettingsCommand(input);
  if (!input.scope.isOpen()) return;
  input.scope.commit(() => {
    if (failure === undefined) {
      input.store.setState(
        focusDashboardProject(input.store.getState(), input.operation.projectId, "identity"),
      );
    } else {
      retainGroupSettingsFailure(input.store, input.operation, "delete", failure);
    }
  });
}

type GroupSettingsOperation =
  | RenameSessionGroupOperation
  | UpdateSessionGroupMembershipOperation
  | DeleteSessionGroupOperation;

type GroupSettingsOperationInput<Operation extends GroupSettingsOperation> = {
  store: StoreApi<DashboardState>;
  service: ObserverService;
  operation: Operation;
  clientLabel: string;
  scope: DashboardRuntimeEffectScope;
};

async function executeGroupSettingsCommand(
  input: GroupSettingsOperationInput<GroupSettingsOperation>,
): Promise<SafeError | undefined> {
  try {
    return await executeDashboardCommandError({
      service: input.service,
      command: input.operation.command,
      clientLabel: input.clientLabel,
    });
  } catch (error: unknown) {
    return toSafeError(error, { clientLabel: input.clientLabel });
  }
}

function retainGroupSettingsFailure(
  store: StoreApi<DashboardState>,
  operation: GroupSettingsOperation,
  pending: "rename" | "membership" | "delete",
  error: SafeError,
): void {
  const state = store.getState();
  const screen = state.screen;
  if (
    screen.name !== "groupSettings" ||
    screen.groupId !== operation.groupId ||
    screen.pending !== pending
  ) {
    store.setState(addTuiToast(state, safeErrorToToast(error)));
    return;
  }
  const nextScreen = { ...screen };
  delete nextScreen.pending;
  nextScreen.focus = "detail";
  nextScreen.detailFocus =
    pending === "rename"
      ? "generalSave"
      : pending === "membership"
        ? "membershipSave"
        : "removeSubmit";
  store.setState(addTuiToast({ ...state, screen: nextScreen }, safeErrorToToast(error)));
}
