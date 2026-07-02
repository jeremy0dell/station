import type { TuiConfig, TuiIslandConfig, TuiWidgetConfig } from "@station/config";
import type { TopRowWidgetText } from "../components/Dashboard/content.js";

export type { TuiConfig, TuiIslandConfig, TuiWidgetConfig };

export type TopRowWidgetView = TopRowWidgetText & {
  id: string;
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

export type WeatherClient = {
  getCurrentWeather(
    city: string,
    temperatureUnit: WeatherTemperatureUnit,
  ): Promise<WeatherCurrentConditions>;
};

export type TopRowWidgetRuntimeDeps = TimeWidgetRuntime & {
  weatherClient?: WeatherClient;
};
