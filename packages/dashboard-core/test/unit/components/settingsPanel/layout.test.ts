import { describe, expect, it } from "vitest";
import { settingsPanelLayout } from "../../../../src/components/SettingsPanel/layout.js";

describe("shared settings panel layout", () => {
  it("caps and centers on a wide terminal", () => {
    expect(settingsPanelLayout(120, 40)).toEqual({
      width: 88,
      height: 20,
      left: 16,
      top: 10,
      innerWidth: 86,
      contentHeight: 16,
      leftWidth: 26,
      rightWidth: 59,
    });
  });

  it("uses the viewport at minimum size without clipping the frame", () => {
    const layout = settingsPanelLayout(40, 10);
    expect(layout).toMatchObject({ width: 40, height: 10, left: 0, top: 0 });
  });

  it("sizes the left column by ratio between its min and max", () => {
    expect(settingsPanelLayout(70, 30).leftWidth).toBe(24);
  });

  it("keeps the two columns plus a gap spanning the inner width", () => {
    for (const [columns, rows] of [
      [120, 40],
      [70, 30],
      [40, 10],
    ] as const) {
      const layout = settingsPanelLayout(columns, rows);
      expect(layout.leftWidth + 1 + layout.rightWidth).toBe(layout.innerWidth);
    }
  });
});
