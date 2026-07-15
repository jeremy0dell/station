import type { StationSnapshot } from "@station/contracts";
import { isReadyToRead } from "../components/WorktreeRow/rowInput.js";
import { selectDashboardSessionRows } from "./selectors.js";

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

export function selectFleetSummary(snapshot: StationSnapshot): FleetSummary {
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
    if (state === "needs_attention" || state === "stuck") {
      summary.needsYou += 1;
    } else if (state === "working") {
      summary.working += 1;
    } else if (isReadyToRead(row.presentation)) {
      summary.ready += 1;
    } else if (state === "idle") {
      summary.idle += 1;
    } else if (state === "starting") {
      summary.starting += 1;
    } else if (state === "exited") {
      summary.exited += 1;
    } else if (state === "unknown") {
      summary.unknown += 1;
    }
    // A retained session with no agent is not a fleet-status lane.
  }
  return summary;
}
