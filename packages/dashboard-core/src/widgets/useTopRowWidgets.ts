import type { TuiAqiWidgetConfig, TuiWeatherWidgetConfig, TuiWidgetConfig } from "@station/config";
import type { TopRowWidgetText } from "../components/Dashboard/content.js";
import {
  renderAirQualityError,
  renderAirQualityLoading,
  renderAirQualitySuccess,
} from "./airQuality.js";
import { formatMoonWidget } from "./moon.js";
import { formatTimeWidget, millisecondsUntilNextMinute } from "./time.js";
import { formatTimezoneWidget } from "./timezone.js";
import type {
  AirQualityCurrentConditions,
  TopRowWidgetRuntimeDeps,
  TopRowWidgetView,
  WeatherCurrentConditions,
  WeatherTemperatureUnit,
} from "./types.js";
import {
  compactWeatherText,
  renderWeatherError,
  renderWeatherLoading,
  renderWeatherSuccess,
} from "./weather.js";
import { defaultAirQualityClient, defaultWeatherClient } from "./weatherClient.js";

type SetStateAction<T> = T | ((previous: T) => T);

export type TopRowWidgetHookRuntime = {
  useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T;
  useEffect(effect: () => undefined | (() => void), deps: readonly unknown[]): void;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useRef<T>(initialValue: T): { current: T };
  useState<T>(initialValue: T | (() => T)): [T, (action: SetStateAction<T>) => void];
};

type WeatherWidgetEntry = {
  id: string;
  config: TuiWeatherWidgetConfig;
};

type WeatherCacheEntry = {
  conditions: WeatherCurrentConditions;
  fetchedAtMs: number;
};

type AirQualityWidgetEntry = {
  id: string;
  config: TuiAqiWidgetConfig;
};

type AirQualityCacheEntry = {
  conditions: AirQualityCurrentConditions;
  fetchedAtMs: number;
};

const DEFAULT_AIR_QUALITY_REFRESH_INTERVAL_MINUTES = 60;
const DEFAULT_WEATHER_REFRESH_INTERVAL_MINUTES = 15;

