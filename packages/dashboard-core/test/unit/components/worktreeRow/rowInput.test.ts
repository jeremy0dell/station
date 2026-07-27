import type { WorktreeRow } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { worktreeRowGridInput } from "../../../../src/components/WorktreeRow/rowInput.js";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

type AgentRow = WorktreeRow & { agent: NonNullable<WorktreeRow["agent"]> };

describe("worktree row startup readiness", () => {
  it("shows input-ready startup without creating unread completed output", () => {
    const idle = idleRow();
    const inputReady: WorktreeRow = {
      ...idle,
      agent: {
        ...idle.agent,
        inputReady: true,
      },
    };
    const turnReady: WorktreeRow = {
      ...idle,
      agent: {
        ...idle.agent,
        turnReadiness: {
          state: "ready_to_read",
          token: "report_completed",
          completedAt: "2026-05-20T12:00:00.000Z",
        },
      },
    };

    expect(renderedStatus(idle)).toEqual({ marker: "○", activity: "idle" });
    expect(renderedStatus(inputReady)).toEqual({ marker: "●", activity: "idle · ready" });
    expect(renderedStatus(inputReady, true)).toEqual({ marker: "●", activity: "idle · ready" });
    expect(renderedStatus(turnReady)).toEqual({ marker: "●", activity: "idle · ready" });
  });
});

function idleRow(): AgentRow {
  const row = createDashboardSnapshot().rows.find((candidate) => candidate.agent?.state === "idle");
  if (row?.agent === undefined) throw new Error("Dashboard fixture requires an idle agent row.");
  return row as AgentRow;
}

function renderedStatus(row: WorktreeRow, focused?: boolean): { marker: string; activity: string } {
  const input = worktreeRowGridInput(
    focused === undefined ? { row, slot: undefined } : { row, slot: undefined, focused },
  );
  const marker = input.cells.identity?.segments.find(
    (segment) => segment.kind === "text" && (segment.text === "○" || segment.text === "●"),
  );
  const activity = input.cells.activity?.segments[0];
  if (marker?.kind !== "text" || activity?.kind !== "text") {
    throw new Error("Expected text marker and activity segments.");
  }
  return { marker: marker.text, activity: activity.text };
}
