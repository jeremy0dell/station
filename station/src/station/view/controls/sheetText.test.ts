import { describe, expect, it } from "bun:test";
import { cellWidth } from "@station/dashboard-core/text";
import {
  fit,
  responsiveSheetFooterText,
  responsiveSheetText,
} from "./sheetText.js";

describe("responsive sheet text", () => {
  const variants = {
    expanded: "Expanded copy",
    compact: "Compact",
  } as const;

  it("selects copy from measured available width", () => {
    const expandedWidth = cellWidth(variants.expanded);
    expect(responsiveSheetText(expandedWidth, variants)).toBe(variants.expanded);
    const narrowerWidth = expandedWidth - cellWidth(" ");
    expect(responsiveSheetText(narrowerWidth, variants)).toBe(variants.compact);
  });

  it("reserves the footer inset before selecting copy", () => {
    const expandedFooter = ` ${variants.expanded}`;
    expect(responsiveSheetFooterText(cellWidth(expandedFooter), variants)).toBe(variants.expanded);
    expect(responsiveSheetFooterText(cellWidth(variants.expanded), variants)).toBe(
      variants.compact,
    );
  });
});

describe("sheet terminal-cell fitting", () => {
  it("fits wide and combining graphemes by cells without splitting them", () => {
    expect(fit("界a", 3)).toBe("界a");
    expect(cellWidth(fit("界a", 3))).toBe(3);
    expect(fit("界a", 2)).toBe("界");
    expect(cellWidth(fit("e\u0301", 2))).toBe(2);
    expect(fit("e\u0301", 2)).toBe("e\u0301 ");
  });
});
