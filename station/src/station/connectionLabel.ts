import type { StationClientConnectionState } from "@station/client";
import { STATION_COLORS } from "./view/theme.js";

export type StationConnectionPresentation = {
  label: string;
  color: string;
};

const CONNECTED_COLOR = STATION_COLORS.state.success;
const WAITING_COLOR = STATION_COLORS.state.warning;
const HALTED_COLOR = STATION_COLORS.state.danger;
const IDLE_COLOR = STATION_COLORS.gray;

/**
 * Calm, static status copy: no spinners and no per-second timers. Failure
 * states surface the safe error message; downtime is shown as the clock time
 * the state was entered so the line never churns while disconnected.
 */
export function presentConnection(
  connection: StationClientConnectionState,
): StationConnectionPresentation {
  switch (connection.state) {
    case "idle":
      return { label: "idle", color: IDLE_COLOR };
    case "loading":
      return { label: "connecting to observer", color: WAITING_COLOR };
    case "connected":
      return { label: "live", color: CONNECTED_COLOR };
    case "reconnecting":
      return {
        label: `reconnecting since ${sinceLabel(connection.since)}`,
        color: WAITING_COLOR,
      };
    case "displayOnly":
      return {
        label: `display-only since ${sinceLabel(connection.since)} (last good snapshot shown)`,
        color: WAITING_COLOR,
      };
    case "halted":
      return {
        label: `halted: ${connection.lastError.message}`,
        color: HALTED_COLOR,
      };
  }
}

function sinceLabel(sinceMs: number): string {
  return new Date(sinceMs).toLocaleTimeString();
}
