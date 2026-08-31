import { createStationHostClient, type StationHostClient } from "@station/host";
import { stationBuildInfo } from "@station/runtime";
import {
  type EnsureStationHostDeps,
  type EnsureStationHostOptions,
  ensureStationHostRunning,
  type StationHostHandle,
} from "./ensureHostRunning.js";
import { adoptParkedOrphanManifest, loadParkedOrphanManifest } from "./orphanRecovery.js";

/**
 * Holds the single long-lived host client the provider reuses for both the
 * control plane (spawn/focus/close/list) and `ensureStationHostRunning`. One
 * client = one multiplexed connection that reconnects lazily.
 */
export type StationHostController = {
  readonly socketPath: string;
  client(): StationHostClient;
  ensure(): Promise<StationHostHandle>;
  /** Reconstructs strictly validated parked ownership, or fails before replacement launch. */
  recoverOrphanedTargets(): Promise<boolean>;
};

export function createStationHostController(
  options: EnsureStationHostOptions,
  deps: EnsureStationHostDeps = {},
): StationHostController {
  const expectedBuildVersion = options.expectedBuildVersion ?? stationBuildInfo().version;
  const makeClient =
    deps.clientFactory ??
    ((socketPath: string, buildVersion: string) =>
      createStationHostClient({ socketPath, expectedBuildVersion: buildVersion }));
  const client = makeClient(options.socketPath, expectedBuildVersion);
  const ensure = () =>
    ensureStationHostRunning(
      { ...options, expectedBuildVersion },
      { ...deps, clientFactory: () => client },
    );
  return {
    socketPath: options.socketPath,
    client: () => client,
    ensure,
    recoverOrphanedTargets: async () => {
      const parked = await loadParkedOrphanManifest(options.stateDir);
      if (Object.keys(parked).length === 0) {
        return false;
      }
      const handle = await ensure();
      if (handle.status !== "running") {
        throw handle.error;
      }
      // Host startup reaps stale sockets before health, so rebuild from the remaining evidence.
      const adoptable = await loadParkedOrphanManifest(options.stateDir);
      if (Object.keys(adoptable).length === 0) {
        return false;
      }
      const ownedPtyIds = new Set((await handle.client.list()).map((entry) => entry.ptyId));
      const unowned = Object.fromEntries(
        Object.entries(adoptable).filter(([ptyId]) => !ownedPtyIds.has(ptyId)),
      );
      if (Object.keys(unowned).length === 0) {
        return true;
      }
      await adoptParkedOrphanManifest(handle.client, unowned);
      return true;
    },
  };
}
