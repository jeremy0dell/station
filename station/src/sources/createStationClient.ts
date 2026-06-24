import { createMockStationClient } from "./mockStationClient.js";
import { createObserverStationClient } from "./observerStationClient.js";
import { resolveStationObserverSocketPath } from "./stationSocketPath.js";
import type { StationClient } from "./types.js";
import {
  STATION_SCENARIO_NAMES,
  type StationScenarioName,
} from "../station/fixtures/scenarios.js";

declare const Bun: {
  env: Record<string, string | undefined>;
};

type StationSourceName = "observer" | "mock";

// The only place that decides whether Station shows live or mock STATION state.
// Downstream code receives one identity-free client boundary either way.
export function createStationClient(
  env: Record<string, string | undefined> = Bun.env,
): StationClient {
  const source = readSourceName(env.STATION_SOURCE);

  if (source === "mock") {
    return createMockStationClient(readScenarioName(env.STATION_SCENARIO));
  }

  return createObserverStationClient({
    socketPath: resolveStationObserverSocketPath(env),
  });
}

function readSourceName(value: string | undefined): StationSourceName {
  if (value === undefined || value === "" || value === "observer") {
    return "observer";
  }

  if (value === "mock") {
    return "mock";
  }

  throw new Error(`Unsupported STATION_SOURCE=${value}. Expected "observer" or "mock".`);
}

function readScenarioName(value: string | undefined): StationScenarioName {
  if (value === undefined || value === "") {
    return "baseline";
  }
  if ((STATION_SCENARIO_NAMES as readonly string[]).includes(value)) {
    return value as StationScenarioName;
  }
  throw new Error(
    `Unsupported STATION_SCENARIO=${value}. Expected one of: ${STATION_SCENARIO_NAMES.join(", ")}.`,
  );
}
