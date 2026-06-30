import { describe, expect, it } from "bun:test";
import { nextSplitSeqFromPanes } from "./paneEffects.js";

describe("nextSplitSeqFromPanes", () => {
  it("returns one past the highest pane-split-N", () => {
    expect(
      nextSplitSeqFromPanes([
        { id: "pane-main" },
        { id: "pane-split-2" },
        { id: "pane-split-9" },
        { id: "pane-wt-x" },
      ]),
    ).toBe(10);
  });

  it("returns 0 when there are no split panes", () => {
    expect(nextSplitSeqFromPanes([{ id: "pane-main" }, { id: "pane-agent-wt-1" }])).toBe(0);
  });

  it("ignores non-numeric split suffixes", () => {
    expect(nextSplitSeqFromPanes([{ id: "pane-split-abc" }, { id: "pane-split-3" }])).toBe(4);
  });
});
