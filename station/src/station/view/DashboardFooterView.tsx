import { useStore } from "zustand/react";
import type { DashboardStateSource } from "@station/dashboard-core/runtime";
import { dashboardFooterModel } from "@station/dashboard-core/selectors";
import {
  activeTuiToast,
  isTuiToastHiddenByScreen,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
} from "@station/dashboard-core/state";
import type { DashboardStateView } from "@station/dashboard-core/state";
import { DashboardCommandFooterView } from "./DashboardCommandFooterView.js";
import { DashboardFilterFooterView } from "./DashboardFilterFooterView.js";
import { DashboardLoadingFooterView } from "./DashboardLoadingFooterView.js";
import { DashboardRegularFooterView } from "./DashboardRegularFooterView.js";

export type DashboardFooterViewProps = {
  state: DashboardStateSource;
  columns: number;
};

export function DashboardFooterView({ state, columns }: DashboardFooterViewProps) {
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

  switch (model.kind) {
    case "loading":
      return <DashboardLoadingFooterView model={model} columns={contentColumns} />;
    case "regular":
      return <DashboardRegularFooterView model={model} columns={contentColumns} />;
    case "filter":
      return <DashboardFilterFooterView model={model} />;
    case "command":
      return <DashboardCommandFooterView model={model} columns={contentColumns} />;
  }
}

function selectFooterQuitHint(
  state: Pick<DashboardStateView, "screen" | "toasts">,
): string {
  const activeToast = activeTuiToast(state);
  return !isTuiToastHiddenByScreen(state.screen) && activeToast?.toast.kind === "error"
    ? QUIT_HINT_DISMISS_ERROR
    : QUIT_HINT_CLOSE;
}
