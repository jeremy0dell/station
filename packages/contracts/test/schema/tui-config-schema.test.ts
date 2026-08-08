import { TuiConfigSchema, TuiWidgetConfigSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";

describe("TUI config schemas", () => {
  it("parses each widget variant through the discriminated union", () => {
    expect(TuiWidgetConfigSchema.parse({ type: "time", timeFormat: "24h" })).toEqual({
      type: "time",
      timeFormat: "24h",
    });
    expect(TuiWidgetConfigSchema.parse({ type: "weather", city: "Lisbon" })).toEqual({
      type: "weather",
      city: "Lisbon",
    });
    expect(TuiWidgetConfigSchema.parse({ type: "fleet" })).toEqual({ type: "fleet" });
    expect(TuiWidgetConfigSchema.parse({ type: "prs" })).toEqual({ type: "prs" });
    expect(TuiWidgetConfigSchema.parse({ type: "moon" })).toEqual({ type: "moon" });
    expect(
      TuiWidgetConfigSchema.parse({
        type: "tz",
        zones: [{ label: "Lisbon", timeZone: "Europe/Lisbon" }],
      }),
    ).toEqual({ type: "tz", zones: [{ label: "Lisbon", timeZone: "Europe/Lisbon" }] });
  });

  it("rejects unknown widget fields, types, and empty required strings", () => {
    expect(TuiWidgetConfigSchema.safeParse({ type: "moon", glow: true }).success).toBe(false);
    expect(TuiWidgetConfigSchema.safeParse({ type: "stars" }).success).toBe(false);
    expect(TuiWidgetConfigSchema.safeParse({ type: "weather", city: "" }).success).toBe(false);
  });

  it("bounds timezone zone counts", () => {
    const zone = { label: "Lisbon", timeZone: "Europe/Lisbon" };
    expect(TuiWidgetConfigSchema.safeParse({ type: "tz", zones: [] }).success).toBe(false);
    expect(TuiWidgetConfigSchema.safeParse({ type: "tz", zones: [zone, zone, zone] }).success).toBe(
      false,
    );
  });

  it("keeps the [tui] section strict while island stays optional", () => {
    expect(TuiConfigSchema.parse({})).toEqual({});
    expect(TuiConfigSchema.parse({ island: { restCounts: true } })).toEqual({
      island: { restCounts: true },
    });
    expect(TuiConfigSchema.safeParse({ widgets: [], unknown: true }).success).toBe(false);
  });
});
