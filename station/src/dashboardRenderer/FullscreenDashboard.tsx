import type { MouseEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { DashboardRuntime } from "@station/dashboard-core";
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
import type { DashboardRendererEffects } from "./dashboardEffects.js";
import { routeDashboardMouse } from "./dashboardMouse.js";

type DashboardInput = Pick<DashboardRuntime, "state" | "actions">;

/**
 * The standalone dashboard, rendered to fill the terminal. This is the
 * fullscreen counterpart to Station's in-app `StationOverlay`: it drops the
 * backdrop, centering, and border so the same `DashboardRoot` owns the whole
 * screen (the CLI `tui`/`popup` surface that replaced the retired Ink UI).
 * The reserved first row reuses Station's title and configured-widget chrome.
 *
 * Mouse targets route through the standalone dashboard adapter, which reuses
 * shared dashboard actions and delegates terminal effects to its environment.
 */
export type FullscreenDashboardProps = {
  runtime: DashboardInput;
  effects: DashboardRendererEffects;
  onCopyNotice: (text: string) => void;
  hoverEnabled?: boolean;
};

export function FullscreenDashboard({
  runtime,
  effects,
  onCopyNotice,
  hoverEnabled = true,
}: FullscreenDashboardProps) {
  const theme = useStationTheme();
  const { width, height } = useTerminalDimensions();
  const widgets = useStore(runtime.state, (state) => state.widgets);
  const topRowWidgets = useTopRowWidgets(widgets);
  const dispatch = useCallback<StationMouseDispatch>(
    (target, event: MouseEvent) => {
      routeDashboardMouse(target, normalizeStationMouseEvent(event), runtime, effects);
    },
    [effects, runtime],
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
