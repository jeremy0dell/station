import { join } from "node:path";

/**
 * Persist Station layout under state, not runtime, so it survives logout/reboot.
 * Override wins; otherwise use XDG_STATE_HOME, then HOME/.local/state.
 */
export function resolveStationLayoutPath(env: Record<string, string | undefined>): string {
  const override = env.STATION_LAYOUT_PATH;
  if (override !== undefined && override.length > 0) {
    return override;
  }

  const stateHome = env.XDG_STATE_HOME;
  if (stateHome !== undefined && stateHome.length > 0) {
    return join(stateHome, "station", "station", "layout.json");
  }

  const home = env.HOME;
  if (home === undefined || home.length === 0) {
    throw new Error(
      "Cannot resolve the Station layout path: set STATION_LAYOUT_PATH, XDG_STATE_HOME, or HOME.",
    );
  }

  return join(home, ".local", "state", "station", "station", "layout.json");
}
