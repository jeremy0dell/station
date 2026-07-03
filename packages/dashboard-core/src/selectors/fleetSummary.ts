import type { StationSnapshot } from "@station/contracts";
import { isReadyToRead } from "../components/WorktreeRow/rowInput.js";

// Fleet triage counts derived client-side: the observer's snapshot.counts carry
// only working/idle/attention/unknown and fold "ready" into idle, so the fleet
// bar computes the full disjoint breakdown from the rows. "needsYou" = attention
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
  for (const row of snapshot.rows) {
    const state = row.agent?.state;
    if (state === "needs_attention" || state === "stuck") {
      summary.needsYou += 1;
    } else if (state === "working") {
      summary.working += 1;
    } else if (isReadyToRead(row)) {
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
    // No agent (state === undefined) is a session without a harness — not a
    // fleet-status lane, so it is intentionally uncounted.
  }
  return summary;
}
