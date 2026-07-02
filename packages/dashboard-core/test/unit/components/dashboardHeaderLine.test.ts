import { describe, expect, it } from "vitest";
import { dashboardHeaderLine } from "../../../src/components/Dashboard/content.js";

const WIDGETS = [
  { text: "NYC 08:00 · TYO 21:00", compact: "NYC 08:00" },
  { text: "🌕 full moon", compact: "🌕" },
];

function line(columns: number): string {
  return dashboardHeaderLine({ productLabel: "station", columns, widgets: WIDGETS });
}

describe("dashboardHeaderLine widget strip", () => {
  it("shows every widget in full when the width allows", () => {
    expect(line(80)).toBe(`station${" ".repeat(38)}NYC 08:00 · TYO 21:00  🌕 full moon`);
  });

  it("compacts every widget before dropping any", () => {
    expect(line(40)).toBe(`station${" ".repeat(20)}NYC 08:00  🌕`);
  });

  it("drops widgets from the right once compact forms no longer fit", () => {
    expect(line(17)).toBe(`station${" ".repeat(1)}NYC 08:00`);
  });

  it("falls back to the product label alone at minimum widths", () => {
    expect(line(10)).toBe("station");
  });
});
