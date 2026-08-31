import { describe, expect, it } from "bun:test";
import { helpPanelFrame } from "./helpPanelFrame.js";

describe("helpPanelFrame", () => {
  it("bounds a tall terminal to a stable preferred height", () => {
    expect(helpPanelFrame(120, 50)).toEqual({
      width: "90%",
      height: 20,
      overlayWidth: 120,
      overlayHeight: 50,
      effectiveWidth: 64,
    });
  });

  it("shrinks with short and degenerate terminals", () => {
    expect(helpPanelFrame(40, 12)).toEqual({
      width: "90%",
      height: 12,
      overlayWidth: 40,
      overlayHeight: 12,
      effectiveWidth: 36,
    });
    expect(helpPanelFrame(0, 0)).toEqual({
      width: 1,
      height: 1,
      overlayWidth: 1,
      overlayHeight: 1,
      effectiveWidth: 1,
    });
  });

  it("uses the capped rendered width for continuation policy", () => {
    expect(helpPanelFrame(52, 12).effectiveWidth).toBe(46);
  });
});
