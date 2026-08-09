import type { AgentState, StationSnapshot } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { type FleetSummary, selectFleetSummary } from "../../../src/selectors/fleetSummary.js";
import { createDashboardSnapshot, fixtureNow } from "../../fixtures/snapshots.js";

const EMPTY_SUMMARY: FleetSummary = {
  ready: 0,
  working: 0,
  needsYou: 0,
  idle: 0,
  starting: 0,
  exited: 0,
  unknown: 0,
};

const EXPECTED_LANES: Record<AgentState, keyof FleetSummary | undefined> = {
  needs_attention: "needsYou",
  stuck: "needsYou",
  working: "working",
  starting: "starting",
  idle: "idle",
  unknown: "unknown",
  exited: "exited",
  none: undefined,
};

describe("selectFleetSummary", () => {
  it("classifies every agent state into a disjoint fleet lane", () => {
    for (const [state, lane] of Object.entries(EXPECTED_LANES) as [
      AgentState,
      keyof FleetSummary | undefined,
    ][]) {
      const expected = { ...EMPTY_SUMMARY };
      if (lane !== undefined) expected[lane] = 1;
      expect(selectFleetSummary(snapshotForState(state))).toEqual(expected);
    }
  });

  it("uses ready-to-read only as an idle override", () => {
    expect(selectFleetSummary(snapshotForState("idle", true))).toEqual({
      ...EMPTY_SUMMARY,
      ready: 1,
    });
    expect(selectFleetSummary(snapshotForState("working", true))).toEqual({
      ...EMPTY_SUMMARY,
      working: 1,
    });
  });
});

function snapshotForState(state: AgentState, ready = false): StationSnapshot {
  const base = createDashboardSnapshot();
  const sourceRow = base.rows[0];
  const sourceSession = base.sessions[0];
  if (sourceRow?.agent === undefined || sourceSession === undefined) {
    throw new Error("missing fleet fixture session");
  }
  const agent = { ...sourceRow.agent, state };
  if (ready) {
    agent.turnReadiness = {
      state: "ready_to_read",
      token: "ready-token",
      completedAt: fixtureNow,
    };
  }
  return {
    ...base,
    rows: [{ ...sourceRow, agent }],
    sessions: [
      {
        ...sourceSession,
        status: { ...sourceSession.status, value: state },
      },
    ],
  };
}
