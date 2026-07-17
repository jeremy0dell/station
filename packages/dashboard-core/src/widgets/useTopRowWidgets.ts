import type { TuiWidgetConfig } from "@station/config";
import type { TopRowWidgetText } from "../components/Dashboard/content.js";
import {
  renderAirQualityError,
  renderAirQualityLoading,
  renderAirQualitySuccess,
} from "./airQuality.js";
import { formatMoonWidget } from "./moon.js";
import { formatTimeWidget, millisecondsUntilNextMinute } from "./time.js";
import { formatTimezoneWidget } from "./timezone.js";
import type { TopRowWidgetRuntimeDeps, TopRowWidgetView } from "./types.js";
import { renderWeatherError, renderWeatherLoading, renderWeatherSuccess } from "./weather.js";
import { defaultAirQualityClient, defaultWeatherClient } from "./weatherClient.js";

type SetStateAction<T> = T | ((previous: T) => T);

export type TopRowWidgetHookRuntime = {
  useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T;
  useEffect(effect: () => undefined | (() => void), deps: readonly unknown[]): void;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useRef<T>(initialValue: T): { current: T };
  useState<T>(initialValue: T | (() => T)): [T, (action: SetStateAction<T>) => void];
};

type PolledWidgetEntry = {
  id: string;
  cacheKey: string;
  refreshIntervalMs: number;
  loading: TopRowWidgetText;
  error: TopRowWidgetText;
  load: () => Promise<TopRowWidgetText>;
};

type PolledWidgetCacheEntry = {
  view: TopRowWidgetText;
  fetchedAtMs: number;
};

type PolledWidgetClients = {
  airQualityClient: NonNullable<TopRowWidgetRuntimeDeps["airQualityClient"]>;
  weatherClient: NonNullable<TopRowWidgetRuntimeDeps["weatherClient"]>;
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
    const weatherClient = deps.weatherClient ?? defaultWeatherClient;
    const polledWidgetCache = hooks.useRef(new Map<string, PolledWidgetCacheEntry>());
    const [polledWidgetViews, setPolledWidgetViews] = hooks.useState<
      Record<string, TopRowWidgetText>
    >({});
    const setPolledWidgetView = hooks.useCallback((id: string, view: TopRowWidgetText) => {
      setPolledWidgetViews((previous) => {
        const current = previous[id];
        if (
          current?.text === view.text &&
          current.compact === view.compact &&
          current.attribution?.label === view.attribution?.label &&
          current.attribution?.url === view.attribution?.url
        ) {
          return previous;
        }
        return {
          ...previous,
          [id]: view,
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
    const polledWidgetEntries = hooks.useMemo(() => {
      const entries: PolledWidgetEntry[] = [];
      for (const { widget, index } of activeWidgets) {
        const entry = createPolledWidgetEntry(widget, index, {
          airQualityClient,
          weatherClient,
        });
        if (entry !== undefined) {
          entries.push(entry);
        }
      }
      return entries;
    }, [activeWidgets, airQualityClient, weatherClient]);

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
      if (polledWidgetEntries.length === 0) {
        setPolledWidgetViews({});
        return;
      }

      let cancelled = false;
      const intervals: Array<ReturnType<typeof setInterval>> = [];

      setPolledWidgetViews((previous) => {
        const next: Record<string, TopRowWidgetText> = {};
        for (const entry of polledWidgetEntries) {
          next[entry.id] = previous[entry.id] ?? entry.loading;
        }
        return next;
      });

      for (const entry of polledWidgetEntries) {
        const refresh = () => {
          void refreshPolledWidget(entry, {
            cancelled: () => cancelled,
            cache: polledWidgetCache.current,
            nowMs: () => now().getTime(),
            setView: setPolledWidgetView,
          });
        };
        refresh();
        intervals.push(setInterval(refresh, entry.refreshIntervalMs));
      }

      return () => {
        cancelled = true;
        for (const interval of intervals) {
          clearInterval(interval);
        }
      };
    }, [now, polledWidgetEntries, setPolledWidgetView]);

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
              return {
                id,
                ...(polledWidgetViews[id] ?? { text: renderWeatherLoading(widget) }),
              };
            }
            case "aqi": {
              const id = `aqi:${index}`;
              return {
                id,
                ...(polledWidgetViews[id] ?? renderAirQualityLoading(widget)),
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
      [activeWidgets, currentMinute, polledWidgetViews],
    );
  };
}

function createPolledWidgetEntry(
  widget: TuiWidgetConfig,
  index: number,
  clients: PolledWidgetClients,
): PolledWidgetEntry | undefined {
  switch (widget.type) {
    case "weather": {
      const unit = widget.temperatureUnit ?? "fahrenheit";
      return {
        id: `weather:${index}`,
        cacheKey: JSON.stringify([
          "weather",
          widget.city.trim().toLowerCase(),
          unit,
          widget.label ?? null,
        ]),
        refreshIntervalMs:
          (widget.refreshIntervalMinutes ?? DEFAULT_WEATHER_REFRESH_INTERVAL_MINUTES) * 60_000,
        loading: { text: renderWeatherLoading(widget) },
        error: { text: renderWeatherError(widget) },
        load: async () => {
          const conditions = await clients.weatherClient.getCurrentWeather(widget.city, unit);
          return { text: renderWeatherSuccess(widget, conditions) };
        },
      };
    }
    case "aqi":
      return {
        id: `aqi:${index}`,
        cacheKey: JSON.stringify(["aqi", widget.city.trim().toLowerCase(), widget.label ?? null]),
        refreshIntervalMs:
          (widget.refreshIntervalMinutes ?? DEFAULT_AIR_QUALITY_REFRESH_INTERVAL_MINUTES) * 60_000,
        loading: renderAirQualityLoading(widget),
        error: renderAirQualityError(widget),
        load: async () => {
          const conditions = await clients.airQualityClient.getCurrentAirQuality(widget.city);
          return renderAirQualitySuccess(widget, conditions);
        },
      };
    default:
      return undefined;
  }
}

export async function refreshPolledWidget(
  entry: PolledWidgetEntry,
  runtime: {
    cancelled: () => boolean;
    cache: Map<string, PolledWidgetCacheEntry>;
    nowMs: () => number;
    setView: (id: string, view: TopRowWidgetText) => void;
  },
): Promise<void> {
  const cached = runtime.cache.get(entry.cacheKey);
  const checkedAtMs = runtime.nowMs();
  if (cached !== undefined && checkedAtMs - cached.fetchedAtMs < entry.refreshIntervalMs) {
    runtime.setView(entry.id, cached.view);
    return;
  }

  try {
    const view = await entry.load();
    if (runtime.cancelled()) {
      return;
    }
    runtime.cache.set(entry.cacheKey, {
      view,
      fetchedAtMs: runtime.nowMs(),
    });
    runtime.setView(entry.id, view);
  } catch {
    if (!runtime.cancelled()) {
      runtime.setView(entry.id, entry.error);
    }
  }
}

function defaultNow(): Date {
  return new Date();
}