// Hooks are injected rather than imported so dashboard-core stays React-free
// (no react dependency); each consuming app wires in its own React.
export function createUseTopRowWidgets(hooks: TopRowWidgetHookRuntime) {
  return function useTopRowWidgets(
    widgets: readonly TuiWidgetConfig[],
    deps: TopRowWidgetRuntimeDeps = {},
  ): TopRowWidgetView[] {
    const now = deps.now ?? defaultNow;
    const [currentMinute, setCurrentMinute] = hooks.useState(() => now());
    const airQualityClient = deps.airQualityClient ?? defaultAirQualityClient;
    const airQualityCache = hooks.useRef(new Map<string, AirQualityCacheEntry>());
    const [airQualityViews, setAirQualityViews] = hooks.useState<Record<string, TopRowWidgetText>>(
      {},
    );
    const setAirQualityView = hooks.useCallback((id: string, view: TopRowWidgetText) => {
      setAirQualityViews((previous) => {
        const current = previous[id];
        if (current?.text === view.text && current.compact === view.compact) {
          return previous;
        }
        return {
          ...previous,
          [id]: view,
        };
      });
    }, []);
    const weatherClient = deps.weatherClient ?? defaultWeatherClient;
    const weatherCache = hooks.useRef(new Map<string, WeatherCacheEntry>());
    const [weatherTexts, setWeatherTexts] = hooks.useState<Record<string, string>>({});
    const setWeatherText = hooks.useCallback((id: string, text: string) => {
      setWeatherTexts((previous) => {
        if (previous[id] === text) {
          return previous;
        }
        return {
          ...previous,
          [id]: text,
        };
      });
    }, []);

    // Disabled widgets drop out entirely; ids keep the config index so a
    // toggle elsewhere in the array never re-keys live widget state.
    const activeWidgets = hooks.useMemo(
      () =>
        widgets
          .map((widget, index) => ({ widget, index }))
          .filter((entry) => entry.widget.enabled !== false),
      [widgets],
    );
    const needsClock = activeWidgets.some(
      ({ widget }) => widget.type === "time" || widget.type === "tz" || widget.type === "moon",
    );
    const weatherEntries = hooks.useMemo(
      () =>
        activeWidgets.flatMap(({ widget, index }): WeatherWidgetEntry[] =>
          widget.type === "weather" ? [{ id: `weather:${index}`, config: widget }] : [],
        ),
      [activeWidgets],
    );
    const airQualityEntries = hooks.useMemo(
      () =>
        activeWidgets.flatMap(({ widget, index }): AirQualityWidgetEntry[] =>
          widget.type === "aqi" ? [{ id: `aqi:${index}`, config: widget }] : [],
        ),
      [activeWidgets],
    );

    hooks.useEffect(() => {
      if (!needsClock) {
        return;
      }

      let interval: ReturnType<typeof setInterval> | undefined;
      const timeout = setTimeout(() => {
        setCurrentMinute(now());
        interval = setInterval(() => {
          setCurrentMinute(now());
        }, 60_000);
      }, millisecondsUntilNextMinute(now()));

      return () => {
        clearTimeout(timeout);
        if (interval !== undefined) {
          clearInterval(interval);
        }
      };
    }, [needsClock, now]);

    hooks.useEffect(() => {
      if (weatherEntries.length === 0) {
        setWeatherTexts({});
        return;
      }

      let cancelled = false;
      const intervals: Array<ReturnType<typeof setInterval>> = [];

      setWeatherTexts((previous) => {
        const next: Record<string, string> = {};
        for (const entry of weatherEntries) {
          next[entry.id] = previous[entry.id] ?? renderWeatherLoading(entry.config);
        }
        return next;
      });

      for (const entry of weatherEntries) {
        void refreshWeatherWidget(entry, {
          cancelled: () => cancelled,
          cache: weatherCache.current,
          nowMs: () => now().getTime(),
          weatherClient,
          setText: (text) => setWeatherText(entry.id, text),
        });

        const interval = setInterval(() => {
          void refreshWeatherWidget(entry, {
            cancelled: () => cancelled,
            cache: weatherCache.current,
            nowMs: () => now().getTime(),
            weatherClient,
            setText: (text) => setWeatherText(entry.id, text),
          });
        }, weatherRefreshIntervalMs(entry.config));
        intervals.push(interval);
      }

      return () => {
        cancelled = true;
        for (const interval of intervals) {
          clearInterval(interval);
        }
      };
    }, [weatherEntries, weatherClient, now, setWeatherText]);

    hooks.useEffect(() => {
      if (airQualityEntries.length === 0) {
        setAirQualityViews({});
        return;
      }

      let cancelled = false;
      const intervals: Array<ReturnType<typeof setInterval>> = [];

      setAirQualityViews((previous) => {
        const next: Record<string, TopRowWidgetText> = {};
        for (const entry of airQualityEntries) {
          next[entry.id] = previous[entry.id] ?? renderAirQualityLoading(entry.config);
        }
        return next;
      });

      for (const entry of airQualityEntries) {
        void refreshAirQualityWidget(entry, {
          cancelled: () => cancelled,
          cache: airQualityCache.current,
          nowMs: () => now().getTime(),
          airQualityClient,
          setView: (view) => setAirQualityView(entry.id, view),
        });

        const interval = setInterval(() => {
          void refreshAirQualityWidget(entry, {
            cancelled: () => cancelled,
            cache: airQualityCache.current,
            nowMs: () => now().getTime(),
            airQualityClient,
            setView: (view) => setAirQualityView(entry.id, view),
          });
        }, airQualityRefreshIntervalMs(entry.config));
        intervals.push(interval);
      }

      return () => {
        cancelled = true;
        for (const interval of intervals) {
          clearInterval(interval);
        }
      };
    }, [airQualityClient, airQualityEntries, now, setAirQualityView]);

    return hooks.useMemo(
      () =>
        activeWidgets.map(({ widget, index }): TopRowWidgetView => {
          switch (widget.type) {
            case "time":
              return {
                id: `time:${index}`,
                text: formatTimeWidget(currentMinute, widget),
              };
            case "weather": {
              const id = `weather:${index}`;
              const text = weatherTexts[id] ?? renderWeatherLoading(widget);
              return {
                id,
                text,
                compact: compactWeatherText(widget, text),
              };
            }
            case "aqi": {
              const id = `aqi:${index}`;
              return {
                id,
                ...(airQualityViews[id] ?? renderAirQualityLoading(widget)),
              };
            }
            case "tz":
              return { id: `tz:${index}`, ...formatTimezoneWidget(currentMinute, widget) };
            case "moon":
              return { id: `moon:${index}`, ...formatMoonWidget(currentMinute) };
            // Snapshot-derived widgets: text resolves at render, where the
            // snapshot lives (resolveTopRowWidgets).
            case "fleet":
              return { id: `fleet:${index}`, text: "", data: "fleet" };
            case "prs":
              return { id: `prs:${index}`, text: "", data: "prs" };
          }
          const exhaustive: never = widget;
          return exhaustive;
        }),
      [activeWidgets, airQualityViews, currentMinute, weatherTexts],
    );
  };
}

