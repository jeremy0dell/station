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
  draftConditions: [],
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
  if (model.kind !== "persistentFilterEditing" && model.kind !== "persistentFilterCondition") {
    throw new Error("Expected a persistent filter mode footer.");
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
      text: "↵ activate  N new  M move to group  A add  ⇥ next-needs-me  / filter  X delete  ? help  Q/esc:close",
    });
  });

  it("preserves the first-run footer", () => {
    expect(footer({ firstRun: true })).toEqual({
      kind: "dashboard",
      text: "↵ add first project  A add project  Q/esc:close",
    });
  });

  it("replaces ordinary help with the active dashboard or command-target prompt", () => {
    expect(footer({ screen: { name: "dashboard", shortcutCodeInput: "11" } })).toEqual({
      kind: "dashboard",
      text: "` 11▌  Enter invoke  Backspace edit  Esc cancel",
    });
    expect(footer({ columns: 32, screen: { name: "dashboard", shortcutCodeInput: "10" } })).toEqual(
      {
        kind: "dashboard",
        text: "` 10▌  ↵ invoke  Esc cancel",
      },
    );
    expect(
      footer({ screen: { name: "removeWorktree", step: "chooseSlot", shortcutCodeInput: "11" } }),
    ).toEqual({
      kind: "dashboard",
      text: "` 11▌  Enter invoke  Backspace edit  Esc cancel",
    });
  });

  it("preserves compact and error quit-hint behavior", () => {
    expect(footer({ columns: 40 })).toEqual({
      kind: "dashboard",
      text: "↵ activate  N new  ⇥ next  / filter  X delete  ? help  Q/esc:close",
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

  it("uses a distinct bounded CONDITION mode footer for both nested stages", () => {
    const fieldText = editingFooterText(
      footer({
        columns: 80,
        screen: {
          ...FILTER_SCREEN,
          conditionEditor: { stage: "field", cursor: 0 },
        },
      }),
    );
    const valueModel = footer({
      columns: 80,
      screen: {
        ...FILTER_SCREEN,
        conditionEditor: {
          stage: "values",
          field: "status",
          cursor: 0,
          options: [{ id: "working", label: "Working" }],
          selectedIds: [],
        },
      },
    });
    if (valueModel.kind !== "persistentFilterCondition") {
      throw new Error("expected condition footer");
    }
    const valueText = valueModel.segments.map((segment) => segment.text).join("");

    expect(fieldText).toContain("CONDITION");
    expect(fieldText).toContain("S/P/A edit");
    expect(fieldText).toContain("F apply filter");
    expect(fieldText).toContain("Esc text");
    expect(valueText).toContain("CONDITION");
    expect(valueText).toContain("← fields");
    expect(valueText).toContain("Space/slot toggle");
    expect(valueText).toContain("Enter done");
    expect(valueText).toContain("Esc close");
    expect(valueText).not.toContain("commit");
    expect(cellWidth(valueText)).toBeLessThanOrEqual(80);
  });

  it("keeps typed applied-filter controls visible while shedding lower-priority help", () => {
    const at60 = footer({ columns: 60, persistentFilter: { query: "alpha" } });
    const at40 = footer({ columns: 40, persistentFilter: { query: "alpha" } });
    const at20 = footer({ columns: 20, persistentFilter: { query: "alpha" } });

    const cases = [
      [60, at60, "/ edit  Esc clear  ↵ activate  N new  Q:close"],
      [40, at40, "/ edit  Esc clear  Q:close"],
      [20, at20, "/ edit Esc clear Q"],
    ] as const;
    for (const [width, model, expectedText] of cases) {
      if (model.kind !== "persistentFilterApplied") throw new Error("expected applied filter");
      const text = model.segments.map((segment) => segment.text).join("");
      expect(text).toBe(expectedText);
      expect(cellWidth(text)).toBeLessThanOrEqual(width);
      expect(model.segments.filter((segment) => segment.action)).toMatchObject([
        { action: "persistentFilter.edit" },
        { action: "persistentFilter.clear" },
      ]);
    }
  });
});
