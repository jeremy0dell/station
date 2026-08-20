// Store-wired root for the STATION dashboard: subscribes to the view store,
// feeds the overlay's row budget into the viewport math, and switches
// between the loading/waiting/unavailable bodies and the live dashboard —
// mirroring apps/tui's App.tsx branch for the popup posture, including the
// toast overlay, kind-specific expiry timers, and explicit error dismissal.
import { useEffect, useRef } from "react";
import { useStore } from "zustand/react";
import type { DashboardActions, DashboardStateSource } from "@station/dashboard-core/runtime";
import {
  commandPromptRows,
  dashboardBodyTop,
  dashboardRowIds,
  selectDashboardViewport,
  snapshotLoadingLines,
} from "@station/dashboard-core/selectors";
import {
  activeTuiToast,
  isTuiToastHiddenByScreen,
  nextTuiToastExpiry,
  tuiScreenBehavior,
 } from "@station/dashboard-core/state";
import { ActiveScreenOverlayView } from "./ActiveScreenOverlayView.js";
import { CommandPromptView } from "./CommandPromptView.js";
import { DashboardFooterView } from "./DashboardFooterView.js";
import { DashboardView, Divider } from "./DashboardView.js";
import {
  StationHoverProvider,
  useStationHoverEnabled,
} from "./stationMouseContext.js";
import { ToastOverlayView } from "./ToastOverlayView.js";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";

export type DashboardRootProps = {
  state: DashboardStateSource;
  actions: Pick<
    DashboardActions,
    "expireToasts" | "refreshActiveToastExpiry" | "setTerminalRows"
  >;
  /** The overlay's content area, in terminal cells. */
  columns: number;
  rows: number;
  onCopyNotice: (text: string) => void;
};

export function DashboardRoot({ state, actions, columns, rows, onCopyNotice }: DashboardRootProps) {
  const theme = useStationTheme();
  const snapshot = useStore(state, (state) => state.snapshot);
  const loading = useStore(state, (state) => state.loading);
  const screen = useStore(state, (state) => state.screen);
  const persistentFilter = useStore(state, (state) => state.persistentFilter);
  const collapsedProjectIds = useStore(state, (state) => state.collapsedProjectIds);
  const collapsedGroupIds = useStore(state, (state) => state.collapsedGroupIds);
  const groupOrderingMode = useStore(state, (state) => state.groupOrderingMode);
  const groupHeaderActionVisibility = useStore(
    state,
    (state) => state.groupHeaderActionVisibility,
  );
  const scrollOffset = useStore(state, (state) => state.scrollOffset);
  const dashboardFocus = useStore(state, (state) => state.dashboardFocus);
  const selection = useStore(state, (state) => state.selection);
  const localRows = useStore(state, (state) => state.localRows);
  const liveWidgets = useStore(state, (state) => state.widgets);
  const widgetsPersisted = useStore(state, (state) => state.widgetsPersisted);
  const observerConnectionStatus = useStore(state, (state) => state.observerConnectionStatus);
  const activeToast = useStore(state, activeTuiToast);
  const nextExpiry = useStore(state, nextTuiToastExpiry);
  const hoverEnabled = useStationHoverEnabled();

  const toastHiddenByScreen = isTuiToastHiddenByScreen(screen);
  const backgroundHoverEnabled =
    hoverEnabled && tuiScreenBehavior(screen).dashboardHoverEnabled;
  const wasToastHiddenByScreen = useRef(toastHiddenByScreen);

  // The store's terminalRows feeds the keyboard scroll-clamping machinery;
  // rendering reads the prop directly so the first frame after the popup
  // opens never lays out against the store's stale value while this passive
  // effect catches up.
  useEffect(() => {
    actions.setTerminalRows(rows);
  }, [actions, rows]);
  useEffect(() => {
    const wasHidden = wasToastHiddenByScreen.current;
    wasToastHiddenByScreen.current = toastHiddenByScreen;
    if (wasHidden && !toastHiddenByScreen && activeToast !== undefined) {
      actions.refreshActiveToastExpiry(Date.now());
    }
  }, [actions, activeToast, toastHiddenByScreen]);
  useEffect(() => {
    if (nextExpiry === undefined || toastHiddenByScreen) {
      return;
    }
    const delay = Math.max(0, nextExpiry - Date.now());
    const timer = setTimeout(() => {
      actions.expireToasts(Date.now());
    }, delay);
    return () => clearTimeout(timer);
  }, [actions, nextExpiry, toastHiddenByScreen]);

  const contentColumns = Math.max(1, Math.floor(columns) - 1);
  const toastOverlay = (
    <ToastOverlayView
      columns={columns}
      rows={rows}
      toast={activeToast}
      promptRows={commandPromptRows(screen)}
      hiddenByScreen={toastHiddenByScreen}
      onCopyNotice={onCopyNotice}
    />
  );

  if (loading || snapshot === undefined) {
    // Keep both root branches padding-free because OpenTUI retains a removed inset during reconciliation.
    return (
      <box width="100%" flexGrow={1} flexDirection="column">
        <box flexDirection="column" flexGrow={1}>
          {snapshotLoadingLines(loading, observerConnectionStatus).map((line, index) => (
            <text
              key={`${index}:${line.text}`}
              fg={toOpenTuiColor(
                line.color === "gray" ? theme.text.muted : theme.text.primary,
              )}
            >
              {line.text}
            </text>
          ))}
        </box>
        <Divider columns={contentColumns} />
        <DashboardFooterView state={state} columns={contentColumns} />
        {toastOverlay}
      </box>
    );
  }

  const viewState = {
    collapsedProjectIds,
    collapsedGroupIds,
    groupOrderingMode,
    groupHeaderActionVisibility,
    scrollOffset,
    terminalRows: rows,
    localRows,
    selection,
    ...(persistentFilter === undefined ? {} : { persistentFilter }),
    ...(dashboardFocus === undefined ? {} : { dashboardFocus }),
  };
  const menuRowId =
    screen.name === "projectMenu"
      ? dashboardRowIds.project(screen.projectId)
      : screen.name === "groupMenu"
        ? dashboardRowIds.group(screen.groupId)
        : undefined;
  const menuAnchorTop =
    menuRowId === undefined
      ? undefined
      : dashboardBodyTop() +
        Math.max(
          0,
          selectDashboardViewport(snapshot, viewState, screen).rows.findIndex(
            (row) => row.id === menuRowId,
          ),
        );

  return (
    <box width="100%" flexGrow={1} flexDirection="column">
      <StationHoverProvider value={backgroundHoverEnabled}>
        <DashboardView
          snapshot={snapshot}
          viewState={viewState}
          screen={screen}
          columns={columns}
        />
        <DashboardFooterView state={state} columns={contentColumns} />
        <CommandPromptView screen={screen} />
        {toastOverlay}
      </StationHoverProvider>
      <ActiveScreenOverlayView
        snapshot={snapshot}
        screen={screen}
        selection={selection}
        columns={columns}
        rows={rows}
        localRows={localRows}
        widgets={liveWidgets}
        widgetsPersisted={widgetsPersisted}
        {...(menuAnchorTop === undefined ? {} : { menuAnchorTop })}
      />
    </box>
  );
}
