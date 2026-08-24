import { describe, expect, it } from "vitest";
import { cellWidth, clipCells, textCellUnits, truncateCells } from "../../../src/text/cells.js";

describe("terminal text cells", () => {
  it("maps complete graphemes to source and terminal-cell coordinates", () => {
    expect(textCellUnits("Ae\u0301界👨‍👩‍👧‍👦")).toEqual([
      { text: "A", sourceIndex: 0, startCell: 0, endCell: 1 },
      { text: "e\u0301", sourceIndex: 1, startCell: 1, endCell: 2 },
      { text: "界", sourceIndex: 3, startCell: 2, endCell: 4 },
      { text: "👨‍👩‍👧‍👦", sourceIndex: 4, startCell: 4, endCell: 6 },
    ]);
  });

  it("clips and truncates by terminal cells without splitting graphemes", () => {
    const value = "e\u0301界👨‍👩‍👧‍👦x";

    expect(cellWidth(value)).toBe(6);
    expect(clipCells(value, 3)).toBe("e\u0301界");
    expect(truncateCells(value, 5)).toBe("e\u0301界…");
  });
});
