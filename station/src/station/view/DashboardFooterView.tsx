import type { ColorInput } from "@opentui/core";
import { useStore } from "zustand/react";
import {
  activeTuiToast,
  dashboardFooterModel,
  isTuiToastHiddenByScreen,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
  truncateCells,
  type DashboardFooterModel,
  type DashboardStateSource,
  type DashboardStateView,
} from "@station/dashboard-core";
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

  if (model.kind === "persistentFilterEditing") {
    return <DashboardFilterFooterView segments={model.segments} />;
  }
  return (
    <text fg={dashboardFooterColor(theme, model)}>{truncateCells(model.text, contentColumns)}</text>
  );
}

function dashboardFooterColor(
  theme: StationTheme,
  model: Exclude<DashboardFooterModel, { kind: "persistentFilterEditing" }>,
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
