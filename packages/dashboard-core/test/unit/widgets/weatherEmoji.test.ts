import { describe, expect, it } from "vitest";
import {
  WEATHER_ERROR_EMOJI,
  WEATHER_LOADING_EMOJI,
  weatherEmoji,
} from "../../../src/widgets/weatherEmoji.js";

describe("weatherEmoji", () => {
  it.each([
    [0, true, "☀️"],
    [0, false, "🌙"],
    [2, true, "🌤️"],
    [3, true, "☁️"],
    [45, true, "🌫️"],
    [61, true, "🌧️"],
    [95, true, "⛈️"],
    [71, true, "🌨️"],
    [999, true, "🌡️"],
  ])("maps weather code %s", (code, isDay, expected) => {
    expect(weatherEmoji(code, isDay)).toBe(expected);
  });

  it("exports compact loading and error emoji", () => {
    expect(WEATHER_LOADING_EMOJI).toBe("⏳");
    expect(WEATHER_ERROR_EMOJI).toBe("🫥");
  });
});
