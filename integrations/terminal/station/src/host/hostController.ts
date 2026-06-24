import { createStationHostClient, type StationHostClient } from "@station/host";
import {
  type EnsureStationHostDeps,
  type EnsureStationHostOptions,
  ensureStationHostRunning,
  type StationHostHandle,
} from "./ensureHostRunning.js";

/**
 * Holds the single long-lived host client the provider reuses for both the
 * control plane (spawn/focus/close/list) and `ensureStationHostRunning`. One
 * client = one multiplexed connection that reconnects lazily.
 */
export type StationHostController = {
  readonly socketPath: string;
  client(): StationHostClient;
  ensure(): Promise<StationHostHandle>;
};

export function createStationHostController(
  options: EnsureStationHostOptions,
  deps: EnsureStationHostDeps = {},
): StationHostController {
  const makeClient =
    deps.clientFactory ?? ((socketPath: string) => createStationHostClient({ socketPath }));
  const client = makeClient(options.socketPath);
  return {
    socketPath: options.socketPath,
    client: () => client,
    ensure: () =>
      ensureStationHostRunning(options, {
        ...(deps.spawnHost === undefined ? {} : { spawnHost: deps.spawnHost }),
        clientFactory: () => client,
      }),
  };
}
