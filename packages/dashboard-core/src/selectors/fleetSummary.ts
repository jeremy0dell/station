import type { AgentState } from "@station/contracts";
import type { DashboardSnapshotView } from "../state/types.js";
import { isReadyToRead } from "./agentStatus.js";
import { selectDashboardSessionRows } from "./dashboardSessionRows.js";

// Fleet triage counts derived client-side: the observer's snapshot.counts carry
// only working/idle/attention/unknown and fold "ready" into idle, so the fleet
// bar computes the full disjoint breakdown from canonical sessions. "needsYou" = attention
// OR stuck (snapshot.counts.attention deliberately excludes stuck).
export type FleetSummary = {
  ready: number;
  working: number;
  needsYou: number;
  idle: number;
  starting: number;
  exited: number;
  unknown: number;
};

const FLEET_LANE_FOR_AGENT_STATE: Record<AgentState, keyof FleetSummary | undefined> = {
  needs_attention: "needsYou",
  stuck: "needsYou",
  working: "working",
  starting: "starting",
  idle: "idle",
  unknown: "unknown",
  exited: "exited",
  none: undefined,
};

export function selectFleetSummary(snapshot: DashboardSnapshotView): FleetSummary {
  const summary: FleetSummary = {
    ready: 0,
    working: 0,
    needsYou: 0,
    idle: 0,
    starting: 0,
    exited: 0,
    unknown: 0,
  };
  for (const row of selectDashboardSessionRows(snapshot)) {
    const state = row.session.status.value;
    const lane = isReadyToRead(row.presentation) ? "ready" : FLEET_LANE_FOR_AGENT_STATE[state];
    if (lane !== undefined) summary[lane] += 1;
  }
  return summary;
}
