import { z } from "zod";
import type {
  AirQualityClient,
  AirQualityCurrentConditions,
  WeatherClient,
  WeatherCurrentConditions,
  WeatherTemperatureUnit,
} from "./types.js";

const OPEN_METEO_AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const OPEN_METEO_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 3_000;

// open-meteo's unversioned v1 responses gain fields over time, so parse only
// what we consume and tolerate unknown keys — an additive API change must not
// disable the widget. The fields we read stay required, so genuinely malformed
// data still fails closed and surfaces the error glyph.
const GeocodingResponseSchema = z.object({
  results: z.array(z.object({ latitude: z.number(), longitude: z.number() })).optional(),
});

const ForecastCurrentSchema = z.object({
  temperature_2m: z.number(),
  weather_code: z.number(),
  is_day: z.union([z.literal(0), z.literal(1), z.boolean()]),
});

const ForecastResponseSchema = z.object({
  current: ForecastCurrentSchema,
});

const AirQualityResponseSchema = z.object({
  current: z.object({
    us_aqi: z.number().int().nonnegative(),
  }),
});

export class OpenMeteoWeatherClient implements WeatherClient {
  async getCurrentWeather(
    city: string,
    temperatureUnit: WeatherTemperatureUnit,
  ): Promise<WeatherCurrentConditions> {
    const coordinates = await geocodeCity(city);
    const forecast = await fetchForecast(coordinates, temperatureUnit);
    return {
      temperature: forecast.temperature_2m,
      weatherCode: forecast.weather_code,
      isDay: forecast.is_day === true || forecast.is_day === 1,
    };
  }
}

export class OpenMeteoAirQualityClient implements AirQualityClient {
  async getCurrentAirQuality(city: string): Promise<AirQualityCurrentConditions> {
    const coordinates = await geocodeCity(city);
    return { aqi: await fetchAirQuality(coordinates) };
  }
}

export const defaultAirQualityClient: AirQualityClient = new OpenMeteoAirQualityClient();
export const defaultWeatherClient: WeatherClient = new OpenMeteoWeatherClient();

async function geocodeCity(city: string): Promise<{ latitude: number; longitude: number }> {
  for (const query of geocodingQueries(city)) {
    const url = new URL(OPEN_METEO_GEOCODING_URL);
    url.searchParams.set("name", query);
    url.searchParams.set("count", "1");
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");

    const response = GeocodingResponseSchema.parse(await fetchJson(url));
    const match = response.results?.[0];
    if (match !== undefined) {
      return {
        latitude: match.latitude,
        longitude: match.longitude,
      };
    }
  }

  throw new Error("Location was not found.");
}

function geocodingQueries(city: string): string[] {
  const firstSegment = city.split(",")[0]?.trim();
  return Array.from(
    new Set([city.trim(), ...(firstSegment === undefined ? [] : [firstSegment])].filter(Boolean)),
  );
}

async function fetchForecast(
  coordinates: { latitude: number; longitude: number },
  temperatureUnit: WeatherTemperatureUnit,
): Promise<z.infer<typeof ForecastCurrentSchema>> {
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.searchParams.set("latitude", String(coordinates.latitude));
  url.searchParams.set("longitude", String(coordinates.longitude));
  url.searchParams.set("current", "temperature_2m,weather_code,is_day");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("forecast_days", "1");

  return ForecastResponseSchema.parse(await fetchJson(url)).current;
}

async function fetchAirQuality(coordinates: {
  latitude: number;
  longitude: number;
}): Promise<number> {
  const url = new URL(OPEN_METEO_AIR_QUALITY_URL);
  url.searchParams.set("latitude", String(coordinates.latitude));
  url.searchParams.set("longitude", String(coordinates.longitude));
  url.searchParams.set("current", "us_aqi");

  return AirQualityResponseSchema.parse(await fetchJson(url)).current.us_aqi;
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as unknown;
}
