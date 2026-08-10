import { describe, expect, it } from "vitest";
import {
  moveTreeGridCursor,
  projectTreeGrid,
  reconcileTreeGridCursor,
  type TreeGridNode,
  treeGridCursorForRow,
} from "../../src/treeGrid.js";

type Cell = "identity" | "action" | "menu";
type Payload = { kind: "container" | "leaf" | "gap" };

function node(
  id: string,
  cells: readonly Cell[],
  options: {
    children?: readonly TreeGridNode<string, Cell, Payload>[];
    defaultCell?: Cell;
    expanded?: boolean;
    kind?: Payload["kind"];
  } = {},
): TreeGridNode<string, Cell, Payload> {
  return {
    id,
    payload: { kind: options.kind ?? "leaf" },
    cells,
    ...(options.defaultCell === undefined ? {} : { defaultCell: options.defaultCell }),
    ...(options.children === undefined ? {} : { children: options.children }),
    ...(options.expanded === undefined ? {} : { expanded: options.expanded }),
  };
}

const eligible = (row: { payload: Payload }) => row.payload.kind !== "gap";

describe("tree grid", () => {
  it("projects a neutral three-level preorder with parent and depth metadata", () => {
    const projection = projectTreeGrid([
      node("root", ["identity", "action"], {
        defaultCell: "identity",
        kind: "container",
        children: [
          node("gap", [], { kind: "gap" }),
          node("child", ["identity", "menu"], {
            defaultCell: "menu",
            kind: "container",
            children: [node("grandchild", ["identity"], { defaultCell: "identity" })],
          }),
        ],
      }),
    ]);

    expect(projection.visibleRows.map((row) => row.id)).toEqual([
      "root",
      "gap",
      "child",
      "grandchild",
    ]);
    expect(projection.rowById.get("root")).toMatchObject({ depth: 0 });
    expect(projection.rowById.get("gap")).toMatchObject({ depth: 1, parentId: "root" });
    expect(projection.rowById.get("grandchild")).toMatchObject({
      depth: 2,
      parentId: "child",
    });
    expect([...projection.visibleIndexById]).toEqual([
      ["root", 0],
      ["gap", 1],
      ["child", 2],
      ["grandchild", 3],
    ]);
  });

  it("keeps collapse-hidden descendants addressable and records the first collapsed ancestor", () => {
    const projection = projectTreeGrid([
      node("root", ["identity"], {
        defaultCell: "identity",
        expanded: false,
        children: [
          node("child", ["identity"], {
            defaultCell: "identity",
            expanded: false,
            children: [node("grandchild", ["identity"], { defaultCell: "identity" })],
          }),
        ],
      }),
    ]);

    expect(projection.visibleRows.map((row) => row.id)).toEqual(["root"]);
    expect([...projection.rowById.keys()]).toEqual(["root", "child", "grandchild"]);
    expect([...projection.collapsedAncestorById]).toEqual([
      ["child", "root"],
      ["grandchild", "root"],
    ]);
  });

  it("rejects duplicate ids and invalid defaults", () => {
    expect(() => projectTreeGrid([node("same", []), node("same", [])])).toThrow(
      /Duplicate tree-grid row id: same/,
    );
    expect(() => projectTreeGrid([node("bad", ["identity"], { defaultCell: "menu" })])).toThrow(
      /default cell.*menu.*bad/i,
    );
  });

  it("creates cursors only for visible eligible rows and prefers a valid requested cell", () => {
    const projection = projectTreeGrid([
      node("root", ["identity", "action"], { defaultCell: "action" }),
      node("gap", [], { kind: "gap" }),
    ]);

    expect(
      treeGridCursorForRow({
        projection,
        rowId: "root",
        preferredCell: "identity",
        policy: eligible,
      }),
    ).toEqual({ rowId: "root", cellId: "identity" });
    expect(treeGridCursorForRow({ projection, rowId: "root", policy: eligible })).toEqual({
      rowId: "root",
      cellId: "action",
    });
    expect(treeGridCursorForRow({ projection, rowId: "gap", policy: eligible })).toBeUndefined();
  });

  it("clamps horizontal movement and scans eligible visible rows vertically", () => {
    const projection = projectTreeGrid([
      node("one", ["identity", "action", "menu"], { defaultCell: "identity" }),
      node("gap", [], { kind: "gap" }),
      node("two", ["identity", "menu"], { defaultCell: "menu" }),
    ]);

    expect(
      moveTreeGridCursor({
        projection,
        cursor: { rowId: "one", cellId: "identity" },
        direction: "left",
        policy: eligible,
      }),
    ).toEqual({ rowId: "one", cellId: "identity" });
    expect(
      moveTreeGridCursor({
        projection,
        cursor: { rowId: "one", cellId: "identity" },
        direction: "right",
        policy: eligible,
      }),
    ).toEqual({ rowId: "one", cellId: "action" });
    expect(
      moveTreeGridCursor({
        projection,
        cursor: { rowId: "one", cellId: "action" },
        direction: "down",
        policy: eligible,
      }),
    ).toEqual({ rowId: "two", cellId: "menu" });
    expect(
      moveTreeGridCursor({
        projection,
        cursor: { rowId: "two", cellId: "menu" },
        direction: "up",
        policy: eligible,
      }),
    ).toEqual({ rowId: "one", cellId: "identity" });
  });

  it("reconciles cell removal, collapse, reparenting, and row removal in order", () => {
    const previous = projectTreeGrid([
      node("before", ["identity"], { defaultCell: "identity" }),
      node("parent", ["identity", "action"], {
        defaultCell: "identity",
        kind: "container",
        children: [node("child", ["identity", "menu"], { defaultCell: "menu" })],
      }),
      node("after", ["identity"], { defaultCell: "identity" }),
    ]);

    const cellRemoved = projectTreeGrid([
      node("before", ["identity"], { defaultCell: "identity" }),
      node("parent", ["identity", "action"], {
        defaultCell: "identity",
        children: [node("child", ["identity"], { defaultCell: "identity" })],
      }),
      node("after", ["identity"], { defaultCell: "identity" }),
    ]);
    expect(
      reconcileTreeGridCursor({
        previous,
        next: cellRemoved,
        cursor: { rowId: "child", cellId: "menu" },
        policy: eligible,
      }),
    ).toEqual({ rowId: "child", cellId: "identity" });

    const collapsed = projectTreeGrid([
      node("before", ["identity"], { defaultCell: "identity" }),
      node("parent", ["identity", "action"], {
        defaultCell: "identity",
        expanded: false,
        children: [node("child", ["identity", "menu"], { defaultCell: "menu" })],
      }),
      node("after", ["identity"], { defaultCell: "identity" }),
    ]);
    expect(
      reconcileTreeGridCursor({
        previous,
        next: collapsed,
        cursor: { rowId: "child", cellId: "menu" },
        policy: eligible,
      }),
    ).toEqual({ rowId: "parent", cellId: "identity" });

    const reparented = projectTreeGrid([
      node("before", ["identity"], {
        defaultCell: "identity",
        children: [node("child", ["identity", "menu"], { defaultCell: "menu" })],
      }),
      node("parent", ["identity"], { defaultCell: "identity" }),
      node("after", ["identity"], { defaultCell: "identity" }),
    ]);
    expect(
      reconcileTreeGridCursor({
        previous,
        next: reparented,
        cursor: { rowId: "child", cellId: "menu" },
        policy: eligible,
      }),
    ).toEqual({ rowId: "child", cellId: "menu" });

    const removedWithNext = projectTreeGrid([
      node("before", ["identity"], { defaultCell: "identity" }),
      node("parent", ["identity"], { defaultCell: "identity" }),
      node("after", ["identity"], { defaultCell: "identity" }),
    ]);
    expect(
      reconcileTreeGridCursor({
        previous,
        next: removedWithNext,
        cursor: { rowId: "child", cellId: "menu" },
        policy: eligible,
      }),
    ).toEqual({ rowId: "after", cellId: "identity" });

    const removedAtEnd = projectTreeGrid([
      node("before", ["identity"], { defaultCell: "identity" }),
      node("parent", ["identity"], { defaultCell: "identity" }),
    ]);
    expect(
      reconcileTreeGridCursor({
        previous,
        next: removedAtEnd,
        cursor: { rowId: "after", cellId: "identity" },
        policy: eligible,
      }),
    ).toEqual({ rowId: "parent", cellId: "identity" });
  });

  it("skips an ineligible collapsed ancestor before ordinary positional fallback", () => {
    const previous = projectTreeGrid([
      node("parent", ["identity"], {
        defaultCell: "identity",
        kind: "gap",
        children: [node("child", ["identity"], { defaultCell: "identity" })],
      }),
      node("after", ["identity"], { defaultCell: "identity" }),
    ]);
    const next = projectTreeGrid([
      node("parent", ["identity"], {
        defaultCell: "identity",
        kind: "gap",
        expanded: false,
        children: [node("child", ["identity"], { defaultCell: "identity" })],
      }),
      node("after", ["identity"], { defaultCell: "identity" }),
    ]);

    expect(
      reconcileTreeGridCursor({
        previous,
        next,
        cursor: { rowId: "child", cellId: "identity" },
        policy: eligible,
      }),
    ).toEqual({ rowId: "after", cellId: "identity" });
  });
});
