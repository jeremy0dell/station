import { describe, expect, it } from "bun:test";
import type { ContextMenuItem } from "./types.js";
import {
  moveContextMenuActiveItem,
  resolveContextMenuActiveItem,
} from "./selection.js";

const ITEMS: readonly ContextMenuItem[] = [
  { id: "pane.splitRight", label: "Right", action: { kind: "noop" } },
  { id: "pane.splitBelow", label: "Below", action: { kind: "noop" } },
  { id: "pane.close", label: "Close", action: { kind: "noop" } },
];

describe("semantic context-menu selection", () => {
  it("falls back by current identity and wraps ordered keyboard movement", () => {
    expect(resolveContextMenuActiveItem(ITEMS, undefined)?.id).toBe("pane.splitRight");
    expect(resolveContextMenuActiveItem(ITEMS, "station.renameSession")?.id).toBe(
      "pane.splitRight",
    );
    expect(moveContextMenuActiveItem(ITEMS, "pane.close", 1)).toBe("pane.splitRight");
    expect(moveContextMenuActiveItem(ITEMS, "pane.splitRight", -1)).toBe("pane.close");
  });

  it("has no synthetic focus identity for an empty menu", () => {
    expect(resolveContextMenuActiveItem([], undefined)).toBeUndefined();
    expect(moveContextMenuActiveItem([], undefined, 1)).toBeUndefined();
  });
});
