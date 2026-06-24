import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenMeteoWeatherClient } from "../../../src/widgets/weatherClient.js";

describe("OpenMeteoWeatherClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    ).rejects.toThrow("Weather location was not found.");
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}
