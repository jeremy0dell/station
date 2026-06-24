import { describe, expect, it } from "bun:test";
import {
  buildLayoutSnapshot,
  isLayoutTopologyValid,
  parseLayoutSnapshot,
  STATION_LAYOUT_SCHEMA_VERSION,
  type StationLayoutSnapshot,
} from "./layoutSnapshot.js";
import type { PaneId, WorkspaceSlice } from "../types.js";

function workspace(): WorkspaceSlice {
  return {
    panes: [
      { id: "pane-main", split: null, role: "shell" },
      { id: "pane-split-0", split: { anchorPaneId: "pane-main", direction: "right" }, role: "shell" },
      {
        id: "pane-split-1",
        split: { anchorPaneId: "pane-split-0", direction: "below" },
        role: "shell",
      },
    ],
    activePaneId: "pane-split-1",
  };
}

describe("buildLayoutSnapshot", () => {
  it("captures records, active pane, and only the panes that have a cwd", () => {
    const cwd: Record<string, string> = {
      "pane-main": "/work/root",
      "pane-split-0": "/work/root/sub",
      // pane-split-1 intentionally has none.
    };
    const snapshot = buildLayoutSnapshot(workspace(), (id) => cwd[id]);

    expect(snapshot.schemaVersion).toBe(STATION_LAYOUT_SCHEMA_VERSION);
    expect(snapshot.activePaneId).toBe("pane-split-1");
    expect(snapshot.panes.map((p) => p.id)).toEqual(["pane-main", "pane-split-0", "pane-split-1"]);
    expect(snapshot.panes[1]?.split).toEqual({ anchorPaneId: "pane-main", direction: "right" });
    expect(snapshot.cwdByPane).toEqual({ "pane-main": "/work/root", "pane-split-0": "/work/root/sub" });
  });

  it("round-trips through parse without loss", () => {
    const snapshot = buildLayoutSnapshot(workspace(), () => "/x");
    const json = JSON.stringify(snapshot);
    const parsed = parseLayoutSnapshot(JSON.parse(json));
    expect(parsed).toEqual(snapshot);
  });
});

describe("parseLayoutSnapshot", () => {
  it("rejects a wrong schema version", () => {
    const doc = { ...buildLayoutSnapshot(workspace(), () => "/x"), schemaVersion: 2 };
    expect(parseLayoutSnapshot(doc)).toBeUndefined();
  });

  it("rejects unknown top-level keys (strict)", () => {
    const doc = { ...buildLayoutSnapshot(workspace(), () => "/x"), extra: true };
    expect(parseLayoutSnapshot(doc)).toBeUndefined();
  });

  it("rejects an invalid split direction", () => {
    const doc = buildLayoutSnapshot(workspace(), () => "/x");
    const broken = {
      ...doc,
      panes: doc.panes.map((p, i) =>
        i === 1 ? { ...p, split: { anchorPaneId: "pane-main", direction: "sideways" } } : p,
      ),
    };
    expect(parseLayoutSnapshot(broken)).toBeUndefined();
  });

  it("tolerates the reserved ratio/terminalTargetId fields", () => {
    const doc = buildLayoutSnapshot(workspace(), () => "/x");
    const withReserved = {
      ...doc,
      panes: doc.panes.map((p, i) =>
        i === 0
          ? { ...p, terminalTargetId: "aux:x" }
          : i === 1
            ? { ...p, split: { ...p.split, ratio: 0.5 } }
            : p,
      ),
    };
    expect(parseLayoutSnapshot(withReserved)).not.toBeUndefined();
  });

  it("returns undefined for non-objects", () => {
    expect(parseLayoutSnapshot(null)).toBeUndefined();
    expect(parseLayoutSnapshot("nope")).toBeUndefined();
    expect(parseLayoutSnapshot([])).toBeUndefined();
  });

  it("rejects a non-string or empty cwd entry", () => {
    const doc = buildLayoutSnapshot(workspace(), () => "/x");
    expect(parseLayoutSnapshot({ ...doc, cwdByPane: { "pane-main": 123 } })).toBeUndefined();
    expect(parseLayoutSnapshot({ ...doc, cwdByPane: { "pane-main": "" } })).toBeUndefined();
  });
});

describe("isLayoutTopologyValid", () => {
  const valid = (): StationLayoutSnapshot => buildLayoutSnapshot(workspace(), () => "/x");

  it("accepts a well-ordered layout", () => {
    expect(isLayoutTopologyValid(valid())).toBe(true);
  });

  it("rejects an empty layout", () => {
    expect(isLayoutTopologyValid({ ...valid(), panes: [], activePaneId: null })).toBe(false);
  });

  it("rejects a split anchored to a later pane (forward ref)", () => {
    const doc = valid();
    const reordered: StationLayoutSnapshot = {
      ...doc,
      // split-0 anchors to split-1 which comes after it.
      panes: [
        doc.panes[0]!,
        { id: "pane-split-0", split: { anchorPaneId: "pane-split-1", direction: "right" }, role: "shell" },
        { id: "pane-split-1", split: { anchorPaneId: "pane-main", direction: "below" }, role: "shell" },
      ],
    };
    expect(isLayoutTopologyValid(reordered)).toBe(false);
  });

  it("rejects a dangling anchor", () => {
    const doc = valid();
    const dangling: StationLayoutSnapshot = {
      ...doc,
      panes: [doc.panes[0]!, { id: "pane-x", split: { anchorPaneId: "ghost", direction: "right" }, role: "shell" }],
      activePaneId: "pane-main",
    };
    expect(isLayoutTopologyValid(dangling)).toBe(false);
  });

  it("rejects a duplicate pane id", () => {
    const doc = valid();
    const dup: StationLayoutSnapshot = {
      ...doc,
      panes: [doc.panes[0]!, { id: "pane-main", split: null, role: "shell" }],
      activePaneId: "pane-main",
    };
    expect(isLayoutTopologyValid(dup)).toBe(false);
  });

  it("rejects an active pane that is not a member", () => {
    expect(isLayoutTopologyValid({ ...valid(), activePaneId: "ghost" as PaneId })).toBe(false);
  });
});