export async function refreshWeatherWidget(
  entry: WeatherWidgetEntry,
  runtime: {
    cancelled: () => boolean;
    cache: Map<string, WeatherCacheEntry>;
    nowMs: () => number;
    weatherClient: NonNullable<TopRowWidgetRuntimeDeps["weatherClient"]>;
    setText: (text: string) => void;
  },
): Promise<void> {
  const unit = temperatureUnit(entry.config);
  const cacheKey = weatherCacheKey(entry.config.city, unit);
  const cached = runtime.cache.get(cacheKey);
  const fetchedAtMs = runtime.nowMs();
  if (
    cached !== undefined &&
    fetchedAtMs - cached.fetchedAtMs < weatherRefreshIntervalMs(entry.config)
  ) {
    runtime.setText(renderWeatherSuccess(entry.config, cached.conditions));
    return;
  }

  try {
    const conditions = await runtime.weatherClient.getCurrentWeather(entry.config.city, unit);
    if (runtime.cancelled()) {
      return;
    }
    runtime.cache.set(cacheKey, {
      conditions,
      fetchedAtMs: runtime.nowMs(),
    });
    runtime.setText(renderWeatherSuccess(entry.config, conditions));
  } catch {
    if (!runtime.cancelled()) {
      runtime.setText(renderWeatherError(entry.config));
    }
  }
}

export async function refreshAirQualityWidget(
  entry: AirQualityWidgetEntry,
  runtime: {
    cancelled: () => boolean;
    cache: Map<string, AirQualityCacheEntry>;
    nowMs: () => number;
    airQualityClient: NonNullable<TopRowWidgetRuntimeDeps["airQualityClient"]>;
    setView: (view: TopRowWidgetText) => void;
  },
): Promise<void> {
  const cacheKey = airQualityCacheKey(entry.config.city);
  const cached = runtime.cache.get(cacheKey);
  const fetchedAtMs = runtime.nowMs();
  if (
    cached !== undefined &&
    fetchedAtMs - cached.fetchedAtMs < airQualityRefreshIntervalMs(entry.config)
  ) {
    runtime.setView(renderAirQualitySuccess(entry.config, cached.conditions));
    return;
  }

  try {
    const conditions = await runtime.airQualityClient.getCurrentAirQuality(entry.config.city);
    if (runtime.cancelled()) {
      return;
    }
    runtime.cache.set(cacheKey, {
      conditions,
      fetchedAtMs: runtime.nowMs(),
    });
    runtime.setView(renderAirQualitySuccess(entry.config, conditions));
  } catch {
    if (!runtime.cancelled()) {
      runtime.setView(renderAirQualityError(entry.config));
    }
  }
}

function airQualityRefreshIntervalMs(config: TuiAqiWidgetConfig): number {
  return (config.refreshIntervalMinutes ?? DEFAULT_AIR_QUALITY_REFRESH_INTERVAL_MINUTES) * 60_000;
}

function weatherRefreshIntervalMs(config: TuiWeatherWidgetConfig): number {
  return (config.refreshIntervalMinutes ?? DEFAULT_WEATHER_REFRESH_INTERVAL_MINUTES) * 60_000;
}

function temperatureUnit(config: TuiWeatherWidgetConfig): WeatherTemperatureUnit {
  return config.temperatureUnit ?? "fahrenheit";
}

function weatherCacheKey(city: string, unit: WeatherTemperatureUnit): string {
  return `${city.trim().toLowerCase()}:${unit}`;
}

function airQualityCacheKey(city: string): string {
  return city.trim().toLowerCase();
}

function defaultNow(): Date {
  return new Date();
}
