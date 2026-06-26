import {
  layoutWorktreeRowGrid,
  type RowGridLayout,
  segmentsWidth,
  worktreeStyleRowGridInput,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

function rowText(layout: RowGridLayout): string {
  return layout.segments.map((segment) => (segment.kind === "text" ? segment.text : "·")).join("");
}

describe("worktree row layout permissiveness", () => {
  it("stretches the status to the row end instead of truncating while space remains", () => {
    const status = "Cursor turn ended after running the full test suite";
    const [layout] = layoutWorktreeRowGrid({
      columns: 120,
      rows: [
        worktreeStyleRowGridInput({
          id: "r1",
          slot: "5",
          marker: { kind: "text", text: "!" },
          title: "cursor-task",
          agent: "cursor",
          activity: status,
          activityImportance: "meaningful",
          activityOverflow: "rowSlack",
        }),
      ],
    });
    const text = rowText(layout);
    expect(text).toContain(status);
    expect(text).not.toContain("…");
  });

  it("shows longer branch names before truncating", () => {
    // 37 chars — would have been cut at the previous 32-cell title cap.
    const title = "codex/provider-hook-readiness-readout";
    const [layout] = layoutWorktreeRowGrid({
      columns: 120,
      rows: [
        worktreeStyleRowGridInput({
          id: "r2",
          slot: "4",
          marker: { kind: "text", text: "-" },
          title,
          agent: "-",
          activity: "no agent",
          activityOverflow: "rowSlack",
        }),
      ],
    });
    const text = rowText(layout);
    expect(text).toContain(title);
    expect(text).not.toContain("…");
  });

  it("still fits within a narrow terminal", () => {
    const [layout] = layoutWorktreeRowGrid({
      columns: 40,
      rows: [
        worktreeStyleRowGridInput({
          id: "r3",
          slot: "1",
          marker: { kind: "text", text: "-" },
          title: "some-fairly-long-branch-name",
          agent: "codex",
          activity: "working",
          activityOverflow: "rowSlack",
        }),
      ],
    });
    expect(layout).toBeDefined();
    expect(segmentsWidth(layout.segments)).toBeLessThanOrEqual(40);
  });
});
