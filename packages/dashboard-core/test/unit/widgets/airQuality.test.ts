import { describe, expect, it } from "vitest";
import {
  airQualityCategory,
  renderAirQualityError,
  renderAirQualityLoading,
  renderAirQualitySuccess,
} from "../../../src/widgets/airQuality.js";

describe("air quality widget rendering", () => {
  it.each([
    [0, "good", "🟢"],
    [50, "good", "🟢"],
    [51, "moderate", "🟡"],
    [100, "moderate", "🟡"],
    [101, "unhealthy for sensitive groups", "🟠"],
    [150, "unhealthy for sensitive groups", "🟠"],
    [151, "unhealthy", "🔴"],
    [200, "unhealthy", "🔴"],
    [201, "very unhealthy", "🟣"],
    [300, "very unhealthy", "🟣"],
    [301, "hazardous", "🟤"],
  ])("maps U.S. AQI %s to %s", (aqi, label, glyph) => {
    expect(airQualityCategory(aqi)).toEqual({ label, glyph });
  });

  it("renders explicit and derived location labels", () => {
    expect(renderAirQualitySuccess({ type: "aqi", city: "New York, NY" }, { aqi: 42 })).toEqual({
      text: "NEW · AQI 42 good 🟢",
      compact: "NEW AQI 42 🟢",
    });
    expect(
      renderAirQualitySuccess({ type: "aqi", city: "Los Angeles", label: "LA" }, { aqi: 90 }),
    ).toEqual({ text: "LA · AQI 90 moderate 🟡", compact: "LA AQI 90 🟡" });
  });

  it("renders loading and error states", () => {
    const config = { type: "aqi", city: "Austin", label: "ATX" } as const;
    expect(renderAirQualityLoading(config)).toEqual({
      text: "ATX · AQI -- ⏳",
      compact: "ATX AQI -- ⏳",
    });
    expect(renderAirQualityError(config)).toEqual({
      text: "ATX · AQI -- 🫥",
      compact: "ATX AQI -- 🫥",
    });
  });
});
