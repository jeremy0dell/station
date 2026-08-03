import type { ColorInput } from "@opentui/core";
import { useStore } from "zustand/react";
import type { StoreApi } from "zustand/vanilla";
import {
  activeTuiToast,
  dashboardFooterModel,
  isTuiToastHiddenByScreen,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
  truncateCells,
  type DashboardFooterModel,
  type TuiState,
  type TuiStore,
} from "@station/dashboard-core";
import { toOpenTuiColor, useStationTheme, type StationTheme } from "../../theme/index.js";
import { DashboardFilterFooterView } from "./DashboardFilterFooterView.js";

export type DashboardFooterViewProps = {
  store: StoreApi<TuiStore>;
  columns: number;
};

export function DashboardFooterView({ store, columns }: DashboardFooterViewProps) {
  const theme = useStationTheme();
  const snapshot = useStore(store, (state) => state.snapshot);
  const screen = useStore(store, (state) => state.screen);
  const persistentFilter = useStore(store, (state) => state.persistentFilter);
  const quitHint = useStore(store, selectFooterQuitHint);
  const contentColumns = Math.max(1, Math.floor(columns));
  const model = dashboardFooterModel({
    columns: contentColumns,
    quitHint,
    hasSnapshot: snapshot !== undefined,
    firstRun: snapshot !== undefined && snapshot.projects.length === 0,
    screen,
    ...(persistentFilter === undefined ? {} : { persistentFilter }),
  });

  if (model.kind === "persistentFilterEditing" || model.kind === "persistentFilterApplied") {
    return (
      <DashboardFilterFooterView
        segments={model.segments}
        variant={model.kind === "persistentFilterEditing" ? "editing" : "applied"}
      />
    );
  }
  return (
    <text fg={dashboardFooterColor(theme, model)}>{truncateCells(model.text, contentColumns)}</text>
  );
}

function dashboardFooterColor(
  theme: StationTheme,
  model: Exclude<
    DashboardFooterModel,
    { kind: "persistentFilterEditing" | "persistentFilterApplied" }
  >,
): ColorInput {
  return toOpenTuiColor(model.kind === "loading" ? theme.text.muted : theme.text.primary);
}

function selectFooterQuitHint(state: Pick<TuiState, "screen" | "toasts">): string {
  const activeToast = activeTuiToast(state);
  return !isTuiToastHiddenByScreen(state.screen) && activeToast?.toast.kind === "error"
    ? QUIT_HINT_DISMISS_ERROR
    : QUIT_HINT_CLOSE;
}
