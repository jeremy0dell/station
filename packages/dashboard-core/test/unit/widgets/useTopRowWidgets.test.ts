import type { TuiWidgetConfig } from "@station/config";
import { describe, expect, it, vi } from "vitest";
import type { WeatherClient, WeatherCurrentConditions } from "../../../src/widgets/types.js";
import {
  createUseTopRowWidgets,
  refreshWeatherWidget,
  type TopRowWidgetHookRuntime,
} from "../../../src/widgets/useTopRowWidgets.js";

const CONFIG = { type: "weather", city: "Austin", label: "ATX" } as const;
const ENTRY = { id: "weather:0", config: CONFIG };
const CONDITIONS: WeatherCurrentConditions = { temperature: 72, weatherCode: 0, isDay: true };

function client(impl: WeatherClient["getCurrentWeather"]): WeatherClient {
  return { getCurrentWeather: impl };
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
    expect(texts).toEqual(["ATX 72° ☀️"]);
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
    expect(texts.at(-1)).toBe("ATX 50° ☁️");
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
    expect(texts).toEqual(["ATX --° 🫥"]);
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
