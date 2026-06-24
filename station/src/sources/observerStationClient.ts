import {
  createObserverService,
  createStationClientRuntime,
  type ObserverService,
} from "@station/client";
import { bridgeOperationService } from "@station/dashboard-core";
import type { StationClient } from "./types.js";

export type CreateObserverStationClientOptions = {
  socketPath?: string;
  /** Test seam: inject a fake observer service instead of a socket. */
  service?: ObserverService;
};

/**
 * One shared ObserverService feeds runtime state and command dispatch. Snapshot
 * and reconcile operations must go through the runtime-backed bridge, or the
 * next incremental event can overwrite the side-loaded state.
 */
export function createObserverStationClient(
  options: CreateObserverStationClientOptions,
): StationClient {
  const service =
    options.service ??
    createObserverService({
      socketPath: requireSocketPath(options.socketPath),
      clientLabel: "Station",
    });
  const runtime = createStationClientRuntime({ service, clientLabel: "Station" });

  return {
    state: {
      getState: () => runtime.getState(),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    service: bridgeOperationService(service, runtime),
    start: () => {
      runtime.start();
    },
    stop: () => runtime.stop(),
  };
}

function requireSocketPath(socketPath: string | undefined): string {
  if (socketPath === undefined || socketPath.length === 0) {
    throw new Error("createObserverStationClient requires socketPath or service.");
  }
  return socketPath;
}
