import { describe, expect, it } from "bun:test";
import { stationPopupLayout } from "./StationOverlay.js";

describe("stationPopupLayout", () => {
  it("centers a 60 percent popup in the complete terminal canvas", () => {
    const layout = stationPopupLayout(200, 61);
    expect(layout).toEqual({ left: 40, top: 12, width: 120, height: 37 });
  });

  it("can still size from explicit percentages", () => {
    const layout = stationPopupLayout(200, 61, { widthPercent: 50, heightPercent: 50 });
    expect(layout).toEqual({ left: 50, top: 15, width: 100, height: 31 });
  });

  it("clamps to the minimum size the dashboard needs", () => {
    const layout = stationPopupLayout(100, 30);
    expect(layout.width).toBe(60);
    expect(layout.height).toBe(18);
    expect(layout.left).toBe(20);
    expect(layout.top).toBe(Math.floor((30 - 18) / 2));
  });

  it("never exceeds the available area on tiny terminals", () => {
    const layout = stationPopupLayout(40, 12);
    expect(layout.width).toBe(40);
    expect(layout.height).toBe(12);
    expect(layout.left).toBe(0);
    expect(layout.top).toBe(0);
  });

  it("lets a configured full-height popup use the complete canvas", () => {
    expect(stationPopupLayout(40, 12, { heightPercent: 100 })).toEqual({
      left: 0,
      top: 0,
      width: 40,
      height: 12,
    });
  });
});
