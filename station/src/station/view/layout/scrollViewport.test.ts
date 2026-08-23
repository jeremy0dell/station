import { describe, expect, it } from "bun:test";
import { intersectingSemanticItems } from "./scrollViewport.js";

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
});

