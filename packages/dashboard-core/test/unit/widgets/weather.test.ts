import { describe, expect, it } from "vitest";
import {
  renderWeatherError,
  renderWeatherLoading,
  renderWeatherSuccess,
  weatherLabel,
} from "../../../src/widgets/weather.js";

describe("weather widget rendering", () => {
  it("derives a 3-letter label from the first alphanumerics of the city", () => {
    expect(weatherLabel({ type: "weather", city: "New York, NY" })).toBe("NEW");
    expect(weatherLabel({ type: "weather", city: "São Paulo" })).toBe("SOP");
  });

  it("honors an explicit label and falls back to ??? when nothing matches", () => {
    expect(weatherLabel({ type: "weather", city: "Anywhere", label: "NYC" })).toBe("NYC");
    expect(weatherLabel({ type: "weather", city: "!!!" })).toBe("???");
  });

  it("renders loading, error, and success lines", () => {
    const config = { type: "weather", city: "Austin", label: "ATX" } as const;
    expect(renderWeatherLoading(config)).toBe("ATX --° ⏳");
    expect(renderWeatherError(config)).toBe("ATX --° 🫥");
    expect(renderWeatherSuccess(config, { temperature: 72.4, weatherCode: 0, isDay: true })).toBe(
      "ATX 72° ☀️",
    );
  });
});
