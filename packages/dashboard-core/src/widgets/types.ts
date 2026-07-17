import type { TuiConfig, TuiIslandConfig, TuiWidgetConfig } from "@station/config";
import type { TopRowWidgetText } from "../components/Dashboard/content.js";

export type { TuiConfig, TuiIslandConfig, TuiWidgetConfig };

/** Widgets whose text is derived from the observer snapshot at render time. */
export type SnapshotWidgetKind = "fleet" | "prs";

export type TopRowWidgetView = TopRowWidgetText & {
  id: string;
  /** Set for snapshot-derived widgets; resolveTopRowWidgets fills their text. */
  data?: SnapshotWidgetKind;
};

export type TimeWidgetRuntime = {
  now?: () => Date;
};

export type WeatherCurrentConditions = {
  temperature: number;
  weatherCode: number;
  isDay: boolean;
};

export type WeatherTemperatureUnit = "fahrenheit" | "celsius";

export type AirQualityCurrentConditions = {
  /** Consolidated U.S. Air Quality Index. */
  aqi: number;
};

export type AirQualityClient = {
  getCurrentAirQuality(city: string): Promise<AirQualityCurrentConditions>;
};

export type WeatherClient = {
  getCurrentWeather(
    city: string,
    temperatureUnit: WeatherTemperatureUnit,
  ): Promise<WeatherCurrentConditions>;
};

export type TopRowWidgetRuntimeDeps = TimeWidgetRuntime & {
  airQualityClient?: AirQualityClient;
  weatherClient?: WeatherClient;
};
