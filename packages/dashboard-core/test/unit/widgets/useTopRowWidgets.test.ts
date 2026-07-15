import type { TuiWidgetConfig } from "@station/config";
import { describe, expect, it, vi } from "vitest";
import type {
  AirQualityClient,
  AirQualityCurrentConditions,
  WeatherClient,
  WeatherCurrentConditions,
} from "../../../src/widgets/types.js";
import {
  createUseTopRowWidgets,
  refreshAirQualityWidget,
  refreshWeatherWidget,
  type TopRowWidgetHookRuntime,
} from "../../../src/widgets/useTopRowWidgets.js";

const CONFIG = { type: "weather", city: "Austin", label: "ATX" } as const;
const ENTRY = { id: "weather:0", config: CONFIG };
const CONDITIONS: WeatherCurrentConditions = { temperature: 72, weatherCode: 0, isDay: true };
const AQI_CONFIG = { type: "aqi", city: "Austin", label: "ATX" } as const;
const AQI_ENTRY = { id: "aqi:0", config: AQI_CONFIG };
const AIR_QUALITY: AirQualityCurrentConditions = { aqi: 42 };

function client(impl: WeatherClient["getCurrentWeather"]): WeatherClient {
  return { getCurrentWeather: impl };
}

function airQualityClient(impl: AirQualityClient["getCurrentAirQuality"]): AirQualityClient {
  return { getCurrentAirQuality: impl };
}

describe("refreshWeatherWidget", () => {
  it("serves a fresh cache entry without calling the client", async () => {
    const cache = new Map([["austin:fahrenheit", { conditions: CONDITIONS, fetchedAtMs: 1_000 }]]);
    const getCurrentWeather = vi.fn();
    const texts: string[] = [];
    await refreshWeatherWidget(ENTRY, {
      cancelled: () => false,
      cache,
      nowMs: () => 1_000 + 60_000, // within the 15-minute default TTL
      weatherClient: client(getCurrentWeather),
      setText: (text) => texts.push(text),
    });
    expect(getCurrentWeather).not.toHaveBeenCalled();
    expect(texts).toEqual(["ATX · 72° ☀️"]);
  });

  it("refetches and re-caches once the entry is older than the refresh interval", async () => {
    const cache = new Map([["austin:fahrenheit", { conditions: CONDITIONS, fetchedAtMs: 0 }]]);
    const fresh: WeatherCurrentConditions = { temperature: 50, weatherCode: 3, isDay: false };
    const getCurrentWeather = vi.fn().mockResolvedValue(fresh);
    const texts: string[] = [];
    await refreshWeatherWidget(ENTRY, {
      cancelled: () => false,
      cache,
      nowMs: () => 16 * 60_000, // past the 15-minute default TTL
      weatherClient: client(getCurrentWeather),
      setText: (text) => texts.push(text),
    });
    expect(getCurrentWeather).toHaveBeenCalledTimes(1);
    expect(cache.get("austin:fahrenheit")?.conditions).toEqual(fresh);
    expect(texts.at(-1)).toBe("ATX · 50° ☁️");
  });

  it("renders the error glyph when the client rejects", async () => {
    const texts: string[] = [];
    await refreshWeatherWidget(ENTRY, {
      cancelled: () => false,
      cache: new Map(),
      nowMs: () => 0,
      weatherClient: client(() => Promise.reject(new Error("boom"))),
      setText: (text) => texts.push(text),
    });
    expect(texts).toEqual(["ATX · --° 🫥"]);
  });

  it("suppresses output when cancelled after the fetch resolves", async () => {
    const texts: string[] = [];
    await refreshWeatherWidget(ENTRY, {
      cancelled: () => true,
      cache: new Map(),
      nowMs: () => 0,
      weatherClient: client(() => Promise.resolve(CONDITIONS)),
      setText: (text) => texts.push(text),
    });
    expect(texts).toEqual([]);
  });
});

