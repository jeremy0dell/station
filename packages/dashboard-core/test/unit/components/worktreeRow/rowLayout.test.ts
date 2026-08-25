import { describe, expect, it } from "vitest";
import type { RowGridLayout } from "../../../../src/components/WorktreeRow/layout.js";
import {
  layoutWorktreeRowGrid,
  segmentsWidth,
  withRowGridSelectionSlot,
} from "../../../../src/components/WorktreeRow/layout.js";
import { worktreeStyleRowGridInput } from "../../../../src/components/WorktreeRow/rowInput.js";

function rowText(layout: RowGridLayout): string {
  return layout.segments.map((segment) => (segment.kind === "text" ? segment.text : "·")).join("");
}

describe("worktree row layout and filter semantics", () => {
  it("decorates a renderer-visible slot without changing negotiated geometry", () => {
    for (const columns of [2, 3, 7, 40]) {
      const baseInput = worktreeStyleRowGridInput({
        id: `base-${columns}`,
        slot: undefined,
        marker: { kind: "text", text: "-" },
        title: "semantic-session",
      });
      const directInput = worktreeStyleRowGridInput({
        id: `direct-${columns}`,
        slot: "7",
        marker: { kind: "text", text: "-" },
        title: "semantic-session",
      });
      const [base] = layoutWorktreeRowGrid({ columns, rows: [baseInput] });
      const [direct] = layoutWorktreeRowGrid({ columns, rows: [directInput] });
      const decorated = withRowGridSelectionSlot(base, "7");

      expect(rowText(decorated)).toBe(rowText(direct));
      expect(segmentsWidth(decorated.segments)).toBe(segmentsWidth(base.segments));
    }
  });

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

  it("segments every visible matched field with semantic match backgrounds", () => {
    const [layout] = layoutWorktreeRowGrid({
      columns: 80,
      rows: [
        worktreeStyleRowGridInput({
          id: "matched",
          slot: "1",
          marker: { kind: "text", text: "●" },
          title: "alpha task",
          agent: "codex",
          activity: "working",
          textHighlights: {
            title: [{ start: 0, end: 5 }],
            agent: [{ start: 2, end: 5 }],
            activity: [{ start: 0, end: 4 }],
          },
        }),
      ],
    });

    expect(
      layout.segments
        .filter((segment) => segment.kind === "text" && segment.highlighted === true)
        .map((segment) => (segment.kind === "text" ? segment.text : "")),
    ).toEqual(["alpha", "dex", "work"]);
  });

  it("dims nonmatching preview rows semantically", () => {
    const input = worktreeStyleRowGridInput({
      id: "dimmed",
      slot: "2",
      marker: { kind: "text", text: "-" },
      title: "beta task",
      agent: "pi",
      activity: "idle",
      dimmed: true,
    });

    expect(
      Object.values(input.cells)
        .flatMap((cell) => cell?.segments ?? [])
        .filter((segment) => segment.kind === "text" && segment.text.trim().length > 0)
        .every((segment) => segment.dimmed === true),
    ).toBe(true);
  });

  it("preserves a Unicode title highlight while clipping by terminal cells", () => {
    const [layout] = layoutWorktreeRowGrid({
      columns: 12,
      rows: [
        worktreeStyleRowGridInput({
          id: "unicode",
          slot: "1",
          marker: { kind: "text", text: "-" },
          title: "修正-alpha",
          textHighlights: { title: [{ start: 0, end: 2 }] },
        }),
      ],
    });

    expect(segmentsWidth(layout.segments)).toBeLessThanOrEqual(12);
    expect(
      layout.segments.some(
        (segment) =>
          segment.kind === "text" && segment.text === "修正" && segment.highlighted === true,
      ),
    ).toBe(true);
  });
});
