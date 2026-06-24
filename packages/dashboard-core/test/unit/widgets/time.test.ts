import { describe, expect, it } from "vitest";
import { formatTimeWidget, millisecondsUntilNextMinute } from "../../../src/widgets/time.js";

describe("time widget", () => {
  it("formats 12 hour time", () => {
    expect(formatTimeWidget(new Date(2026, 5, 2, 10, 42), { type: "time" })).toBe("10:42 AM");
    expect(formatTimeWidget(new Date(2026, 5, 2, 0, 5), { type: "time" })).toBe("12:05 AM");
    expect(formatTimeWidget(new Date(2026, 5, 2, 12, 5), { type: "time" })).toBe("12:05 PM");
  });

  it("formats 24 hour time", () => {
    expect(
      formatTimeWidget(new Date(2026, 5, 2, 10, 42), { type: "time", timeFormat: "24h" }),
    ).toBe("10:42");
    expect(formatTimeWidget(new Date(2026, 5, 2, 0, 5), { type: "time", timeFormat: "24h" })).toBe(
      "00:05",
    );
  });

  it("calculates the next minute boundary", () => {
    expect(millisecondsUntilNextMinute(new Date(2026, 5, 2, 10, 42, 10, 250))).toBe(49_750);
    expect(millisecondsUntilNextMinute(new Date(2026, 5, 2, 10, 42, 59, 999))).toBe(1);
  });
});
