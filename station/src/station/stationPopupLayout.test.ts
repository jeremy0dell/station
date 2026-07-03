import { describe, expect, it } from "bun:test";
import { stationPopupLayout } from "./StationOverlay.js";

describe("stationPopupLayout", () => {
  it("centers a half-size popup below the header on a large terminal", () => {
    const layout = stationPopupLayout(200, 61);
    expect(layout).toEqual({ left: 50, top: 16, width: 100, height: 30 });
  });

  it("uses configured width and height percentages", () => {
    const layout = stationPopupLayout(200, 61, { widthPercent: 60, heightPercent: 60 });
    expect(layout).toEqual({ left: 40, top: 13, width: 120, height: 36 });
  });

  it("clamps to the minimum size the dashboard needs", () => {
    const layout = stationPopupLayout(100, 30);
    expect(layout.width).toBe(60);
    expect(layout.height).toBe(16);
    expect(layout.left).toBe(20);
    expect(layout.top).toBe(1 + Math.floor((29 - 16) / 2));
  });

  it("never exceeds the available area on tiny terminals", () => {
    const layout = stationPopupLayout(40, 12);
    expect(layout.width).toBe(40);
    expect(layout.height).toBe(11);
    expect(layout.left).toBe(0);
    expect(layout.top).toBe(1);
  });
});
