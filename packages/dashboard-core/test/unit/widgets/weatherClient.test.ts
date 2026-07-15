import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenMeteoAirQualityClient,
  OpenMeteoWeatherClient,
} from "../../../src/widgets/weatherClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenMeteoWeatherClient", () => {
  it("geocodes a city and returns current weather", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          generationtime_ms: 1,
          results: [
            {
              id: 5128581,
              name: "New York",
              latitude: 40.71427,
              longitude: -74.00597,
              elevation: 10,
              feature_code: "PPLA2",
              country_code: "US",
              admin1_id: 5128638,
              admin2_id: 5128594,
              timezone: "America/New_York",
              population: 8804190,
              postcodes: ["10001"],
              country_id: 6252001,
              country: "United States",
              admin1: "New York",
              admin2: "New York County",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          current: {
            temperature_2m: 72.4,
            weather_code: 0,
            is_day: 1,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OpenMeteoWeatherClient().getCurrentWeather("New York, NY", "fahrenheit"),
    ).resolves.toEqual({
      temperature: 72.4,
      weatherCode: 0,
      isDay: true,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("name=New+York%2C+NY");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("temperature_unit=fahrenheit");
  });

  it("falls back to a comma-stripped geocoding query", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ generationtime_ms: 1 }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ latitude: 40.7128, longitude: -74.006 }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          current: {
            temperature_2m: 74.6,
            weather_code: 3,
            is_day: 1,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OpenMeteoWeatherClient().getCurrentWeather("New York, NY", "fahrenheit"),
    ).resolves.toEqual({
      temperature: 74.6,
      weatherCode: 3,
      isDay: true,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("name=New+York%2C+NY");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("name=New+York");
  });

  it("rejects when geocoding has no match", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ results: [] })));

    await expect(
      new OpenMeteoWeatherClient().getCurrentWeather("ZZZ", "fahrenheit"),
    ).rejects.toThrow("Location was not found.");
  });

  it("rejects invalid forecast JSON at the schema boundary", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ results: [{ latitude: 40.7128, longitude: -74.006 }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          current: {
            temperature_2m: "72",
            weather_code: 0,
            is_day: 1,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OpenMeteoWeatherClient().getCurrentWeather("New York, NY", "fahrenheit"),
    ).rejects.toThrow();
  });

  it("tolerates unknown additive fields from the API", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ latitude: 40.7128, longitude: -74.006, brand_new_field: 1 }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          another_new_top_level: true,
          current: { temperature_2m: 60, weather_code: 0, is_day: 0, future_field: "x" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OpenMeteoWeatherClient().getCurrentWeather("New York", "celsius"),
    ).resolves.toEqual({ temperature: 60, weatherCode: 0, isDay: false });
  });
});

describe("OpenMeteoAirQualityClient", () => {
  it("returns the current U.S. AQI for a geocoded city", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ latitude: 34.0522, longitude: -118.2437 }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          current: { time: "2026-07-15T14:00", interval: 3600, us_aqi: 90 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OpenMeteoAirQualityClient().getCurrentAirQuality("Los Angeles, CA"),
    ).resolves.toEqual({ aqi: 90 });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("current=us_aqi");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("latitude=34.0522");
  });

  it.each([
    "90",
    90.5,
  ])("rejects malformed air-quality JSON at the schema boundary: %p", async (usAqi) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ latitude: 34.0522, longitude: -118.2437 }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ current: { us_aqi: usAqi } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OpenMeteoAirQualityClient().getCurrentAirQuality("Los Angeles, CA"),
    ).rejects.toThrow();
  });

  it("rejects AQI requests when geocoding has no match", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ results: [] })));

    await expect(new OpenMeteoAirQualityClient().getCurrentAirQuality("ZZZ")).rejects.toThrow(
      "Location was not found.",
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}
