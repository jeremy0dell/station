import type { MouseEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { DashboardActions, DashboardStateSource } from "@station/dashboard-core/runtime";
import { useCallback } from "react";
import { useStore } from "zustand/react";
import { normalizeStationMouseEvent } from "../input/mouse.js";
import { useTopRowWidgets } from "../station/widgets/useTopRowWidgets.js";
import { DashboardFrameTitle } from "../station/view/DashboardFrameTitle.js";
import { DashboardRoot } from "../station/view/DashboardRoot.js";
import { toOpenTuiOpaqueColor, useStationTheme } from "../theme/index.js";
import {
  StationHoverProvider,
  StationMouseProvider,
  type StationMouseDispatch,
} from "../station/view/stationMouseContext.js";
import { routeDashboardMouse } from "./dashboardMouse.js";
import type { DashboardScrollController } from "../station/view/layout/scrollViewport.js";

type FullscreenDashboardInput = {
  state: DashboardStateSource;
  actions: Pick<
    DashboardActions,
    | "dismissToasts"
    | "dispatch"
    | "expireToasts"
    | "handleKey"
    | "pushToast"
    | "refreshActiveToastExpiry"
  >;
  layout: DashboardScrollController;
};

/**
 * The standalone dashboard, rendered to fill the terminal. This is the
 * fullscreen counterpart to Station's in-app `StationOverlay`: it drops the
 * backdrop, centering, and border so the same `DashboardRoot` owns the whole
 * screen (the CLI `tui`/`popup` surface that replaced the retired Ink UI).
 * The dashboard container's structural top inset hosts Station's title and
 * configured-widget border chrome.
 *
 * Mouse targets dispatch semantic dashboard actions; only URL presentation
 * remains a direct renderer callback.
 */
export type FullscreenDashboardProps = {
  runtime: FullscreenDashboardInput;
  openUrl: (url: string) => void;
  onCopyNotice: (text: string) => void;
  hoverEnabled?: boolean;
};

export function FullscreenDashboard({
  runtime,
  openUrl,
  onCopyNotice,
  hoverEnabled = true,
}: FullscreenDashboardProps) {
  const theme = useStationTheme();
  const { width, height } = useTerminalDimensions();
  const widgets = useStore(runtime.state, (state) => state.widgets);
  const topRowWidgets = useTopRowWidgets(widgets);
  const dispatch = useCallback<StationMouseDispatch>(
    (target, event: MouseEvent) => {
      routeDashboardMouse(target, normalizeStationMouseEvent(event), runtime, openUrl);
    },
    [openUrl, runtime],
  );
  return (
    <StationHoverProvider value={hoverEnabled}>
      <StationMouseProvider value={dispatch}>
        <box
          width={width}
          height={height}
          flexDirection="column"
          backgroundColor={toOpenTuiOpaqueColor(theme.surfaces.canvas)}
        >
          <DashboardRoot
            state={runtime.state}
            actions={runtime.actions}
            layout={runtime.layout}
            columns={width}
            rows={height}
            onCopyNotice={onCopyNotice}
          />
          <DashboardFrameTitle
            state={runtime.state}
            frame={{ left: 0, top: 0, width }}
            topRowWidgets={topRowWidgets}
            zIndex={1}
          />
        </box>
      </StationMouseProvider>
    </StationHoverProvider>
  );
}
