import { describe, expect, it } from "vitest";
import {
  fleetCountsLabel,
  headerStrip,
  headerStripLayout,
} from "../../../src/components/Dashboard/content.js";

const WIDGETS = [
  { text: "NYC 08:00 · TYO 21:00", compact: "NYC 08:00" },
  { text: "🌕 full moon", compact: "🌕" },
];

function strip(maxWidth: number): string {
  return headerStrip({ widgets: WIDGETS, maxWidth });
}

describe("headerStrip", () => {
  it("joins every widget in full with middots when the width allows", () => {
    expect(strip(60)).toBe("NYC 08:00 · TYO 21:00 · 🌕 full moon");
  });

  it("compacts every widget before dropping any", () => {
    expect(strip(20)).toBe("NYC 08:00 · 🌕");
  });

  it("drops widgets from the right once compact forms no longer fit", () => {
    expect(strip(10)).toBe("NYC 08:00");
  });

  it("returns nothing at minimum widths", () => {
    expect(strip(4)).toBe("");
  });

  it("prefixes the observer status, compacting it before the widgets vanish", () => {
    const status = {
      full: "observer reconnecting · display-only snapshot",
      compact: "observer reconnecting",
    };
    expect(headerStrip({ widgets: WIDGETS, status, maxWidth: 90 })).toBe(
      "observer reconnecting · display-only snapshot · NYC 08:00 · TYO 21:00 · 🌕 full moon",
    );
    expect(headerStrip({ widgets: WIDGETS, status, maxWidth: 24 })).toBe("observer reconnecting");
  });

  it("keeps attribution with the selected widget and includes it in the width budget", () => {
    const attribution = { label: "source", url: "https://example.com/" };
    const widgets = [{ text: "AQI", compact: "A", attribution }];

    expect(headerStrip({ widgets, maxWidth: 10 })).toBe("AQI source");
    expect(headerStripLayout({ widgets, maxWidth: 8 })).toEqual({
      text: "A source",
      statusText: "",
      widgets: [{ text: "A", attribution }],
    });
    expect(headerStrip({ widgets, maxWidth: 3 })).toBe("");
  });

  it("shows identical attribution once across multiple widgets", () => {
    const attribution = { label: "source", url: "https://example.com/" };
    const widgets = [
      { text: "AQI 10", attribution },
      { text: "AQI 20", attribution },
    ];

    expect(headerStrip({ widgets, maxWidth: 40 })).toBe("AQI 10 source · AQI 20");
    expect(headerStrip({ widgets, maxWidth: 13 })).toBe("AQI 10 source");
  });
});

describe("fleetCountsLabel", () => {
  it("spells the totals out, compacts to bare numbers, then yields", () => {
    const counts = { projects: 4, sessions: 10, agents: 6 };
    expect(fleetCountsLabel(counts, 60)).toBe("4 projects · 10 sessions · 6 agents");
    expect(fleetCountsLabel(counts, 20)).toBe("4 · 10 · 6");
    expect(fleetCountsLabel(counts, 5)).toBe("");
  });

  it("uses singular nouns for counts of one", () => {
    expect(fleetCountsLabel({ projects: 1, sessions: 1, agents: 1 }, 60)).toBe(
      "1 project · 1 session · 1 agent",
    );
  });
});
