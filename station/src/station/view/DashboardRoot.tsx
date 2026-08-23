// Store-wired root for the STATION dashboard: subscribes to the view store and switches
// between the loading/waiting/unavailable bodies and the live dashboard —
// mirroring apps/tui's App.tsx branch for the popup posture, including the
// toast overlay, kind-specific expiry timers, and explicit error dismissal.
import { useEffect, useRef, type ReactNode } from "react";
import { useStore } from "zustand/react";
import type { DashboardActions, DashboardStateSource } from "@station/dashboard-core/runtime";
import { snapshotLoadingLines } from "@station/dashboard-core/selectors";
import {
  activeTuiToast,
  isTuiToastHiddenByScreen,
  nextTuiToastExpiry,
  tuiScreenBehavior,
 } from "@station/dashboard-core/state";
import { ActiveScreenOverlayView } from "./ActiveScreenOverlayView.js";
import { DashboardChromeView } from "./DashboardChromeView.js";
import { DashboardView } from "./DashboardView.js";
import {
  StationHoverProvider,
  useStationHoverEnabled,
} from "./stationMouseContext.js";
import { ToastOverlayView } from "./ToastOverlayView.js";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";
import type { DashboardScrollController } from "./layout/scrollViewport.js";

export type DashboardRootProps = {
  state: DashboardStateSource;
  actions: Pick<DashboardActions, "expireToasts" | "refreshActiveToastExpiry">;
  layout: DashboardScrollController;
  /** The overlay's content area, in terminal cells. */
  columns: number;
  rows: number;
  onCopyNotice: (text: string) => void;
};

export function DashboardRoot({
  state,
  actions,
  layout,
  columns,
  rows,
  onCopyNotice,
}: DashboardRootProps) {
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
      toast={activeToast}
      hiddenByScreen={toastHiddenByScreen}
      onCopyNotice={onCopyNotice}
    />
  );

  if (loading || snapshot === undefined) {
    // Keep both root branches padding-free because OpenTUI retains a removed inset during reconciliation.
    return (
      <box width="100%" flexGrow={1} minHeight={0} flexDirection="column">
        <StationHoverProvider value={backgroundHoverEnabled}>
          <DashboardNoticeRegion overlay={toastOverlay}>
            <box flexDirection="column" flexGrow={1} minHeight={0}>
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
          </DashboardNoticeRegion>
          <DashboardChromeView state={state} screen={screen} columns={contentColumns} />
        </StationHoverProvider>
      </box>
    );
  }

  const viewState = {
    collapsedProjectIds,
    collapsedGroupIds,
    groupOrderingMode,
    groupHeaderActionVisibility,
    localRows,
    selection,
    ...(persistentFilter === undefined ? {} : { persistentFilter }),
    ...(dashboardFocus === undefined ? {} : { dashboardFocus }),
  };
  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="column">
      <StationHoverProvider value={backgroundHoverEnabled}>
        <DashboardNoticeRegion overlay={toastOverlay}>
          <DashboardView
            snapshot={snapshot}
            viewState={viewState}
            screen={screen}
            layout={layout}
            columns={columns}
          />
        </DashboardNoticeRegion>
        <DashboardChromeView state={state} screen={screen} columns={contentColumns} />
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
      />
    </box>
  );
}

function DashboardNoticeRegion({
  children,
  overlay,
}: {
  children: ReactNode;
  overlay: ReactNode;
}) {
  return (
    <box
      id="station-dashboard-notice-region"
      width="100%"
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
      position="relative"
      overflow="hidden"
    >
      {children}
      {overlay}
    </box>
  );
}