describe("refreshAirQualityWidget", () => {
  it("serves a fresh cache entry without calling the client", async () => {
    const cache = new Map([["austin", { conditions: AIR_QUALITY, fetchedAtMs: 1_000 }]]);
    const getCurrentAirQuality = vi.fn();
    const views: Array<{ text: string; compact?: string }> = [];

    await refreshAirQualityWidget(AQI_ENTRY, {
      cancelled: () => false,
      cache,
      nowMs: () => 30 * 60_000,
      airQualityClient: airQualityClient(getCurrentAirQuality),
      setView: (view) => views.push(view),
    });

    expect(getCurrentAirQuality).not.toHaveBeenCalled();
    expect(views).toEqual([{ text: "ATX · AQI 42 good 🟢", compact: "ATX AQI 42 🟢" }]);
  });

  it("refetches after the 60-minute default and caches the result", async () => {
    const getCurrentAirQuality = vi.fn().mockResolvedValue({ aqi: 90 });
    const cache = new Map([["austin", { conditions: AIR_QUALITY, fetchedAtMs: 0 }]]);
    const views: Array<{ text: string; compact?: string }> = [];

    await refreshAirQualityWidget(AQI_ENTRY, {
      cancelled: () => false,
      cache,
      nowMs: () => 61 * 60_000,
      airQualityClient: airQualityClient(getCurrentAirQuality),
      setView: (view) => views.push(view),
    });

    expect(getCurrentAirQuality).toHaveBeenCalledWith("Austin");
    expect(cache.get("austin")?.conditions).toEqual({ aqi: 90 });
    expect(views.at(-1)).toEqual({
      text: "ATX · AQI 90 moderate 🟡",
      compact: "ATX AQI 90 🟡",
    });
  });

  it("renders a local error and suppresses output after cancellation", async () => {
    const errors: Array<{ text: string }> = [];
    await refreshAirQualityWidget(AQI_ENTRY, {
      cancelled: () => false,
      cache: new Map(),
      nowMs: () => 0,
      airQualityClient: airQualityClient(() => Promise.reject(new Error("boom"))),
      setView: (view) => errors.push(view),
    });
    expect(errors).toEqual([{ text: "ATX · AQI -- 🫥", compact: "ATX AQI -- 🫥" }]);

    const cancelled: Array<{ text: string }> = [];
    await refreshAirQualityWidget(AQI_ENTRY, {
      cancelled: () => true,
      cache: new Map(),
      nowMs: () => 0,
      airQualityClient: airQualityClient(() => Promise.resolve(AIR_QUALITY)),
      setView: (view) => cancelled.push(view),
    });
    expect(cancelled).toEqual([]);
  });
});

// One synchronous render: state stays initial, effects never run — enough to
// assert the pure config → view mapping.
function renderOnce(widgets: readonly TuiWidgetConfig[], now: () => Date) {
  const hooks: TopRowWidgetHookRuntime = {
    useCallback: (callback) => callback,
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initialValue) => ({ current: initialValue }),
    useState: (initialValue) => [
      typeof initialValue === "function" ? (initialValue as () => never)() : initialValue,
      () => {},
    ],
  };
  return createUseTopRowWidgets(hooks)(widgets, { now });
}

describe("useTopRowWidgets config mapping", () => {
  const noon = () => new Date(Date.UTC(2026, 5, 12, 12, 0));

  it("drops disabled widgets while ids keep the config index", () => {
    const views = renderOnce(
      [{ type: "time" }, { type: "time", enabled: false }, { type: "moon" }],
      noon,
    );
    expect(views.map((view) => view.id)).toEqual(["time:0", "moon:2"]);
  });

  it("emits snapshot placeholders for fleet and prs widgets", () => {
    const views = renderOnce([{ type: "fleet" }, { type: "prs" }], noon);
    expect(views).toEqual([
      { id: "fleet:0", text: "", data: "fleet" },
      { id: "prs:1", text: "", data: "prs" },
    ]);
  });

  it("keeps an AQI widget in configured order with its loading view", () => {
    const views = renderOnce(
      [{ type: "time" }, { type: "aqi", city: "Austin", label: "ATX" }, { type: "moon" }],
      noon,
    );
    expect(views[1]).toEqual({
      id: "aqi:1",
      text: "ATX · AQI -- ⏳",
      compact: "ATX AQI -- ⏳",
    });
  });

  it("renders tz pairs and the moon phase from the shared clock", () => {
    const views = renderOnce(
      [
        {
          type: "tz",
          zones: [{ label: "NYC", timeZone: "America/New_York" }],
          timeFormat: "24h",
        },
        { type: "moon" },
      ],
      noon,
    );
    expect(views[0]?.text).toBe("NYC 08:00");
    expect(views[1]?.compact).toBe(views[1]?.text.split(" ")[0]);
  });
});
