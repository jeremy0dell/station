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
import { DashboardFilterFooterView } from "./DashboardFilterFooterView.js";
import { STATION_COLORS } from "./theme.js";

export type DashboardFooterViewProps = {
  store: StoreApi<TuiStore>;
  columns: number;
};

export function DashboardFooterView({ store, columns }: DashboardFooterViewProps) {
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

  return renderDashboardFooter(model, contentColumns);
}

function renderDashboardFooter(model: DashboardFooterModel, columns: number) {
  if (model.kind === "persistentFilterEditing") {
    return <DashboardFilterFooterView segments={model.segments} />;
  }
  const foreground = model.kind === "loading" ? STATION_COLORS.gray : STATION_COLORS.foreground;
  return <text fg={foreground}>{truncateCells(model.text, columns)}</text>;
}

function selectFooterQuitHint(state: Pick<TuiState, "screen" | "toasts">): string {
  const activeToast = activeTuiToast(state);
  return !isTuiToastHiddenByScreen(state.screen) && activeToast?.toast.kind === "error"
    ? QUIT_HINT_DISMISS_ERROR
    : QUIT_HINT_CLOSE;
}
