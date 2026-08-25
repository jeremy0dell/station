import { useTerminalDimensions } from "@opentui/react";
import type { MouseEvent } from "@opentui/core";
import { useCallback } from "react";
import { normalizeStationMouseEvent, type StationMouseEvent } from "../input/mouse.js";
import type { MouseTargetRef } from "../input/router.js";
import type { StationMouseTarget } from "./input/stationMouse.js";
import type { DashboardActions, DashboardStateSource } from "@station/dashboard-core/runtime";
import type { TopRowWidgetView } from "@station/dashboard-core/widgets";
import { DashboardFrameTitle } from "./view/DashboardFrameTitle.js";
import { DashboardRoot } from "./view/DashboardRoot.js";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../theme/index.js";
import { StationMouseProvider, type StationMouseDispatch } from "./view/stationMouseContext.js";
import type { DashboardScrollController } from "./view/layout/scrollViewport.js";

export type StationOverlayProps = {
  /** Read-only dashboard state owned by the renderer composition. */
  state: DashboardStateSource;
  /** Named dashboard effects required by the rendered surface. */
  actions: Pick<DashboardActions, "expireToasts" | "refreshActiveToastExpiry">;
  layout: DashboardScrollController;
  topRowWidgets?: readonly TopRowWidgetView[];
  /** The Station input runtime's mouse entry point. */
  dispatchMouse: (target: MouseTargetRef, event: StationMouseEvent) => boolean;
  onCopyNotice: (text: string) => void;
  widthPercent?: number | undefined;
  heightPercent?: number | undefined;
};

export type StationPopupLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const DEFAULT_POPUP_PERCENT = 60;
const MIN_POPUP_WIDTH = 60;
const MIN_POPUP_HEIGHT = 16;

/**
 * Renderer-boundary popup geometry, sized by config percentages and clamped to
 * its minimum presentation size and the terminal canvas.
 */
export function stationPopupLayout(
  terminalWidth: number,
  terminalHeight: number,
  options: { widthPercent?: number; heightPercent?: number } = {},
): StationPopupLayout {
  const availableWidth = Math.max(1, terminalWidth);
  const availableHeight = Math.max(1, terminalHeight);
  const widthFraction = (options.widthPercent ?? DEFAULT_POPUP_PERCENT) / 100;
  const heightFraction = (options.heightPercent ?? DEFAULT_POPUP_PERCENT) / 100;
  const width = Math.min(
    availableWidth,
    Math.max(MIN_POPUP_WIDTH, Math.round(availableWidth * widthFraction)),
  );
  const height = Math.min(
    availableHeight,
    Math.max(MIN_POPUP_HEIGHT, Math.round(availableHeight * heightFraction)),
  );
  return {
    left: Math.max(0, Math.floor((availableWidth - width) / 2)),
    top: Math.max(0, Math.floor((availableHeight - height) / 2)),
    width,
    height,
  };
}

/**
 * The backdrop owns outside mouse events (clicks/wheel never fall through to shell).
 */
export function StationOverlay({
  state,
  actions,
  layout: dashboardLayout,
  topRowWidgets = [],
  dispatchMouse,
  onCopyNotice,
  widthPercent,
  heightPercent,
}: StationOverlayProps) {
  const theme = useStationTheme();
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
    ...(widthPercent === undefined ? {} : { widthPercent }),
    ...(heightPercent === undefined ? {} : { heightPercent }),
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
        borderColor={toOpenTuiColor(theme.interaction.border)}
        backgroundColor={toOpenTuiOpaqueColor(theme.surfaces.panel)}
        flexDirection="column"
        onMouseDown={stopPopupMouse}
        onMouseScroll={stopPopupMouse}
      >
        <DashboardRoot
          state={state}
          actions={actions}
          layout={dashboardLayout}
          columns={innerColumns}
          rows={innerRows}
          onCopyNotice={onCopyNotice}
        />
      </box>
      <DashboardFrameTitle
        state={state}
        frame={{ left: layout.left, top: layout.top, width: layout.width }}
        topRowWidgets={topRowWidgets}
        zIndex={31}
      />
    </StationMouseProvider>
  );
}
