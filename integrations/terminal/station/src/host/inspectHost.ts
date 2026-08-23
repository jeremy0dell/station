import type { SafeError } from "@station/contracts";
import {
  classifyHostCompatibility,
  createStationHostClient,
  type HostCompatibility,
  type HostHealthResult,
  type HostListEntry,
  type HostPtyHandoffSupport,
  isStationHostCompatibilityError,
  type StationHostClient,
  stationHostErrorFromUnknown,
  stationHostSafeError,
} from "@station/host";
import { probeUnixSocket } from "@station/protocol";
import { isSafeError } from "@station/runtime";

export type StationHostInspection = {
  socketPath: string;
  probe: "absent" | "stale" | "inaccessible" | "listening";
  health?: HostHealthResult;
  compatibility?: HostCompatibility;
  buildIdentity?: string;
  ptys?: StationHostInspectionEntry[];
  error?: SafeError;
};

export type StationHostInspectionEntry = HostListEntry & {
  handoffSupport?: HostPtyHandoffSupport;
};

export type InspectStationHostOptions = {
  socketPath: string;
  expectedBuildVersion: string;
  expectedBuildIdentity?: string;
};

export type InspectStationHostDeps = {
  clientFactory?: (socketPath: string, expectedBuildVersion: string) => StationHostClient;
};

/**
 * ADAPTER
 *
 * Reads one typed Host health and immutable inventory view for status and update inspection without
 * routing through CLI presentation.
 */
export async function inspectStationHost(
  options: InspectStationHostOptions,
  deps: InspectStationHostDeps = {},
): Promise<StationHostInspection> {
  const probe = await probeUnixSocket(options.socketPath);
  const result: StationHostInspection = {
    socketPath: options.socketPath,
    probe: probe.status,
  };
  if (probe.status !== "listening") {
    result.error = stationHostSafeError("HOST_UNREACHABLE", "Host socket is not listening.");
    return result;
  }

  const clientFactory =
    deps.clientFactory ??
    ((socketPath, expectedBuildVersion) =>
      createStationHostClient({ socketPath, expectedBuildVersion }));
  const client = clientFactory(options.socketPath, options.expectedBuildVersion);
  try {
    const health = await client.health();
    result.health = health;
    let compatibility = classifyHostCompatibility(health, options.expectedBuildVersion);
    const inventoryClient =
      compatibility.action === "replace"
        ? clientFactory(options.socketPath, compatibility.runningBuildVersion)
        : client;
    try {
      let ptys: StationHostInspectionEntry[];
      if (inventoryClient.recoveryInventory === undefined) {
        ptys = await inventoryClient.list();
      } else {
        try {
          const recovery = await inventoryClient.recoveryInventory();
          result.buildIdentity = recovery.buildIdentity;
          if (compatibility.action === "reuse" && options.expectedBuildIdentity !== undefined) {
            compatibility =
              recovery.buildIdentity === options.expectedBuildIdentity
                ? compatibility
                : { action: "replace", runningBuildVersion: options.expectedBuildVersion };
          }
          ptys = recovery.ptys;
        } catch (error) {
          if (!isSafeError(error) || error.code !== "HOST_BAD_REQUEST") throw error;
          // Protocol-v8 Hosts may predate the additive recovery-inventory query.
          ptys = await inventoryClient.list();
        }
      }
      result.ptys = ptys;
      if (
        compatibility.action === "reuse" &&
        options.expectedBuildIdentity !== undefined &&
        result.buildIdentity === undefined
      ) {
        compatibility = { action: "refuse", reason: "legacy-health" };
      }
      result.compatibility = compatibility;
    } catch (error) {
      result.compatibility = compatibility;
      result.error = hostInspectionError(
        error,
        "Station Host terminal inventory could not be read.",
      );
    } finally {
      if (inventoryClient !== client) inventoryClient.dispose();
    }
    return result;
  } catch (error) {
    result.error = hostInspectionError(error, "Station Host health could not be read.");
    return result;
  } finally {
    client.dispose();
  }
}

function hostInspectionError(error: unknown, message: string): SafeError {
  if (isStationHostCompatibilityError(error)) return error;
  return stationHostErrorFromUnknown(error, {
    code: "HOST_UNREACHABLE",
    message,
  });
}
