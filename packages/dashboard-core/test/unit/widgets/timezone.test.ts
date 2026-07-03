import { describe, expect, it } from "vitest";
import { formatTimezoneWidget, zoneTime } from "../../../src/widgets/timezone.js";

// 2026-06-12T12:00Z → 08:00 in New York (EDT), 21:00 in Tokyo.
const NOON_UTC = new Date(Date.UTC(2026, 5, 12, 12, 0));

const NYC = { label: "NYC", timeZone: "America/New_York" };
const TYO = { label: "TYO", timeZone: "Asia/Tokyo" };

describe("zoneTime", () => {
  it("formats 12h and 24h wall time in the zone", () => {
    expect(zoneTime(NOON_UTC, NYC, "12h")).toBe("8:00 AM");
    expect(zoneTime(NOON_UTC, NYC, "24h")).toBe("08:00");
    expect(zoneTime(NOON_UTC, TYO, "12h")).toBe("9:00 PM");
    expect(zoneTime(NOON_UTC, TYO, "24h")).toBe("21:00");
  });

  it("renders an unknown zone as --:-- instead of throwing", () => {
    expect(zoneTime(NOON_UTC, { label: "??", timeZone: "Not/AZone" }, "12h")).toBe("--:--");
  });
});

describe("formatTimezoneWidget", () => {
  it("joins the pair and compacts to the first zone", () => {
    const widget = formatTimezoneWidget(NOON_UTC, {
      type: "tz",
      zones: [NYC, TYO],
      timeFormat: "24h",
    });
    expect(widget).toEqual({ text: "NYC 08:00 · TYO 21:00", compact: "NYC 08:00" });
  });

  it("renders a single zone with the 12h default", () => {
    const widget = formatTimezoneWidget(NOON_UTC, { type: "tz", zones: [NYC] });
    expect(widget).toEqual({ text: "NYC 8:00 AM", compact: "NYC 8:00 AM" });
  });
});
