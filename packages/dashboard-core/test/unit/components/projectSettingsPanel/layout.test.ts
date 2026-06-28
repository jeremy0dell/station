import { projectSettingsPanelLayout } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

describe("project settings panel layout", () => {
  it("caps and centers on a wide terminal", () => {
    const layout = projectSettingsPanelLayout(120, 40);
    expect(layout).toEqual({
      // width capped at MAX_PANEL_WIDTH, height at MAX_PANEL_HEIGHT.
      width: 88,
      height: 20,
      left: 16,
      top: 10,
      innerWidth: 86,
      // height 20 - border(2) - title(1) - footer(1).
      contentHeight: 16,
      // ratio 0.4 of 86 = 34 → clamped to LEFT_COLUMN_MAX.
      leftWidth: 26,
      rightWidth: 59,
    });
  });

  it("floors at the minimum size and never goes off-screen on a tiny terminal", () => {
    const layout = projectSettingsPanelLayout(40, 10);
    expect(layout.width).toBe(46);
    expect(layout.height).toBe(11);
    // Centering offsets would be negative here; both floor at 0.
    expect(layout.left).toBe(0);
    expect(layout.top).toBe(0);
  });

  it("sizes the left column by ratio between its min and max", () => {
    const layout = projectSettingsPanelLayout(70, 30);
    // ratio 0.4 of innerWidth 62 = 24, inside [16, 26].
    expect(layout.leftWidth).toBe(24);
  });

  it("keeps the two columns plus a gap spanning the inner width", () => {
    for (const [columns, rows] of [
      [120, 40],
      [70, 30],
      [40, 10],
    ] as const) {
      const layout = projectSettingsPanelLayout(columns, rows);
      expect(layout.leftWidth + 1 + layout.rightWidth).toBe(layout.innerWidth);
    }
  });
});
