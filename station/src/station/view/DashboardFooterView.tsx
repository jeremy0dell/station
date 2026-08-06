import type { ColorInput } from "@opentui/core";
import { useStore } from "zustand/react";
import type { DashboardStateSource } from "@station/dashboard-core/runtime";
import { dashboardFooterModel, truncateCells } from "@station/dashboard-core/selectors";
import type { DashboardFooterModel } from "@station/dashboard-core/selectors";
import { 
  activeTuiToast,
  isTuiToastHiddenByScreen,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
 } from "@station/dashboard-core/state";
import type { DashboardStateView } from "@station/dashboard-core/state";
import { toOpenTuiColor, useStationTheme, type StationTheme } from "../../theme/index.js";
import { DashboardFilterFooterView } from "./DashboardFilterFooterView.js";

export type DashboardFooterViewProps = {
  state: DashboardStateSource;
  columns: number;
};

export function DashboardFooterView({ state, columns }: DashboardFooterViewProps) {
  const theme = useStationTheme();
  const snapshot = useStore(state, (current) => current.snapshot);
  const screen = useStore(state, (current) => current.screen);
  const persistentFilter = useStore(state, (current) => current.persistentFilter);
  const quitHint = useStore(state, selectFooterQuitHint);
  const contentColumns = Math.max(1, Math.floor(columns));
  const model = dashboardFooterModel({
    columns: contentColumns,
    quitHint,
    hasSnapshot: snapshot !== undefined,
    firstRun: snapshot !== undefined && snapshot.projects.length === 0,
    screen,
    ...(persistentFilter === undefined ? {} : { persistentFilter }),
  });

  if (
    model.kind === "persistentFilterEditing" ||
    model.kind === "persistentFilterCondition" ||
    model.kind === "persistentFilterApplied"
  ) {
    return (
      <DashboardFilterFooterView
        segments={model.segments}
        variant={filterFooterVariant(model.kind)}
      />
    );
  }
  return (
    <text fg={dashboardFooterColor(theme, model)}>{truncateCells(model.text, contentColumns)}</text>
  );
}

function filterFooterVariant(
  kind:
    | "persistentFilterEditing"
    | "persistentFilterCondition"
    | "persistentFilterApplied",
): "editing" | "condition" | "applied" {
  switch (kind) {
    case "persistentFilterEditing":
      return "editing";
    case "persistentFilterCondition":
      return "condition";
    case "persistentFilterApplied":
      return "applied";
  }
}

function dashboardFooterColor(
  theme: StationTheme,
  model: Exclude<
    DashboardFooterModel,
    {
      kind:
        | "persistentFilterEditing"
        | "persistentFilterCondition"
        | "persistentFilterApplied";
    }
  >,
): ColorInput {
  return toOpenTuiColor(model.kind === "loading" ? theme.text.muted : theme.text.primary);
}

function selectFooterQuitHint(
  state: Pick<DashboardStateView, "screen" | "toasts">,
): string {
  const activeToast = activeTuiToast(state);
  return !isTuiToastHiddenByScreen(state.screen) && activeToast?.toast.kind === "error"
    ? QUIT_HINT_DISMISS_ERROR
    : QUIT_HINT_CLOSE;
}
