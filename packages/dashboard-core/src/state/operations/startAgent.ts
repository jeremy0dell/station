import type {
  CommandId,
  SafeError,
  StationCommand,
  StationSnapshot,
  WorktreeRow,
} from "@station/contracts";
import type { StoreApi } from "zustand/vanilla";
import { toSafeError } from "../../services/errors/errors.js";
import type { TuiObserverService } from "../../services/types.js";
import { clampDashboardStateScroll } from "../dashboardScroll.js";
import { bindPendingStartAgentRow } from "../localRows.js";
import { replaceSnapshot } from "../screen.js";
import type { TuiStore } from "../store.js";
import { type CommandRuntimeOptions, prepareCommandForRuntime } from "./runtimeCommands.js";
import type { ResumeAgentOperation, StartAgentOperation } from "./types.js";

export type FocusStartedAgentRow = (snapshot: StationSnapshot, row: WorktreeRow) => Promise<void>;

export async function runStartAgentOperation(
  store: StoreApi<TuiStore>,
  service: TuiObserverService,
  runtime: CommandRuntimeOptions,
  operation: StartAgentOperation | ResumeAgentOperation,
  markStartAgentRowFailed: (localId: string) => void,
  markCommandFailureHandled: (commandId: CommandId) => void,
  hasCommandFailureBeenHandled: (commandId: CommandId) => boolean,
  addSafeErrorToast: (error: SafeError) => void,
  focusStartedAgentRow: FocusStartedAgentRow,
): Promise<void> {
  let commandId: CommandId | undefined;
  try {
    const command = (await prepareCommandForRuntime(operation.command, runtime)) as Extract<
      StationCommand,
      { type: "session.startAgent" | "session.resumeAgent" }
    >;
    const receipt = await service.dispatch(command);
    if (!receipt.accepted) {
      const safeError = receipt.error ?? {
        tag: "CommandExecutionError",
        code: "COMMAND_REJECTED",
        message: `${command.type} was rejected.`,
      };
      markStartAgentRowFailed(operation.localId);
      addSafeErrorToast(safeError);
      return;
    }

    commandId = receipt.commandId;
    store.setState(bindPendingStartAgentRow(store.getState(), operation.localId, commandId));
    const completion = await service.waitForCommandCompletion(commandId);
    if (completion.status === "failed") {
      const alreadyHandled = hasCommandFailureBeenHandled(completion.commandId);
      markCommandFailureHandled(completion.commandId);
      markStartAgentRowFailed(operation.localId);
      if (!alreadyHandled) {
        addSafeErrorToast(completion.error);
      }
      return;
    }
  } catch (error: unknown) {
    if (commandId !== undefined) {
      markCommandFailureHandled(commandId);
    }
    markStartAgentRowFailed(operation.localId);
    addSafeErrorToast(toSafeError(error, { clientLabel: runtime.clientLabel }));
    return;
  }

  try {
    await focusStartedAgentAfterSnapshotCatchup(
      store,
      service,
      operation,
      markStartAgentRowFailed,
      focusStartedAgentRow,
    );
  } catch (error: unknown) {
    addSafeErrorToast(toSafeError(error, { clientLabel: runtime.clientLabel }));
  }
}

async function focusStartedAgentAfterSnapshotCatchup(
  store: StoreApi<TuiStore>,
  service: TuiObserverService,
  operation: StartAgentOperation | ResumeAgentOperation,
  clearPendingStartAgentRow: (localId: string) => void,
  focusStartedAgentRow: FocusStartedAgentRow,
): Promise<void> {
  const current = startedRowForSnapshot(store.getState().snapshot, operation.worktreeId);
  if (current !== undefined) {
    clearPendingStartAgentRow(operation.localId);
    await focusStartedAgentRow(current.snapshot, current.row);
    return;
  }

  const loaded = await service.loadSnapshot();
  store.setState(clampDashboardStateScroll(replaceSnapshot(store.getState(), loaded)));

  const refreshed = startedRowForSnapshot(store.getState().snapshot, operation.worktreeId);
  if (refreshed === undefined) {
    return;
  }
  clearPendingStartAgentRow(operation.localId);
  await focusStartedAgentRow(refreshed.snapshot, refreshed.row);
}

function startedRowForSnapshot(
  snapshot: StationSnapshot | undefined,
  worktreeId: string,
): { snapshot: StationSnapshot; row: WorktreeRow } | undefined {
  if (snapshot === undefined) {
    return undefined;
  }
  const row = snapshot.rows.find((candidate) => candidate.id === worktreeId);
  if (row === undefined) {
    return undefined;
  }
  if (
    row.agent === undefined &&
    !snapshot.sessions.some((session) => session.worktreeId === worktreeId)
  ) {
    return undefined;
  }
  return { snapshot, row };
}
