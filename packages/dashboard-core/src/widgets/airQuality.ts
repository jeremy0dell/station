import type { TuiAqiWidgetConfig } from "@station/config";
import type { TopRowWidgetText } from "../components/Dashboard/content.js";
import type { AirQualityCurrentConditions } from "./types.js";
import { locationLabel } from "./weather.js";
import { WEATHER_ERROR_EMOJI, WEATHER_LOADING_EMOJI } from "./weatherEmoji.js";

export type AirQualityCategory = {
  label: string;
  glyph: string;
};

export function airQualityCategory(aqi: number): AirQualityCategory {
  if (aqi <= 50) {
    return { label: "good", glyph: "🟢" };
  }
  if (aqi <= 100) {
    return { label: "moderate", glyph: "🟡" };
  }
  if (aqi <= 150) {
    return { label: "unhealthy for sensitive groups", glyph: "🟠" };
  }
  if (aqi <= 200) {
    return { label: "unhealthy", glyph: "🔴" };
  }
  if (aqi <= 300) {
    return { label: "very unhealthy", glyph: "🟣" };
  }
  return { label: "hazardous", glyph: "🟤" };
}

export function renderAirQualityLoading(config: TuiAqiWidgetConfig): TopRowWidgetText {
  const label = locationLabel(config.city, config.label);
  return {
    text: `${label} · AQI -- ${WEATHER_LOADING_EMOJI}`,
    compact: `${label} AQI -- ${WEATHER_LOADING_EMOJI}`,
  };
}

export function renderAirQualityError(config: TuiAqiWidgetConfig): TopRowWidgetText {
  const label = locationLabel(config.city, config.label);
  return {
    text: `${label} · AQI -- ${WEATHER_ERROR_EMOJI}`,
    compact: `${label} AQI -- ${WEATHER_ERROR_EMOJI}`,
  };
}

export function renderAirQualitySuccess(
  config: TuiAqiWidgetConfig,
  conditions: AirQualityCurrentConditions,
): TopRowWidgetText {
  const label = locationLabel(config.city, config.label);
  const aqi = Math.round(conditions.aqi);
  const category = airQualityCategory(aqi);
  return {
    text: `${label} · AQI ${aqi} ${category.label} ${category.glyph}`,
    compact: `${label} AQI ${aqi} ${category.glyph}`,
  };
}
