import {
  selectDashboardViewport,
  type DashboardActions,
  type DashboardStateSource,
  type TuiKey,
  type TuiSemanticAction,
} from "@station/dashboard-core";
import { sequenceToTuiKey } from "./sequenceToTuiKey.js";

type DashboardKeyInput = {
  actions: Pick<DashboardActions, "handleKey">;
};

type DashboardTransitionInput = DashboardKeyInput & {
  state: DashboardStateSource;
  actions: Pick<DashboardActions, "dispatch" | "handleKey">;
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
 * slot semantics; dashboard activation uses `dashboard.row.activate` directly.
 */
export function dispatchRowSlot(runtime: DashboardTransitionInput, rowId: string): void {
  const state = runtime.state.getState();
  if (state.snapshot === undefined) {
    return;
  }
  const choice = selectDashboardViewport(state.snapshot, state).rowChoices.find(
    (candidate) => candidate.value.id === rowId,
  );
  if (choice !== undefined) {
    dispatchStationKey(runtime, { input: choice.key });
  }
}

export function dismissStationToasts(runtime: DashboardToastDismissal): void {
  runtime.actions.dismissToasts();
}
