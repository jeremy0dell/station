import { describe, expect, it } from "bun:test";
import {
  intersectingOrderedSemanticItems,
  intersectingSemanticItems,
  semanticRevealDelta,
} from "./scrollViewport.js";

describe("semantic scroll viewport", () => {
  it("resolves visibility from mixed-height coordinates instead of item count", () => {
    const items = [
      { id: "one", top: 0, bottom: 1 },
      { id: "tall", top: 1, bottom: 5 },
      { id: "three", top: 5, bottom: 6 },
      { id: "four", top: 6, bottom: 8 },
    ] as const;

    expect(intersectingSemanticItems({ top: 2, bottom: 6 }, items)).toEqual(["tall", "three"]);
    expect(intersectingSemanticItems({ top: 3, bottom: 4 }, items)).toEqual(["tall"]);
  });

  it("keeps an item taller than the viewport visible at either clipping edge", () => {
    const items = [{ id: "tall", top: 1, bottom: 9 }] as const;

    expect(intersectingSemanticItems({ top: 0, bottom: 3 }, items)).toEqual(["tall"]);
    expect(intersectingSemanticItems({ top: 7, bottom: 10 }, items)).toEqual(["tall"]);
  });

  it("reveals equal-height and oversized boxes without assuming one-row children", () => {
    expect(semanticRevealDelta({ top: 3, bottom: 4 }, { top: 14, bottom: 15 })).toBe(11);
    expect(semanticRevealDelta({ top: 3, bottom: 6 }, { top: 8, bottom: 14 })).toBe(5);
    expect(semanticRevealDelta({ top: 8, bottom: 11 }, { top: 5, bottom: 7 })).toBe(-3);
    expect(semanticRevealDelta({ top: 8, bottom: 11 }, { top: 10, bottom: 12 })).toBe(1);
    expect(semanticRevealDelta({ top: 8, bottom: 11 }, { top: 9, bottom: 15 })).toBe(0);
  });

  it("relaxes a followed edge when the measured viewport grows", () => {
    const item = { top: 2, bottom: 3 };

    expect(semanticRevealDelta({ top: 0, bottom: 4 }, item)).toBe(0);
    expect(semanticRevealDelta({ top: 0, bottom: 4 }, item, "end")).toBe(-1);
  });

  it("keeps the followed edge stable when content above it changes height", () => {
    expect(
      semanticRevealDelta(
        { top: 0, bottom: 4 },
        { top: 5, bottom: 6 },
        "end",
      ),
    ).toBe(2);
  });

  it("bounds geometry work while scrolling and resizing a large mixed-height tree", () => {
    const itemIds = Array.from({ length: 10_000 }, (_, index) => `item-${index}`);
    let top = 0;
    const geometry = itemIds.map((id, index) => {
        const height = index % 2 === 0 ? 1 : 4;
        const item = { id, top, bottom: top + height };
        top += height;
        return item;
      });
    const geometryById = new Map(geometry.map((item) => [item.id, item] as const));
    let geometryReads = 0;
    for (let experiment = 0; experiment < 200; experiment += 1) {
      const viewportTop = (experiment * 113) % (top - 32);
      const viewportHeight = 8 + (experiment % 24);
      const visible = intersectingOrderedSemanticItems(
        { top: viewportTop, bottom: viewportTop + viewportHeight },
        itemIds,
        (id) => {
          geometryReads += 1;
          return geometryById.get(id);
        },
      );
      expect(visible).toEqual(
        intersectingSemanticItems(
          { top: viewportTop, bottom: viewportTop + viewportHeight },
          geometry,
        ),
      );
    }

    // log2(10,000) needs 14 probes; an alternating 1/4-cell tree contributes at most
    // 14 visible candidates to these windows. Forty reads leaves room for edge probes.
    expect(geometryReads).toBeLessThanOrEqual(200 * 40);
  });
});
