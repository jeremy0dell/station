import { dirname, join } from "node:path";
import { resolveStationObserverSocketPath } from "./stationSocketPath.js";

/**
 * Station host socket lives beside the observer socket unless explicitly
 * overridden. Boot dials it for warm reattach; failure falls back to cold shells.
 */
export function resolveStationHostSocketPath(env: Record<string, string | undefined>): string {
  const override = env.STATION_HOST_SOCKET_PATH;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(dirname(resolveStationObserverSocketPath(env)), "station-host.sock");
}
