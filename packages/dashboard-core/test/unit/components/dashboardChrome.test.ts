import { describe, expect, it } from "vitest";
import {
  type DashboardFooterModel,
  dashboardFooterModel,
  dashboardTableHeaderModel,
} from "../../../src/components/Dashboard/content.js";
import type { RowGridLayout } from "../../../src/components/WorktreeRow/layout.js";
import { QUIT_HINT_CLOSE, QUIT_HINT_DISMISS_ERROR } from "../../../src/state/keymap.js";

const HEADER_LAYOUT: RowGridLayout = {
  id: "header",
  segments: [],
  hidden: { cells: [], metadata: [] },
};
const NO_OVERFLOW = { above: 0, below: 0, visible: 4, total: 4 };

function footer(
  options: Partial<{
    columns: number;
    quitHint: string;
    hasSnapshot: boolean;
    firstRun: boolean;
  }> = {},
): DashboardFooterModel {
  return dashboardFooterModel({
    columns: options.columns ?? 120,
    quitHint: options.quitHint ?? QUIT_HINT_CLOSE,
    hasSnapshot: options.hasSnapshot ?? true,
    firstRun: options.firstRun ?? false,
  });
}

describe("dashboard table header model", () => {
  it("gives above overflow precedence over the available column layout", () => {
    const overflow = { ...NO_OVERFLOW, above: 2, total: 6 };

    expect(dashboardTableHeaderModel({ layout: HEADER_LAYOUT, overflow })).toEqual({
      kind: "aboveOverflow",
      overflow,
    });
  });

  it("uses column headers when the viewport is at the top", () => {
    expect(dashboardTableHeaderModel({ layout: HEADER_LAYOUT, overflow: NO_OVERFLOW })).toEqual({
      kind: "columns",
      layout: HEADER_LAYOUT,
    });
  });

  it("uses one empty header row when no layout exists", () => {
    expect(dashboardTableHeaderModel({ layout: undefined, overflow: NO_OVERFLOW })).toEqual({
      kind: "empty",
    });
  });
});

describe("dashboard footer model", () => {
  it("shows only the quit hint while the snapshot is unavailable", () => {
    expect(footer({ hasSnapshot: false })).toEqual({
      kind: "loading",
      text: QUIT_HINT_CLOSE,
    });
  });

  it("preserves the ready dashboard footer", () => {
    expect(footer()).toEqual({
      kind: "dashboard",
      text: "↵ activate  N new  A add  ⇥ next-needs-me  / search  X delete  ? help  Q/esc:close",
    });
  });

  it("preserves the first-run footer", () => {
    expect(footer({ firstRun: true })).toEqual({
      kind: "dashboard",
      text: "↵ add first project  A add project  Q/esc:close",
    });
  });

  it("preserves compact and error quit-hint behavior", () => {
    expect(footer({ columns: 40 })).toEqual({
      kind: "dashboard",
      text: "↵ activate  N new  ⇥ next  / search  X delete  ? help  Q/esc:close",
    });
    expect(footer({ columns: 40, quitHint: QUIT_HINT_DISMISS_ERROR })).toEqual({
      kind: "dashboard",
      text: QUIT_HINT_DISMISS_ERROR,
    });
    expect(footer({ columns: 40, quitHint: QUIT_HINT_DISMISS_ERROR, firstRun: true })).toEqual({
      kind: "dashboard",
      text: QUIT_HINT_DISMISS_ERROR,
    });
  });
});
