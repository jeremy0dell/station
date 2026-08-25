import { describe, expect, it } from "bun:test";
import { helpPanelFrame } from "./helpPanelFrame.js";

describe("helpPanelFrame", () => {
  it("bounds a tall terminal to a stable preferred height", () => {
    expect(helpPanelFrame(120, 50)).toEqual({ width: "90%", height: 20 });
  });

  it("shrinks with short and degenerate terminals", () => {
    expect(helpPanelFrame(40, 12)).toEqual({ width: "90%", height: 12 });
    expect(helpPanelFrame(0, 0)).toEqual({ width: 1, height: 1 });
  });
});
