// Store-wired root for the STATION dashboard: subscribes to the view store,
// feeds the overlay's row budget into the viewport math, and switches
// between the loading/waiting/unavailable bodies and the live dashboard —
// mirroring apps/tui's App.tsx branch for the popup posture, including the
// toast overlay and its expiry timers.
import { useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useStore } from "zustand/react";
import {
  commandPromptRows,
  isModalOverlayActive,
  observerHeaderStatusForConnection,
  snapshotLoadingLines,
} from "@station/dashboard-core";
import type { TopRowWidgetText, TuiStore } from "@station/dashboard-core";
import { activeTuiToast, nextTuiToastExpiry, QUIT_HINT_CLOSE } from "@station/dashboard-core";
import { CommandPromptView } from "./CommandPromptView.js";
import { DashboardHeaderRow, DashboardView, Divider } from "./DashboardView.js";
import { OverlayHostView } from "./OverlayHostView.js";
import { ToastOverlayView } from "./ToastOverlayView.js";
import { STATION_COLORS } from "./theme.js";

const QUIT_HINT = QUIT_HINT_CLOSE;

export type DashboardRootProps = {
  store: StoreApi<TuiStore>;
  /** The overlay's content area, in terminal cells. */
  columns: number;
  rows: number;
  topRowWidgets?: readonly TopRowWidgetText[];
};

export function DashboardRoot({ store, columns, rows, topRowWidgets = [] }: DashboardRootProps) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const loading = useStore(store, (state) => state.loading);
  const screen = useStore(store, (state) => state.screen);
  const searchQuery = useStore(store, (state) => state.searchQuery);
  const collapsedProjectIds = useStore(store, (state) => state.collapsedProjectIds);
  const scrollOffset = useStore(store, (state) => state.scrollOffset);
  const localRows = useStore(store, (state) => state.localRows);
  const observerConnectionStatus = useStore(store, (state) => state.observerConnectionStatus);
  const activeToast = useStore(store, activeTuiToast);
  const nextExpiry = useStore(store, nextTuiToastExpiry);

  const toastHiddenByModal = isModalOverlayActive(screen);
  const wasToastHiddenByModal = useRef(toastHiddenByModal);

  // The store's terminalRows feeds the keyboard scroll-clamping machinery;
  // rendering reads the prop directly so the first frame after the popup
  // opens never lays out against the store's stale value while this passive
  // effect catches up.
  useEffect(() => {
    store.getState().setTerminalRows(rows);
  }, [rows, store]);
  useEffect(() => {
    const wasHidden = wasToastHiddenByModal.current;
    wasToastHiddenByModal.current = toastHiddenByModal;
    if (wasHidden && !toastHiddenByModal && activeToast !== undefined) {
      store.getState().refreshActiveToastExpiry(Date.now());
    }
  }, [activeToast, store, toastHiddenByModal]);
  useEffect(() => {
    if (nextExpiry === undefined || toastHiddenByModal) {
      return;
    }
    const delay = Math.max(0, nextExpiry - Date.now());
    const timer = setTimeout(() => {
      store.getState().expireToasts(Date.now());
    }, delay);
    return () => clearTimeout(timer);
  }, [nextExpiry, store, toastHiddenByModal]);

  const contentColumns = Math.max(1, Math.floor(columns) - 1);
  const toastOverlay = (
    <ToastOverlayView
      columns={columns}
      rows={rows}
      toast={activeToast}
      promptRows={commandPromptRows(screen)}
      hiddenByModal={toastHiddenByModal}
    />
  );

  if (loading || snapshot === undefined) {
    return (
      <box width="100%" flexGrow={1} flexDirection="column" paddingRight={1}>
        <DashboardHeaderRow columns={contentColumns} widgets={topRowWidgets} />
        <Divider columns={contentColumns} />
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
        <text fg={STATION_COLORS.gray}>{QUIT_HINT}</text>
        {toastOverlay}
      </box>
    );
  }

  const observerStatus = observerHeaderStatusForConnection(observerConnectionStatus, true);
  return (
    <box width="100%" flexGrow={1} flexDirection="column">
      <DashboardView
        snapshot={snapshot}
        viewState={{ searchQuery, collapsedProjectIds, scrollOffset, terminalRows: rows, localRows }}
        columns={columns}
        topRowWidgets={topRowWidgets}
        {...(observerStatus === undefined ? {} : { observerStatus })}
      />
      <CommandPromptView screen={screen} />
      {toastOverlay}
      <OverlayHostView
        snapshot={snapshot}
        screen={screen}
        columns={columns}
        rows={rows}
        localRows={localRows}
      />
    </box>
  );
}
