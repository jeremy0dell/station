// Store-wired root for the STATION dashboard: subscribes to the view store,
// feeds the overlay's row budget into the viewport math, and switches
// between the loading/waiting/unavailable bodies and the live dashboard —
// mirroring apps/tui's App.tsx branch for the popup posture, including the
// toast overlay, transient expiry timers, and persistent error dismissal.
import { useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useStore } from "zustand/react";
import {
  commandPromptRows,
  isTuiToastHiddenByScreen,
  snapshotLoadingLines,
} from "@station/dashboard-core";
import type { TuiStore } from "@station/dashboard-core";
import {
  activeTuiToast,
  nextTuiToastExpiry,
  QUIT_HINT_CLOSE,
  QUIT_HINT_DISMISS_ERROR,
} from "@station/dashboard-core";
import { CommandPromptView } from "./CommandPromptView.js";
import { DashboardView, Divider } from "./DashboardView.js";
import { OverlayHostView } from "./OverlayHostView.js";
import { ToastOverlayView } from "./ToastOverlayView.js";
import { STATION_COLORS } from "./theme.js";

export type DashboardRootProps = {
  store: StoreApi<TuiStore>;
  /** The overlay's content area, in terminal cells. */
  columns: number;
  rows: number;
};

export function DashboardRoot({ store, columns, rows }: DashboardRootProps) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const loading = useStore(store, (state) => state.loading);
  const screen = useStore(store, (state) => state.screen);
  const searchQuery = useStore(store, (state) => state.searchQuery);
  const collapsedProjectIds = useStore(store, (state) => state.collapsedProjectIds);
  const scrollOffset = useStore(store, (state) => state.scrollOffset);
  const focusedRowId = useStore(store, (state) => state.focusedRowId);
  const selection = useStore(store, (state) => state.selection);
  const localRows = useStore(store, (state) => state.localRows);
  const liveWidgets = useStore(store, (state) => state.widgets);
  const widgetsPersisted = useStore(store, (state) => state.widgetsPersisted);
  const observerConnectionStatus = useStore(store, (state) => state.observerConnectionStatus);
  const activeToast = useStore(store, activeTuiToast);
  const nextExpiry = useStore(store, nextTuiToastExpiry);

  const toastHiddenByScreen = isTuiToastHiddenByScreen(screen);
  const wasToastHiddenByScreen = useRef(toastHiddenByScreen);

  // The store's terminalRows feeds the keyboard scroll-clamping machinery;
  // rendering reads the prop directly so the first frame after the popup
  // opens never lays out against the store's stale value while this passive
  // effect catches up.
  useEffect(() => {
    store.getState().setTerminalRows(rows);
  }, [rows, store]);
  useEffect(() => {
    const wasHidden = wasToastHiddenByScreen.current;
    wasToastHiddenByScreen.current = toastHiddenByScreen;
    if (wasHidden && !toastHiddenByScreen && activeToast !== undefined) {
      store.getState().refreshActiveToastExpiry(Date.now());
    }
  }, [activeToast, store, toastHiddenByScreen]);
  useEffect(() => {
    if (nextExpiry === undefined || toastHiddenByScreen) {
      return;
    }
    const delay = Math.max(0, nextExpiry - Date.now());
    const timer = setTimeout(() => {
      store.getState().expireToasts(Date.now());
    }, delay);
    return () => clearTimeout(timer);
  }, [nextExpiry, store, toastHiddenByScreen]);

  const contentColumns = Math.max(1, Math.floor(columns) - 1);
  const footerQuitHint =
    !toastHiddenByScreen && activeToast?.toast.kind === "error"
      ? QUIT_HINT_DISMISS_ERROR
      : QUIT_HINT_CLOSE;
  const toastOverlay = (
    <ToastOverlayView
      columns={columns}
      rows={rows}
      toast={activeToast}
      promptRows={commandPromptRows(screen)}
      hiddenByScreen={toastHiddenByScreen}
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
              fg={line.color === "gray" ? STATION_COLORS.gray : STATION_COLORS.foreground}
            >
              {line.text}
            </text>
          ))}
        </box>
        <Divider columns={contentColumns} />
        <text fg={STATION_COLORS.gray}>{footerQuitHint}</text>
        {toastOverlay}
      </box>
    );
  }

  return (
    <box width="100%" flexGrow={1} flexDirection="column">
      <DashboardView
        snapshot={snapshot}
        viewState={{
          searchQuery,
          collapsedProjectIds,
          scrollOffset,
          terminalRows: rows,
          localRows,
          selection,
          ...(focusedRowId === undefined ? {} : { focusedRowId }),
        }}
        columns={columns}
        footerQuitHint={footerQuitHint}
      />
      <CommandPromptView screen={screen} />
      {toastOverlay}
      <OverlayHostView
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
