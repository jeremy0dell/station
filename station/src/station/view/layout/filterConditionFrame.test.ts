import { describe, expect, it } from "bun:test";
import { filterConditionFrame } from "./filterConditionFrame.js";

describe("filter condition render-boundary frame", () => {
  it("uses terminal-cell width for intrinsic labels and stays viewport-bounded", () => {
    expect(filterConditionFrame(80, ["Project", "Agent"]).width).toBe(34);
    expect(filterConditionFrame(20, ["Project"]).width).toBe(18);
    expect(filterConditionFrame(80, ["界".repeat(20)])).toEqual({ width: 52, innerWidth: 50 });
  });
});
