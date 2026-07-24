import { toastOverlayLayout } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

describe("toast overlay layout", () => {
  it("caps the width at 72 columns and reserves footer and prompt rows", () => {
    const layout = toastOverlayLayout({ columns: 100, rows: 40, promptRows: 1 });
    expect(layout).toEqual({
      left: 26,
      bottom: 4,
      width: 72,
      maxHeight: 33,
      contentWidth: 70,
    });
  });

  it("keeps four outer columns of breathing room on narrow terminals", () => {
    const layout = toastOverlayLayout({ columns: 30, rows: 40, promptRows: 0 });
    expect(layout?.width).toBe(26);
    expect(layout?.left).toBe(2);
    expect(layout?.bottom).toBe(3);
    expect(layout?.maxHeight).toBe(34);
    expect(layout?.contentWidth).toBe(24);
  });

  it("floors the width at 1 when columns are degenerate", () => {
    const layout = toastOverlayLayout({ columns: 1, rows: 40, promptRows: 0 });
    expect(layout?.width).toBe(1);
    expect(layout?.contentWidth).toBe(1);
  });

  it("returns undefined when no framed notice can clear the minimum top row", () => {
    const layout = toastOverlayLayout({ columns: 100, rows: 8, promptRows: 0 });
    expect(layout).toBeUndefined();
  });

  it("gives a 99x25 notice room to grow upward without covering the footer", () => {
    expect(toastOverlayLayout({ columns: 99, rows: 25, promptRows: 0 })).toEqual({
      left: 25,
      bottom: 3,
      width: 72,
      maxHeight: 19,
      contentWidth: 70,
    });
  });
});
