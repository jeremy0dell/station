import { describe, expect, it, vi } from "vitest";
import type { WeatherClient, WeatherCurrentConditions } from "../../../src/widgets/types.js";
import { refreshWeatherWidget } from "../../../src/widgets/useTopRowWidgets.js";

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
