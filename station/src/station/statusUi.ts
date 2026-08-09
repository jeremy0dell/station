import type { AgentState } from "@station/contracts";
import type { FleetSummary } from "@station/dashboard-core/selectors";

export type ProjectRollupStatus = "needsYou" | "working" | "ready" | "idle";

type StatusUi = {
  label: string;
  glyph: string;
  tone: "danger" | "working" | "success" | "warning" | "neutral";
  animate: boolean;
  fleet: "always" | "nonzero" | "hidden";
  projectPriority: number | null;
};

type StatusTone = StatusUi["tone"];

const STATION_AGENT_STATUS_TONES = {
  needs_attention: "danger",
  stuck: "danger",
  working: "working",
  starting: "working",
  idle: "success",
  unknown: "warning",
  exited: "neutral",
  none: "neutral",
} as const satisfies Record<AgentState, StatusTone>;

const stationAgentStatusTones = new Map<string, StatusTone>(
  Object.entries(STATION_AGENT_STATUS_TONES),
);

export function stationAgentStatusTone(state: string | undefined): StatusTone {
  return state === undefined ? "neutral" : (stationAgentStatusTones.get(state) ?? "neutral");
}

// Declaration order is the fleet presentation order, including hidden lanes.
export const STATION_STATUS_UI = {
  ready: { label: "ready", glyph: "●", tone: "success", animate: false, fleet: "always", projectPriority: 1 },
  working: { label: "working", glyph: "⠿", tone: "working", animate: true, fleet: "always", projectPriority: 2 },
  needsYou: { label: "needs you", glyph: "!", tone: "danger", animate: false, fleet: "always", projectPriority: 3 },
  unknown: { label: "unknown", glyph: "?", tone: "warning", animate: false, fleet: "nonzero", projectPriority: null },
  exited: { label: "exited", glyph: "x", tone: "neutral", animate: false, fleet: "nonzero", projectPriority: null },
  idle: { label: "idle", glyph: "○", tone: "neutral", animate: false, fleet: "always", projectPriority: 0 },
  starting: { label: "starting", glyph: "+", tone: "neutral", animate: false, fleet: "hidden", projectPriority: null },
} as const satisfies Record<keyof FleetSummary, StatusUi>;

export const FLEET_STATUS_ORDER: readonly (keyof FleetSummary)[] = Object.keys(
  STATION_STATUS_UI,
) as (keyof FleetSummary)[];
