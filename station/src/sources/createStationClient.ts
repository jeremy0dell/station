import type { SafeError } from "@station/contracts";
import { stationObserverBuildVersion } from "@station/runtime";
import { createMockStationClient } from "./mockStationClient.js";
import { createObserverStationClient } from "./observerStationClient.js";
import { resolveStationObserverSocketPath } from "./stationSocketPath.js";
import type { StationClient } from "./types.js";
import {
  STATION_SCENARIO_NAMES,
  type StationScenarioName,
} from "../station/fixtures/scenarios.js";
import type { StationAttentionEvent } from "./attentionEvents.js";

type StationSourceName = "observer" | "mock";

export type CreateStationClientOptions = {
  onAttentionNeeded?: (event: StationAttentionEvent) => void;
};

// The only place that decides whether Station shows live or mock STATION state.
// Downstream code receives one identity-free client boundary either way.
export function createStationClient(
  env: Record<string, string | undefined> = process.env,
  options: CreateStationClientOptions = {},
): StationClient {
  const source = readSourceName(env.STATION_SOURCE);

  if (source === "mock") {
    return createMockStationClient(readScenarioName(env.STATION_SCENARIO));
  }

  const localBuildVersion = stationObserverBuildVersion();
  const launchedClientBuildVersion = readObserverBuildVersion(env.STATION_CLIENT_BUILD_VERSION);
  const launchedObserverBuildVersion = readObserverBuildVersion(
    env.STATION_OBSERVER_BUILD_VERSION,
  );
  if (
    (launchedClientBuildVersion === undefined) !==
    (launchedObserverBuildVersion === undefined)
  ) {
    throw incompleteBuildContextError();
  }
  if (
    launchedClientBuildVersion !== undefined &&
    launchedClientBuildVersion !== localBuildVersion
  ) {
    throw sourceBuildChangedError(launchedClientBuildVersion, localBuildVersion);
  }
  const acceptedBuildVersion = launchedObserverBuildVersion ?? localBuildVersion;
  return createObserverStationClient({
    socketPath: resolveStationObserverSocketPath(env),
    expectedBuildVersionProvider: () => {
      let currentLocalBuildVersion: string;
      try {
        currentLocalBuildVersion = stationObserverBuildVersion();
      } catch {
        throw sourceBuildVerificationError(localBuildVersion, acceptedBuildVersion);
      }
      if (currentLocalBuildVersion !== localBuildVersion) {
        throw sourceBuildChangedError(localBuildVersion, currentLocalBuildVersion);
      }
      return acceptedBuildVersion;
    },
    ...(options.onAttentionNeeded === undefined
      ? {}
      : { onAttentionNeeded: options.onAttentionNeeded }),
  });
}

function sourceBuildVerificationError(
  launchedBuild: string,
  acceptedObserverBuild: string,
): SafeError {
  return {
    tag: "ProtocolError",
    code: "OBSERVER_BUILD_MISMATCH",
    message: `Station can no longer verify client build "${launchedBuild}" before using accepted Observer "${acceptedObserverBuild}".`,
    hint: "Run pnpm build, then close and relaunch Station before issuing more Observer operations.",
  };
}

function incompleteBuildContextError(): SafeError {
  return {
    tag: "ProtocolError",
    code: "OBSERVER_BUILD_MISMATCH",
    message: "Station received incomplete client and Observer build context from its launcher.",
    hint: "Close and relaunch Station from the current CLI before issuing Observer operations.",
  };
}

function sourceBuildChangedError(startedBuild: string, currentBuild: string): SafeError {
  return {
    tag: "ProtocolError",
    code: "OBSERVER_BUILD_MISMATCH",
    message: `Station source changed after launch: this client started as "${startedBuild}", but the checkout now identifies as "${currentBuild}".`,
    hint: "Run pnpm build, then close and relaunch Station before issuing more Observer operations.",
  };
}

function readObserverBuildVersion(value: string | undefined): string | undefined {
  const buildVersion = value?.trim();
  return buildVersion === "" ? undefined : buildVersion;
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
