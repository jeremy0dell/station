import { toastOverlayLayout } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

describe("toast overlay layout", () => {
  it("caps the width at 52 columns on wide terminals and right-anchors", () => {
    const layout = toastOverlayLayout({ columns: 100, rows: 40, promptRows: 1, contentRows: 5 });
    expect(layout).toEqual({
      // columns >= 56 → right-anchored two cells from the edge.
      left: 46,
      // rows - (FOOTER 2 + promptRows 1 + GAP 1) - height 7.
      top: 29,
      width: 52,
      // contentRows + 2 frame rows.
      height: 7,
      contentWidth: 50,
    });
  });

  it("shrinks the width to the available columns on narrow terminals and centers", () => {
    const layout = toastOverlayLayout({ columns: 30, rows: 40, promptRows: 0, contentRows: 3 });
    // width = min(52, columns - 4) = 26; columns < 56 → centered.
    expect(layout?.width).toBe(26);
    expect(layout?.left).toBe(2);
    expect(layout?.contentWidth).toBe(24);
  });

  it("floors the width at 1 when columns are degenerate", () => {
    const layout = toastOverlayLayout({ columns: 1, rows: 40, promptRows: 0, contentRows: 1 });
    expect(layout?.width).toBe(1);
    expect(layout?.contentWidth).toBe(1);
  });

  it("returns undefined when the overlay cannot clear the minimum top row", () => {
    const layout = toastOverlayLayout({ columns: 100, rows: 5, promptRows: 0, contentRows: 5 });
    expect(layout).toBeUndefined();
  });
});
