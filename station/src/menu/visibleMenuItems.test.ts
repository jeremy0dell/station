import { describe, expect, it } from "bun:test";
import { visibleMenuItems } from "./visibleMenuItems.js";

const ITEMS = [
  { id: "quick" },
  { id: "settings", separatorBefore: true as const },
  { id: "remove", separatorBefore: true as const },
];

describe("visibleMenuItems", () => {
  it("accounts for separators without changing semantic item indices", () => {
    expect(visibleMenuItems(ITEMS, 3)).toEqual([
      { item: ITEMS[0], itemIndex: 0 },
      { item: ITEMS[1], itemIndex: 1 },
    ]);
  });

  it("keeps clipped menus contiguous", () => {
    expect(visibleMenuItems(ITEMS, 2)).toEqual([{ item: ITEMS[0], itemIndex: 0 }]);
  });
});
