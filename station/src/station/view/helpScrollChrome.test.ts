import { describe, expect, it } from "bun:test";
import { helpScrollChrome } from "./helpScrollChrome.js";

const allIds = ["one", "two", "three", "four", "five"] as const;

describe("help scroll chrome", () => {
  it("formats the expanded label for a middle visible window", () => {
    expect(
      helpScrollChrome({
        allIds,
        visibleIds: ["two", "three"],
        panelWidth: 64,
      }),
    ).toBe("↑ 1 above · ↓ 2 below");
  });

  it("formats top and bottom expanded labels", () => {
    expect(helpScrollChrome({ allIds, visibleIds: ["one"], panelWidth: 48 })).toBe(
      "↓ 4 below",
    );
    expect(helpScrollChrome({ allIds, visibleIds: ["five"], panelWidth: 48 })).toBe(
      "↑ 4 above",
    );
  });

  it("formats compact labels using the effective panel width", () => {
    expect(
      helpScrollChrome({
        allIds,
        visibleIds: ["two", "three"],
        panelWidth: 46,
      }),
    ).toBe("↑1/↓2");
    expect(helpScrollChrome({ allIds, visibleIds: undefined, panelWidth: 46 })).toBe("all");
  });
});
