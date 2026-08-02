import { TextAttributes } from "@opentui/core";
import { useStore } from "zustand/react";
import type { StoreApi } from "zustand/vanilla";
import {
  activeTuiToast,
  dashboardFooterModel,
  isTuiToastHiddenByScreen,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
  truncateCells,
  type DashboardFilterFooterSegment,
  type DashboardFooterModel,
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
  switch (model.kind) {
    case "loading":
      return <text fg={STATION_COLORS.gray}>{truncateCells(model.text, columns)}</text>;
    case "dashboard":
    case "persistentFilterApplied":
      return <text fg={STATION_COLORS.foreground}>{truncateCells(model.text, columns)}</text>;
    case "persistentFilterEditing":
      return (
        <box height={1} width="100%" backgroundColor={STATION_COLORS.filterEditorSurface}>
          <text width="100%">
            {model.segments.map((segment, index) => (
              <span
                key={`${segment.role}:${index}`}
                fg={footerSegmentForeground(segment)}
                {...(segment.role === "badge" ? { bg: STATION_COLORS.filterEditorRail } : {})}
                attributes={
                  segment.role === "badge" || segment.role === "key"
                    ? TextAttributes.BOLD
                    : TextAttributes.NONE
                }
              >
                {segment.text}
              </span>
            ))}
          </text>
        </box>
      );
    default:
      return assertNeverDashboardFooterModel(model);
  }
}

function footerSegmentForeground(segment: DashboardFilterFooterSegment): string {
  if (segment.role === "badge") return STATION_COLORS.background;
  if (segment.role === "key") return STATION_COLORS.foreground;
  return STATION_COLORS.gray;
}

function assertNeverDashboardFooterModel(_model: never): never {
  throw new Error("Unhandled dashboard footer model.");
}

function selectFooterQuitHint(state: Pick<TuiState, "screen" | "toasts">): string {
  const activeToast = activeTuiToast(state);
  return !isTuiToastHiddenByScreen(state.screen) && activeToast?.toast.kind === "error"
    ? QUIT_HINT_DISMISS_ERROR
    : QUIT_HINT_CLOSE;
}
