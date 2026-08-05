import type { StationMouseEvent } from "../input/mouse.js";
import {
  routeStationMouse,
  type DashboardMouseRuntime,
  type StationMouseTarget,
} from "../station/input/stationMouse.js";

/**
 * Adapt the shared dashboard pointer router to standalone URL presentation.
 * All state transitions and capability dispatch remain identical to native Station.
 */
export function routeDashboardMouse(
  target: StationMouseTarget,
  event: StationMouseEvent,
  runtime: DashboardMouseRuntime,
  openUrl: (url: string) => void,
): void {
  const outcome = routeStationMouse(target, event, runtime);
  if (outcome.kind === "open-url") {
    openUrl(outcome.url);
  }
}
