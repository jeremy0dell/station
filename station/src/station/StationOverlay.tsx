import { useTerminalDimensions } from "@opentui/react";
import type { MouseEvent } from "@opentui/core";
import { useCallback } from "react";
import type { StoreApi } from "zustand/vanilla";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import type { StationMouseTarget } from "./input/stationMouse.js";
import type { TopRowWidgetText, TuiStore } from "@station/dashboard-core";
import { DashboardRoot } from "./view/DashboardRoot.js";
import { STATION_COLORS } from "./view/theme.js";
import { StationMouseProvider, type StationMouseDispatch } from "./view/stationMouseContext.js";

export type StationOverlayProps = {
  /** Owned by main.tsx (HMR recreates store + renderer + handlers together). */
  store: StoreApi<TuiStore>;
  topRowWidgets?: readonly TopRowWidgetText[];
  overlayWidthPercent?: number;
  overlayHeightPercent?: number;
  /** The Station input runtime's mouse entry point. */
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
};

export type StationPopupLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const DEFAULT_POPUP_PERCENT = 50;
const MIN_POPUP_WIDTH = 60;
const MIN_POPUP_HEIGHT = 16;
/**
 * One reserved row at the very top. Originally the header lived here; the
 * header is now the floating DynamicStationButton (zero layout), so this is a
 * thin top margin that keeps the popup off the top edge (and clear of the
 * collapsed button in the corner).
 */
const HEADER_ROWS = 1;

/**
 * Centered popup, clamped to the 60x16 minimum the
 * dashboard's row solver and help panel need (and to small-terminal area).
 */
export function stationPopupLayout(
  terminalWidth: number,
  terminalHeight: number,
  options: { widthPercent?: number | undefined; heightPercent?: number | undefined } = {},
): StationPopupLayout {
  const availableWidth = Math.max(1, terminalWidth);
  const availableHeight = Math.max(1, terminalHeight - HEADER_ROWS);
  const widthPercent = options.widthPercent ?? DEFAULT_POPUP_PERCENT;
  const heightPercent = options.heightPercent ?? DEFAULT_POPUP_PERCENT;
  const width = Math.min(
    availableWidth,
    Math.max(MIN_POPUP_WIDTH, Math.round((availableWidth * widthPercent) / 100)),
  );
  const height = Math.min(
    availableHeight,
    Math.max(MIN_POPUP_HEIGHT, Math.round((availableHeight * heightPercent) / 100)),
  );
  return {
    left: Math.max(0, Math.floor((availableWidth - width) / 2)),
    top: HEADER_ROWS + Math.max(0, Math.floor((availableHeight - height) / 2)),
    width,
    height,
  };
}

/**
 * The backdrop owns outside mouse events (clicks/wheel never fall through to shell).
 */
export function StationOverlay({
  store,
  topRowWidgets = [],
  overlayWidthPercent,
  overlayHeightPercent,
  dispatchMouse,
}: StationOverlayProps) {
  const { width, height } = useTerminalDimensions();
  const dispatch = useCallback<StationMouseDispatch>(
    (target: StationMouseTarget, event) => {
      dispatchMouse({ kind: "station", target }, normalizeStationMouseEvent(event));
    },
    [dispatchMouse],
  );
  const dispatchBackdrop = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      dispatchMouse({ kind: "stationBackdrop" }, normalizeStationMouseEvent(event));
    },
    [dispatchMouse],
  );
  const stopPopupMouse = useCallback((event: MouseEvent) => {
    event.stopPropagation();
  }, []);
  const layout = stationPopupLayout(width, height, {
    widthPercent: overlayWidthPercent,
    heightPercent: overlayHeightPercent,
  });
  // The border eats one cell per side; the dashboard fills the interior.
  const innerColumns = Math.max(1, layout.width - 2);
  const innerRows = Math.max(1, layout.height - 2);
  return (
    <StationMouseProvider value={dispatch}>
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        zIndex={29}
        onMouseDown={dispatchBackdrop}
        onMouseScroll={dispatchBackdrop}
      />
      <box
        position="absolute"
        left={layout.left}
        top={layout.top}
        width={layout.width}
        height={layout.height}
        zIndex={30}
        border
        borderColor={STATION_COLORS.gray}
        backgroundColor={STATION_COLORS.background}
        flexDirection="column"
        onMouseDown={stopPopupMouse}
        onMouseScroll={stopPopupMouse}
      >
        <DashboardRoot
          store={store}
          columns={innerColumns}
          rows={innerRows}
          topRowWidgets={topRowWidgets}
        />
      </box>
    </StationMouseProvider>
  );
}
