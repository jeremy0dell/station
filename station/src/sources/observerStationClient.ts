import {
  createObserverService,
  createStationClientRuntime,
  type ObserverService,
} from "@station/client";
import { isNeedsAttentionEvent, type StationAttentionEvent } from "./attentionEvents.js";
import type { StationClient } from "./types.js";

export type CreateObserverStationClientOptions = {
  socketPath?: string;
  /** Exact Observer selector accepted by the CLI before launching Station. */
  expectedBuildVersion?: string;
  /** Test seam: inject a fake observer service instead of a socket. */
  service?: ObserverService;
  onAttentionNeeded?: (event: StationAttentionEvent) => void;
};

/**
 * COMPOSITION ROOT
 *
 * One runtime owns canonical snapshot/connection state and the service used by
 * command operations, so loaded snapshots become the next event's reducer base.
 */
export function createObserverStationClient(
  options: CreateObserverStationClientOptions,
): StationClient {
  const service =
    options.service ??
    createObserverService({
      socketPath: requireSocketPath(options.socketPath),
      ...(options.expectedBuildVersion === undefined
        ? {}
        : { expectedBuildVersion: options.expectedBuildVersion }),
      clientLabel: "Station",
    });
  const runtime = createStationClientRuntime({
    service,
    clientLabel: "Station",
    hooks: {
      onEvent: (event) => {
        if (!isNeedsAttentionEvent(event)) {
          return;
        }
        try {
          options.onAttentionNeeded?.(event);
        } catch {
          // Notification failures must not tear down the observer subscription.
        }
      },
    },
  });

  return {
    state: runtime,
    service: runtime.service,
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
