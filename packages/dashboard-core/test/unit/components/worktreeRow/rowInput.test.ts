import type { AgentState, WorktreeRow } from "@station/contracts";
import { describe, expect, it } from "vitest";
import type { RowColor, RowMarker } from "../../../../src/components/WorktreeRow/layout.js";
import { worktreeRowGridInput } from "../../../../src/components/WorktreeRow/rowInput.js";
import { fixtureNow, row } from "../../../fixtures/snapshots.js";

const EXPECTED_VISUALS: Record<AgentState, { marker: RowMarker; tone: RowColor }> = {
  needs_attention: { marker: { kind: "text", text: "!" }, tone: "red" },
  stuck: { marker: { kind: "text", text: "!" }, tone: "red" },
  working: { marker: { kind: "throbber", variant: "braille" }, tone: "blue" },
  starting: { marker: { kind: "text", text: "+" }, tone: "gray" },
  idle: { marker: { kind: "text", text: "○" }, tone: "gray" },
  unknown: { marker: { kind: "text", text: "?" }, tone: "yellow" },
  exited: { marker: { kind: "text", text: "x" }, tone: "gray" },
  none: { marker: { kind: "text", text: "-" }, tone: "gray" },
};

describe("worktree row agent visuals", () => {
  it("pins the marker and tone for every agent state", () => {
    for (const [state, expected] of Object.entries(EXPECTED_VISUALS) as [
      AgentState,
      { marker: RowMarker; tone: RowColor },
    ][]) {
      const candidate = fixtureRow(state);
      const input = worktreeRowGridInput({ row: candidate, slot: "1" });
      const markerColor = expected.tone === "gray" ? {} : { color: expected.tone };
      expect(input.cells.identity?.segments[2]).toEqual(
        expected.marker.kind === "throbber"
          ? { ...expected.marker, ...markerColor }
          : { kind: "text", text: expected.marker.text, ...markerColor },
      );
      expect(input.cells.activity?.segments[0]?.color).toBe(expected.tone);
    }
  });

  it("uses the ready visual only for an idle agent", () => {
    const idle = readyRow("idle");
    const working = readyRow("working");
    const idleInput = worktreeRowGridInput({ row: idle, slot: "1" });
    const workingInput = worktreeRowGridInput({ row: working, slot: "1" });

    expect(idleInput.cells.identity?.segments[2]).toEqual({
      kind: "text",
      text: "●",
      color: "green",
    });
    expect(idleInput.cells.activity?.segments[0]?.color).toBe("green");
    expect(workingInput.cells.identity?.segments[2]).toEqual({
      kind: "throbber",
      variant: "braille",
      color: "blue",
    });
  });
});

function fixtureRow(state: AgentState): WorktreeRow {
  return row({
    id: `wt_${state}`,
    projectId: "web",
    branch: state,
    state,
  });
}

function readyRow(state: "idle" | "working"): WorktreeRow {
  const candidate = fixtureRow(state);
  if (candidate.agent === undefined) throw new Error("missing visual fixture agent");
  candidate.agent.turnReadiness = {
    state: "ready_to_read",
    token: "ready-token",
    completedAt: fixtureNow,
  };
  return candidate;
}
