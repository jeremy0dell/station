import { describe, expect, it } from "bun:test";
import { buildPaneForest, selectActivePaneTree, type PaneNode } from "./paneTree.js";
import type { PaneRecord } from "./types.js";

function record(
  id: string,
  split: PaneRecord["split"] = null,
): PaneRecord {
  return { id, split, role: "shell" };
}

function leaf(paneId: string): PaneNode {
  return { kind: "leaf", paneId };
}

describe("buildPaneForest", () => {
  it("returns an empty forest for an empty workspace", () => {
    expect(buildPaneForest([])).toEqual([]);
  });

  it("returns a lone leaf tree for a single pane", () => {
    expect(buildPaneForest([record("main")])).toEqual([leaf("main")]);
  });

  it("splits right into a row(anchor, new) within one tree", () => {
    const forest = buildPaneForest([
      record("main"),
      record("a", { anchorPaneId: "main", direction: "right" }),
    ]);
    expect(forest).toEqual([
      { kind: "split", orientation: "row", first: leaf("main"), second: leaf("a") },
    ]);
  });

  it("splits below into a column(anchor, new) within one tree", () => {
    const forest = buildPaneForest([
      record("main"),
      record("a", { anchorPaneId: "main", direction: "below" }),
    ]);
    expect(forest).toEqual([
      { kind: "split", orientation: "column", first: leaf("main"), second: leaf("a") },
    ]);
  });

  it("nests two distinct splits as row(main, column(a, b))", () => {
    const forest = buildPaneForest([
      record("main"),
      record("a", { anchorPaneId: "main", direction: "right" }),
      record("b", { anchorPaneId: "a", direction: "below" }),
    ]);
    expect(forest).toEqual([
      {
        kind: "split",
        orientation: "row",
        first: leaf("main"),
        second: { kind: "split", orientation: "column", first: leaf("a"), second: leaf("b") },
      },
    ]);
  });

  it("re-splitting the same anchor nests the newest split innermost", () => {
    const forest = buildPaneForest([
      record("main"),
      record("a", { anchorPaneId: "main", direction: "right" }),
      record("b", { anchorPaneId: "main", direction: "right" }),
    ]);
    expect(forest).toEqual([
      {
        kind: "split",
        orientation: "row",
        first: { kind: "split", orientation: "row", first: leaf("main"), second: leaf("b") },
        second: leaf("a"),
      },
    ]);
  });

  it("keeps each split:null pane as its own root — sessions are NOT merged", () => {
    // Two overlay-opened sessions (each `split: null`). The old single-tree fold
    // stacked these into one column; the forest keeps them as separate full-screen
    // session trees, which is what lets the renderer show one at a time.
    const forest = buildPaneForest([record("session-a"), record("session-b")]);
    expect(forest).toEqual([leaf("session-a"), leaf("session-b")]);
  });

  it("attaches a split to the root that owns its anchor, not the first root", () => {
    const forest = buildPaneForest([
      record("session-a"),
      record("session-b"),
      record("b-split", { anchorPaneId: "session-b", direction: "right" }),
    ]);
    expect(forest).toEqual([
      leaf("session-a"),
      { kind: "split", orientation: "row", first: leaf("session-b"), second: leaf("b-split") },
    ]);
  });

  it("is deterministic: identical records yield structurally equal forests", () => {
    const panes: PaneRecord[] = [
      record("main"),
      record("a", { anchorPaneId: "main", direction: "right" }),
      record("b", { anchorPaneId: "a", direction: "below" }),
    ];
    expect(buildPaneForest(panes)).toEqual(buildPaneForest([...panes]));
  });
});

describe("selectActivePaneTree", () => {
  it("returns null for an empty workspace", () => {
    expect(selectActivePaneTree([], null)).toBeNull();
  });

  it("returns the only session's tree for a single-session workspace", () => {
    const panes = [record("main"), record("a", { anchorPaneId: "main", direction: "right" })];
    expect(selectActivePaneTree(panes, "a")).toEqual({
      kind: "split",
      orientation: "row",
      first: leaf("main"),
      second: leaf("a"),
    });
  });

  it("returns the tree that contains the active pane, hiding the other session", () => {
    const panes = [record("session-a"), record("session-b")];
    expect(selectActivePaneTree(panes, "session-b")).toEqual(leaf("session-b"));
    expect(selectActivePaneTree(panes, "session-a")).toEqual(leaf("session-a"));
  });

  it("selects the active pane's session even when the active pane is a split leaf", () => {
    const panes = [
      record("session-a"),
      record("session-b"),
      record("b-split", { anchorPaneId: "session-b", direction: "below" }),
    ];
    // Active pane is the split inside session B → render session B's whole tree.
    expect(selectActivePaneTree(panes, "b-split")).toEqual({
      kind: "split",
      orientation: "column",
      first: leaf("session-b"),
      second: leaf("b-split"),
    });
  });

  it("falls back to the first session when there is no active pane or it is unknown", () => {
    const panes = [record("session-a"), record("session-b")];
    expect(selectActivePaneTree(panes, null)).toEqual(leaf("session-a"));
    expect(selectActivePaneTree(panes, "gone")).toEqual(leaf("session-a"));
  });
});
