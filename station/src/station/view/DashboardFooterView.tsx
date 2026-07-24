import { useStore } from "zustand/react";
import type { StoreApi } from "zustand/vanilla";
import {
  activeTuiToast,
  dashboardFooterLabel,
  isTuiToastHiddenByScreen,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
  truncateCells,
  type TuiState,
  type TuiStore,
} from "@station/dashboard-core";
import { STATION_COLORS } from "./theme.js";

export type DashboardFooterViewProps = {
  store: StoreApi<TuiStore>;
  columns: number;
};

export function DashboardFooterView({ store, columns }: DashboardFooterViewProps) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const quitHint = useStore(store, selectFooterQuitHint);
  const contentColumns = Math.max(1, Math.floor(columns));
  const label =
    snapshot === undefined
      ? quitHint
      : dashboardFooterLabel({
          columns: contentColumns,
          quitHint,
          firstRun: snapshot.projects.length === 0,
        });

  return (
    <text fg={snapshot === undefined ? STATION_COLORS.gray : STATION_COLORS.foreground}>
      {truncateCells(label, contentColumns)}
    </text>
  );
}

function selectFooterQuitHint(state: Pick<TuiState, "screen" | "toasts">): string {
  const activeToast = activeTuiToast(state);
  return !isTuiToastHiddenByScreen(state.screen) && activeToast?.toast.kind === "error"
    ? QUIT_HINT_DISMISS_ERROR
    : QUIT_HINT_CLOSE;
}
