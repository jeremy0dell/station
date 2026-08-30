import type { DashboardActions, DashboardStateSource } from "@station/dashboard-core/runtime";
import { selectDashboardSlots } from "@station/dashboard-core/selectors";
import type { DashboardRowId } from "@station/dashboard-core/selectors";
import type { TuiKey, TuiSemanticAction } from "@station/dashboard-core/state";
import { sequenceToTuiKey } from "./sequenceToTuiKey.js";
import type { DashboardScrollController } from "../view/layout/scroll/dashboardScrollController.js";

type DashboardKeyInput = {
  actions: Pick<DashboardActions, "handleKey">;
};

type DashboardTransitionInput = DashboardKeyInput & {
  state: DashboardStateSource;
  actions: Pick<DashboardActions, "dispatch" | "handleKey">;
  layout: DashboardScrollController;
};

type DashboardToastDismissal = {
  actions: Pick<DashboardActions, "dismissToasts">;
};

/** Translate one native sequence and dispatch it through the closed dashboard action surface. */
export function handleStationSequence(
  runtime: DashboardKeyInput,
  sequence: string,
): void {
  const key = sequenceToTuiKey(sequence);
  if (key !== undefined) {
    runtime.actions.handleKey(key);
  }
}

export function dispatchStationKey(runtime: DashboardTransitionInput, key: TuiKey): void {
  runtime.actions.handleKey(key);
}

export function dispatchStationAction(
  runtime: DashboardTransitionInput,
  action: TuiSemanticAction,
): void {
  runtime.actions.dispatch(action);
}

/**
 * Dispatch a current row's slot only for chooser modes that intentionally retain
 * slot semantics; dashboard activation uses the exact dashboard cell directly.
 */
export function dispatchRowSlot(runtime: DashboardTransitionInput, rowId: DashboardRowId): void {
  const state = runtime.state.getState();
  if (state.snapshot === undefined) {
    return;
  }
  const slots = selectDashboardSlots(
    state.snapshot,
    state,
    state.screen,
    runtime.layout.snapshot(),
  );
  const row = slots.tree.rowById.get(rowId);
  if (row?.payload.type !== "session") {
    return;
  }
  const sessionId = row.payload.row.id;
  const choice = slots.rowChoices.find((candidate) => candidate.value.id === sessionId);
  if (choice !== undefined) {
    dispatchStationKey(runtime, { input: choice.key });
  }
}

export function dismissStationToasts(runtime: DashboardToastDismissal): void {
  runtime.actions.dismissToasts();
}
