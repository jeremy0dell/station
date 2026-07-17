import type { TuiWeatherWidgetConfig } from "@station/config";
import type { WeatherCurrentConditions } from "./types.js";
import { WEATHER_ERROR_EMOJI, WEATHER_LOADING_EMOJI, weatherEmoji } from "./weatherEmoji.js";

export function locationLabel(city: string, label: string | undefined): string {
  if (label !== undefined) {
    return label;
  }
  const derived = Array.from(city.matchAll(/[a-z0-9]/gi))
    .slice(0, 3)
    .map((match) => match[0].toUpperCase())
    .join("");
  return derived.length > 0 ? derived : "???";
}

export function weatherLabel(config: TuiWeatherWidgetConfig): string {
  return locationLabel(config.city, config.label);
}

export function renderWeatherLoading(config: TuiWeatherWidgetConfig): string {
  return `${weatherLabel(config)} · --° ${WEATHER_LOADING_EMOJI}`;
}

export function renderWeatherError(config: TuiWeatherWidgetConfig): string {
  return `${weatherLabel(config)} · --° ${WEATHER_ERROR_EMOJI}`;
}

export function renderWeatherSuccess(
  config: TuiWeatherWidgetConfig,
  conditions: WeatherCurrentConditions,
): string {
  return `${weatherLabel(config)} · ${Math.round(conditions.temperature)}° ${weatherEmoji(
    conditions.weatherCode,
    conditions.isDay,
  )}`;
}
