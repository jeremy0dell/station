import { describe, expect, it } from "vitest";
import {
  type DashboardFooterModel,
  dashboardFooterModel,
} from "../../../src/components/Dashboard/footer.js";
import { cellWidth } from "../../../src/components/WorktreeRow/layout.js";
import { QUIT_HINT_CLOSE, QUIT_HINT_DISMISS_ERROR } from "../../../src/state/keymap.js";
import type { DashboardPersistentFilter, TuiScreen } from "../../../src/state/types.js";

const FILTER_SCREEN: TuiScreen = {
  name: "persistentFilter",
  draft: { value: "alpha", cursor: 5 },
};

function footer(
  options: Partial<{
    columns: number;
    quitHint: string;
    hasSnapshot: boolean;
    firstRun: boolean;
    screen: TuiScreen;
    persistentFilter: DashboardPersistentFilter;
  }> = {},
): DashboardFooterModel {
  const input: Parameters<typeof dashboardFooterModel>[0] = {
    columns: options.columns ?? 120,
    quitHint: options.quitHint ?? QUIT_HINT_CLOSE,
    hasSnapshot: options.hasSnapshot ?? true,
    firstRun: options.firstRun ?? false,
  };
  if (options.screen !== undefined) {
    input.screen = options.screen;
  }
  if (options.persistentFilter !== undefined) {
    input.persistentFilter = options.persistentFilter;
  }
  return dashboardFooterModel(input);
}

function editingFooterText(model: DashboardFooterModel): string {
  if (model.kind !== "persistentFilterEditing") {
    throw new Error("Expected a persistent filter editing footer.");
  }
  return model.segments.map((segment) => segment.text).join("");
}

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

describe("dashboard persistent filter footer", () => {
  it("selects bounded full and compact editing help", () => {
    const fullText = editingFooterText(footer({ columns: 80, screen: FILTER_SCREEN }));
    const compactText = editingFooterText(footer({ columns: 32, screen: FILTER_SCREEN }));

    expect(fullText).toContain("FILTER");
    expect(fullText).toContain("←→ cursor");
    expect(fullText).toContain("Ctrl-U clear");
    expect(compactText).toContain("↵ apply");
    expect(cellWidth(compactText)).toBeLessThanOrEqual(32);
  });

  it("keeps applied-filter controls visible while shedding lower-priority help", () => {
    const at60 = footer({ columns: 60, persistentFilter: { query: "alpha" } });
    const at40 = footer({ columns: 40, persistentFilter: { query: "alpha" } });
    const at20 = footer({ columns: 20, persistentFilter: { query: "alpha" } });

    expect(at60).toEqual({
      kind: "persistentFilterApplied",
      text: "/ edit  Esc clear  ↵ activate  N new  Q:close",
    });
    expect(at40).toEqual({
      kind: "persistentFilterApplied",
      text: "/ edit  Esc clear  Q:close",
    });
    expect(at20).toEqual({
      kind: "persistentFilterApplied",
      text: "/ edit Esc clear Q",
    });
    for (const [width, model] of [
      [60, at60],
      [40, at40],
      [20, at20],
    ] as const) {
      if (model.kind !== "persistentFilterApplied") throw new Error("expected applied filter");
      expect(cellWidth(model.text)).toBeLessThanOrEqual(width);
      expect(model.text).toContain("/ edit");
      expect(model.text).toContain("Esc clear");
      expect(model.text).toMatch(/Q(?::close)?$/);
    }
  });
});
