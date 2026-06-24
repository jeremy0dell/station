import type { TuiWeatherWidgetConfig, TuiWidgetConfig } from "@station/config";
import { formatTimeWidget, millisecondsUntilNextMinute } from "./time.js";
import type {
  TopRowWidgetRuntimeDeps,
  TopRowWidgetView,
  WeatherCurrentConditions,
  WeatherTemperatureUnit,
} from "./types.js";
import { renderWeatherError, renderWeatherLoading, renderWeatherSuccess } from "./weather.js";
import { defaultWeatherClient } from "./weatherClient.js";

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

const DEFAULT_REFRESH_INTERVAL_MINUTES = 15;

// Hooks are injected rather than imported so dashboard-core stays React-free
// (no react dependency); each consuming app wires in its own React.
export function createUseTopRowWidgets(hooks: TopRowWidgetHookRuntime) {
  return function useTopRowWidgets(
    widgets: readonly TuiWidgetConfig[],
    deps: TopRowWidgetRuntimeDeps = {},
  ): TopRowWidgetView[] {
    const now = deps.now ?? defaultNow;
    const [currentMinute, setCurrentMinute] = hooks.useState(() => now());
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

    const hasTimeWidget = widgets.some((widget) => widget.type === "time");
    const weatherEntries = hooks.useMemo(
      () =>
        widgets.flatMap((widget, index): WeatherWidgetEntry[] =>
          widget.type === "weather" ? [{ id: `weather:${index}`, config: widget }] : [],
        ),
      [widgets],
    );

    hooks.useEffect(() => {
      if (!hasTimeWidget) {
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
    }, [hasTimeWidget, now]);

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
        }, refreshIntervalMs(entry.config));
        intervals.push(interval);
      }

      return () => {
        cancelled = true;
        for (const interval of intervals) {
          clearInterval(interval);
        }
      };
    }, [weatherEntries, weatherClient, now, setWeatherText]);

    return hooks.useMemo(
      () =>
        widgets.map((widget, index): TopRowWidgetView => {
          switch (widget.type) {
            case "time":
              return {
                id: `time:${index}`,
                text: formatTimeWidget(currentMinute, widget),
              };
            case "weather": {
              const id = `weather:${index}`;
              return {
                id,
                text: weatherTexts[id] ?? renderWeatherLoading(widget),
              };
            }
          }
          const exhaustive: never = widget;
          return exhaustive;
        }),
      [currentMinute, weatherTexts, widgets],
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
  if (cached !== undefined && fetchedAtMs - cached.fetchedAtMs < refreshIntervalMs(entry.config)) {
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

function refreshIntervalMs(config: TuiWeatherWidgetConfig): number {
  return (config.refreshIntervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES) * 60_000;
}

function temperatureUnit(config: TuiWeatherWidgetConfig): WeatherTemperatureUnit {
  return config.temperatureUnit ?? "fahrenheit";
}

function weatherCacheKey(city: string, unit: WeatherTemperatureUnit): string {
  return `${city.trim().toLowerCase()}:${unit}`;
}

function defaultNow(): Date {
  return new Date();
}
